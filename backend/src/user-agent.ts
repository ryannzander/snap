import { DurableObject } from 'cloudflare:workers';

import {
  buildDays,
  countThisWeek,
  recentMessages,
  renderContext,
  summarizeContext,
  type AgentContext,
} from './agent/context';
import {
  findCoveringWorkout,
  guardCreate,
  guardMessages,
  guardRelease,
  guardReschedule,
  guardSlash,
} from './agent/guards';
import { DEFAULT_GRACE_MIN, SYSTEM_PROMPT, TOOLS } from './agent/tools';
import type { Brain, ToolCall } from './brain';
import { OpenAIBrain } from './brains/openai';
import { WorkersAIBrain, type AiBinding } from './brains/workers-ai';
import type { Channel, ChannelName } from './channel';
import { LinqChannel } from './channels/linq';
import { TraceChannel } from './channels/trace';
import { fail, ok, type DoResult } from './http';
import { isOptOut } from './optout';
import { issueToken, secureEquals } from './ids';
import { endOfLocalDay, parseIso, startOfWeek } from './time';
import type {
  Commitment,
  StateResponse,
  TraceEvent,
  TraceKind,
  WorkoutInput,
  WorkoutsResponse,
} from './types';

/**
 * One UserAgent per user. Holds that user's profile, workouts, commitments and
 * trace feed. Later steps hang the agent, the channel link and the stake off
 * the same object — its storage is the user's whole world.
 */

const KEY = {
  profile: 'profile',
  token: 'token',
  link: 'link',
  /** Deliberately has no colon: a `trace:` prefixed key would land inside the
   *  lexicographic range that getTrace() scans. */
  traceSeq: 'traceSeq',
  workout: (hkUuid: string) => `workout:${hkUuid}`,
  commitment: (id: string) => `commitment:${id}`,
  trace: (id: number) => `trace:${String(id).padStart(12, '0')}`,
} as const;

/** '~' sorts above every digit, so it caps the trace range scan. */
const TRACE_RANGE_END = 'trace:~';
const TRACE_PAGE_LIMIT = 200;

/** Durable Object storage takes at most 128 keys per batched get/put. */
const BATCH = 100;

/**
 * Backfilling a year of HealthKit history should not write a year of events
 * into the "Snap's brain" feed, so only recent workouts get traced.
 */
const TRACE_WORKOUT_WINDOW_MS = 24 * 60 * 60 * 1000;

interface Profile {
  userId: string;
  name: string;
  weeklyGoal: number;
  timezone: string;
  createdAt: string;
}

/** Which chat Snap talks to this user in. Populated in step 2 by `yo <code>`. */
interface Link {
  linkCode: string;
  linked: boolean;
  channel: ChannelName | null;
  chatId: string | null;
  /** Set by an inbound STOP. Nothing is ever sent again while true. */
  optedOut: boolean;
}

interface StoredWorkout extends WorkoutInput {
  firstSeenAt: string;
  updatedAt: string;
}

/** A commitment plus the bookkeeping the agent needs but the app never sees. */
interface StoredCommitment extends Commitment {
  createdAt: string;
  renegotiations: number;
}

interface PendingTrace {
  kind: TraceKind;
  summary: string;
  data?: unknown;
}

export interface InitializeInput {
  userId: string;
  name: string;
  weeklyGoal: number;
  timezone: string;
  linkCode: string;
}

export class UserAgent extends DurableObject<Env> {
  /**
   * The agent's clock. Everything time-dependent reads this rather than
   * Date.now() so POST /debug/timewarp (step 5) can move it for the demo.
   */
  private now(): number {
    return Date.now();
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  // --- lifecycle -----------------------------------------------------------

  async initialize(input: InitializeInput): Promise<DoResult<{ token: string }>> {
    const existing = await this.ctx.storage.get<Profile>(KEY.profile);
    if (existing) {
      return fail(409, 'already_onboarded', 'this user has already been onboarded');
    }

    const token = issueToken(input.userId);
    const profile: Profile = {
      userId: input.userId,
      name: input.name,
      weeklyGoal: input.weeklyGoal,
      timezone: input.timezone,
      createdAt: this.nowIso(),
    };
    const link: Link = {
      linkCode: input.linkCode,
      linked: false,
      channel: null,
      chatId: null,
      optedOut: false,
    };

    await this.ctx.storage.put({
      [KEY.profile]: profile,
      [KEY.token]: token,
      [KEY.link]: link,
    });

    return ok({ token });
  }

  // --- endpoints -----------------------------------------------------------

  async ingestWorkouts(
    token: string,
    incoming: WorkoutInput[],
  ): Promise<DoResult<WorkoutsResponse>> {
    const auth = await this.authenticate(token);
    if (!auth.ok) return auth;

    // Last write wins on a duplicate hkUuid within one request.
    const byUuid = new Map<string, WorkoutInput>();
    for (const workout of incoming) byUuid.set(workout.hkUuid, workout);
    const workouts = [...byUuid.values()];

    const seenAt = this.nowIso();
    const traceFloor = this.now() - TRACE_WORKOUT_WINDOW_MS;
    const traces: PendingTrace[] = [];

    for (let i = 0; i < workouts.length; i += BATCH) {
      const chunk = workouts.slice(i, i + BATCH);
      const previous = await this.ctx.storage.get<StoredWorkout>(
        chunk.map((workout) => KEY.workout(workout.hkUuid)),
      );

      const writes: Record<string, StoredWorkout> = {};
      for (const workout of chunk) {
        const key = KEY.workout(workout.hkUuid);
        const prior = previous.get(key);

        // Merge forwards only. The app resends freely, so a stale payload can
        // arrive after a fresher one; letting `end` go back to null would
        // un-finish a finished workout and fire the completion trace twice.
        const merged: StoredWorkout = {
          ...workout,
          end: workout.end ?? prior?.end ?? null,
          durationSec: Math.max(workout.durationSec, prior?.durationSec ?? 0),
          activeKcal: workout.activeKcal ?? prior?.activeKcal ?? null,
          firstSeenAt: prior?.firstSeenAt ?? seenAt,
          updatedAt: seenAt,
        };
        writes[key] = merged;

        const startedAt = parseIso(merged.start);
        const recent = startedAt !== null && startedAt >= traceFloor;
        if (!recent) continue;

        if (!prior) {
          traces.push({
            kind: 'workout_detected',
            summary: describeWorkout(merged),
            data: { hkUuid: merged.hkUuid },
          });
        } else if (!prior.end && merged.end) {
          traces.push({
            kind: 'workout_detected',
            summary: `${humanizeType(merged.type)} · done · ${minutes(merged.durationSec)} min`,
            data: { hkUuid: merged.hkUuid },
          });
        }
      }

      await this.ctx.storage.put(writes);
    }

    await this.appendTraces(traces);

    // Every workout in the request was stored, resends included — the app is
    // told to resend freely, so a resend must not look like a rejection.
    return ok({ accepted: workouts.length });
  }

  async getState(token: string): Promise<DoResult<StateResponse>> {
    const auth = await this.authenticate(token);
    if (!auth.ok) return auth;
    const profile = auth.value;

    const [link, workouts, commitments] = await Promise.all([
      this.ctx.storage.get<Link>(KEY.link),
      this.ctx.storage.list<StoredWorkout>({ prefix: 'workout:' }),
      this.ctx.storage.list<StoredCommitment>({ prefix: 'commitment:' }),
    ]);

    const weekStart = startOfWeek(this.now(), profile.timezone);
    let workoutsThisWeek = 0;
    for (const workout of workouts.values()) {
      const startedAt = parseIso(workout.start);
      if (startedAt !== null && startedAt >= weekStart) workoutsThisWeek++;
    }

    return ok({
      weeklyGoal: profile.weeklyGoal,
      workoutsThisWeek,
      linked: link?.linked ?? false,
      commitments: [...commitments.values()]
        .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
        .map(toWireCommitment),
    });
  }

  async getTrace(token: string, since: number): Promise<DoResult<{ events: TraceEvent[] }>> {
    const auth = await this.authenticate(token);
    if (!auth.ok) return auth;

    const events = await this.ctx.storage.list<TraceEvent>({
      start: KEY.trace(since + 1),
      end: TRACE_RANGE_END,
      limit: TRACE_PAGE_LIMIT,
    });

    return ok({ events: [...events.values()] });
  }

  // --- channel ------------------------------------------------------------

  /**
   * Binds a chat to this user. Called when `yo <code>` arrives on any channel.
   * Idempotent: texting the code twice re-links the same chat without a
   * second greeting.
   */
  async linkChat(channel: ChannelName, chatId: string): Promise<DoResult<{ greeted: boolean }>> {
    const link = await this.ctx.storage.get<Link>(KEY.link);
    if (!link) return fail(404, 'not_found', 'no such user');

    const alreadyHere = link.linked && link.channel === channel && link.chatId === chatId;
    await this.ctx.storage.put(KEY.link, {
      ...link,
      linked: true,
      channel,
      chatId,
    } satisfies Link);

    if (alreadyHere) return ok({ greeted: false });

    const profile = await this.ctx.storage.get<Profile>(KEY.profile);
    await this.sendTexts([`yo ${profile?.name?.toLowerCase() ?? 'bro'}`, 'im in. what are we doing today']);
    return ok({ greeted: true });
  }

  /** Records an inbound text. The agent acts on it in step 3. */
  async receiveMessage(text: string): Promise<DoResult<{ optedOut: boolean }>> {
    const link = await this.ctx.storage.get<Link>(KEY.link);
    if (!link) return fail(404, 'not_found', 'no such user');

    await this.appendTraces([{ kind: 'message_received', summary: text }]);

    const optedOut = isOptOut(text);
    // Linq clears an opt-out as soon as the recipient replies again with
    // anything that is not itself a keyword, so mirror that rather than
    // keeping our own permanent block — otherwise one STOP kills the user
    // forever even after they text back.
    if (optedOut !== link.optedOut) {
      await this.ctx.storage.put(KEY.link, { ...link, optedOut } satisfies Link);
    }
    return ok({ optedOut });
  }

  /**
   * Sends a burst of texts and traces each one. Every channel is traced the
   * same way, so the brain screen is identical whether or not delivery is real.
   */
  async sendTexts(texts: string[]): Promise<void> {
    if (texts.length === 0) return;

    const link = await this.ctx.storage.get<Link>(KEY.link);
    if (!link?.linked || !link.chatId || !link.channel) return;
    if (link.optedOut) return;

    await this.appendTraces(texts.map((text) => ({ kind: 'message_sent' as const, summary: text })));

    try {
      await this.channelFor(link.channel).send(link.chatId, texts);
    } catch (error) {
      // A send failure must not lose the trace or fail the caller's request;
      // the brain screen still shows what Snap decided to say.
      console.error('channel send failed', error);
    }
  }

  private channelFor(name: ChannelName): Channel {
    if (name === 'linq' && this.env.LINQ_API_KEY) return new LinqChannel(this.env.LINQ_API_KEY);
    return new TraceChannel();
  }

  // --- the agent ----------------------------------------------------------

  /**
   * One turn of the loop. Assembles context, asks the brain what to do, and
   * runs each proposed tool call through its guard before anything happens.
   * Every stage writes a trace event, including a refusal — the brain screen
   * is supposed to show the agent deciding *not* to act too.
   */
  async runAgent(instruction: string): Promise<DoResult<{ ran: boolean }>> {
    const profile = await this.ctx.storage.get<Profile>(KEY.profile);
    if (!profile) return fail(404, 'not_found', 'no such user');

    const brain = this.brain();
    if (!brain) {
      await this.appendTraces([
        { kind: 'decision', summary: 'no brain configured — set OPENAI_API_KEY or the AI binding' },
      ]);
      return ok({ ran: false });
    }

    const context = await this.buildContext(profile);
    await this.appendTraces([{ kind: 'context', summary: summarizeContext(context) }]);

    let decision;
    try {
      decision = await brain.decide({
        system: SYSTEM_PROMPT,
        context: renderContext(context),
        instruction,
        tools: TOOLS,
      });
    } catch (error) {
      // A dead model must not take the loop down. The trace says so plainly.
      await this.appendTraces([
        { kind: 'decision', summary: `brain unavailable (${brain.name})`, data: { error: String(error) } },
      ]);
      return ok({ ran: false });
    }

    const names = decision.toolCalls.map((call) => call.name);
    await this.appendTraces([
      {
        kind: 'decision',
        summary: decision.reasoning?.trim() || (names.length ? names.join(' + ') : 'no action'),
        data: { brain: brain.name, tools: names, reasoning: decision.reasoning },
      },
    ]);

    const executed: string[] = [];
    for (const call of decision.toolCalls) {
      if (await this.dispatch(call, profile)) executed.push(call.name);
    }

    // Some models emit one tool call per turn, so a commitment gets recorded
    // and the user hears nothing — which is the product failing silently.
    // Ask once more, with only the two talking tools available.
    if (!executed.includes('send_messages') && !executed.includes('stay_quiet')) {
      await this.followUp(brain, profile, instruction, executed);
    }

    return ok({ ran: true });
  }

  /** Second pass: you acted, now say something — or justify not saying it. */
  private async followUp(
    brain: Brain,
    profile: Profile,
    instruction: string,
    executed: string[],
  ): Promise<void> {
    const did = executed.length ? `you just called: ${executed.join(', ')}.` : 'you did nothing yet.';
    const talking = TOOLS.filter(
      (tool) => tool.function.name === 'send_messages' || tool.function.name === 'stay_quiet',
    );

    try {
      const context = await this.buildContext(profile);
      const decision = await brain.decide({
        system: SYSTEM_PROMPT,
        context: renderContext(context),
        instruction: `${instruction}\n\n${did} now text them about it, in your voice. if silence is genuinely right, call stay_quiet instead.`,
        tools: talking,
      });
      for (const call of decision.toolCalls) await this.dispatch(call, profile);
    } catch (error) {
      await this.appendTraces([
        { kind: 'decision', summary: 'could not reach the brain for a reply', data: { error: String(error) } },
      ]);
    }
  }

  /** Runs one proposed tool call, or records why it was refused. */
  private async dispatch(call: ToolCall, profile: Profile): Promise<boolean> {
    const now = this.now();
    const commitments = await this.loadCommitments();
    const open = commitments.filter((c) => c.status === 'pending' || c.status === 'renegotiated');

    // The arguments go in the trace too: a refusal you cannot see the input
    // for is a dead end when the model starts doing something new.
    const refuse = async (reason: string): Promise<boolean> => {
      await this.appendTraces([
        {
          kind: 'decision',
          summary: `refused ${call.name} — ${reason}`,
          data: { tool: call.name, reason, arguments: call.arguments },
        },
      ]);
      return false;
    };

    switch (call.name) {
      case 'create_commitment': {
        const guard = guardCreate(call.arguments, now, profile.timezone, open.map(toWireCommitment));
        if (!guard.ok) return refuse(guard.reason);

        const commitment: StoredCommitment = {
          id: `c_${crypto.randomUUID().slice(0, 8)}`,
          text: guard.value.text,
          dueAt: guard.value.dueAt,
          graceMin: DEFAULT_GRACE_MIN,
          status: 'pending',
          stake: { lamports: guard.value.lamports, status: 'held', txSig: null },
          createdAt: this.nowIso(),
          renegotiations: 0,
        };
        await this.ctx.storage.put(KEY.commitment(commitment.id), commitment);
        await this.appendTraces([
          {
            kind: 'commitment_created',
            summary: `${commitment.text} · ${solText(commitment.stake.lamports)} on it`,
            data: { id: commitment.id, dueAt: commitment.dueAt },
          },
          // No chain transaction until step 6, so txSig stays null.
          { kind: 'stake_held', summary: `${solText(commitment.stake.lamports)} locked`, data: { id: commitment.id } },
        ]);
        return true;
      }

      case 'reschedule_commitment': {
        const id = String(call.arguments.commitmentId ?? '');
        const existing = commitments.find((c) => c.id === id) ?? null;
        const guard = guardReschedule(
          call.arguments,
          existing,
          now,
          profile.timezone,
          this.endOfDayFor(existing, profile),
        );
        if (!guard.ok || !existing) return refuse(guard.ok ? 'no such commitment' : guard.reason);

        await this.ctx.storage.put(KEY.commitment(existing.id), {
          ...existing,
          dueAt: guard.value.dueAt,
          status: 'renegotiated',
          renegotiations: existing.renegotiations + 1,
        } satisfies StoredCommitment);
        await this.appendTraces([
          {
            kind: 'decision',
            summary: `rescheduled to ${guard.value.dueAt} — ${guard.value.reason}`,
            data: { id: existing.id },
          },
        ]);
        return true;
      }

      case 'send_messages': {
        const link = await this.ctx.storage.get<Link>(KEY.link);
        const guard = guardMessages(call.arguments, link?.linked ?? false, link?.optedOut ?? false);
        if (!guard.ok) return refuse(guard.reason);
        await this.sendTexts(guard.value);
        return true;
      }

      case 'stay_quiet': {
        const reason = typeof call.arguments.reason === 'string' ? call.arguments.reason : 'nothing to say';
        await this.appendTraces([{ kind: 'decision', summary: `stayed quiet — ${reason}` }]);
        return true;
      }

      case 'release_stake':
      case 'slash_stake': {
        const id = String(call.arguments.commitmentId ?? '');
        const existing = commitments.find((c) => c.id === id) ?? null;
        if (!existing) return refuse('no such commitment');

        const covering = findCoveringWorkout(
          await this.loadWorkouts(),
          parseIso(existing.createdAt) ?? 0,
          this.endOfDayFor(existing, profile),
        );

        if (call.name === 'release_stake') {
          const guard = guardRelease(toWireCommitment(existing), covering);
          if (!guard.ok) return refuse(guard.reason);
          await this.settle(existing, 'met', 'released');
          return true;
        }

        const guard = guardSlash(existing, now, this.endOfDayFor(existing, profile), covering);
        if (!guard.ok) return refuse(guard.reason);
        await this.settle(existing, 'missed', 'slashed');
        return true;
      }

      default:
        return refuse('unknown tool');
    }
  }

  private async settle(
    commitment: StoredCommitment,
    status: 'met' | 'missed',
    stake: 'released' | 'slashed',
  ): Promise<void> {
    await this.ctx.storage.put(KEY.commitment(commitment.id), {
      ...commitment,
      status,
      stake: { ...commitment.stake, status: stake },
    } satisfies StoredCommitment);
    await this.appendTraces([
      {
        kind: stake === 'released' ? 'stake_released' : 'stake_slashed',
        summary:
          stake === 'released'
            ? `${solText(commitment.stake.lamports)} back in your wallet`
            : `${solText(commitment.stake.lamports)} gone`,
        data: { id: commitment.id },
      },
    ]);
  }

  /**
   * When the money moves for this commitment: the renegotiated deadline if
   * there is one, otherwise end of the local day the commitment was for.
   */
  private endOfDayFor(commitment: StoredCommitment | null, profile: Profile): number {
    if (commitment?.status === 'renegotiated') {
      const dueAt = parseIso(commitment.dueAt);
      if (dueAt !== null) return dueAt;
    }
    const anchor = commitment ? (parseIso(commitment.dueAt) ?? this.now()) : this.now();
    return endOfLocalDay(anchor, profile.timezone);
  }

  private async buildContext(profile: Profile): Promise<AgentContext> {
    const [workouts, commitments, events] = await Promise.all([
      this.loadWorkouts(),
      this.loadCommitments(),
      this.ctx.storage.list<TraceEvent>({ start: KEY.trace(1), end: TRACE_RANGE_END }),
    ]);
    const now = this.now();

    return {
      now: this.nowIso(),
      localTime: localClock(now, profile.timezone),
      timezone: profile.timezone,
      name: profile.name,
      weeklyGoal: profile.weeklyGoal,
      workoutsThisWeek: countThisWeek(now, profile.timezone, workouts),
      lastSevenDays: buildDays(now, profile.timezone, workouts, commitments.map(toWireCommitment)),
      openCommitments: commitments
        .filter((c) => c.status === 'pending' || c.status === 'renegotiated')
        .map(toWireCommitment),
      recentMessages: recentMessages([...events.values()]),
    };
  }

  private async loadWorkouts(): Promise<StoredWorkout[]> {
    return [...(await this.ctx.storage.list<StoredWorkout>({ prefix: 'workout:' })).values()];
  }

  private async loadCommitments(): Promise<StoredCommitment[]> {
    return [...(await this.ctx.storage.list<StoredCommitment>({ prefix: 'commitment:' })).values()];
  }

  /**
   * OpenAI is the brain for the demo (DESIGN.md). Workers AI runs on the same
   * account with no third-party key, so it covers development and stands in if
   * OpenAI is unreachable mid-demo.
   */
  private brain(): Brain | null {
    if (this.env.OPENAI_API_KEY) {
      return new OpenAIBrain(this.env.OPENAI_API_KEY, this.env.OPENAI_MODEL || 'gpt-4o');
    }
    const ai = (this.env as unknown as { AI?: AiBinding }).AI;
    if (ai) return new WorkersAIBrain(ai, this.env.WORKERS_AI_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
    return null;
  }

  // --- internals -----------------------------------------------------------

  private async authenticate(token: string): Promise<DoResult<Profile>> {
    const [stored, profile] = await Promise.all([
      this.ctx.storage.get<string>(KEY.token),
      this.ctx.storage.get<Profile>(KEY.profile),
    ]);
    if (!stored || !profile || !secureEquals(stored, token)) {
      return fail(401, 'unauthorized', 'missing or invalid bearer token');
    }
    return ok(profile);
  }

  /** Appends events to the trace feed in one read and one write. */
  private async appendTraces(entries: PendingTrace[]): Promise<TraceEvent[]> {
    if (entries.length === 0) return [];

    let seq = (await this.ctx.storage.get<number>(KEY.traceSeq)) ?? 0;
    const ts = this.nowIso();
    const events: TraceEvent[] = [];
    const writes: Record<string, unknown> = {};

    for (const entry of entries) {
      seq++;
      const event: TraceEvent = { id: seq, ts, kind: entry.kind, summary: entry.summary };
      if (entry.data !== undefined) event.data = entry.data;
      events.push(event);
      writes[KEY.trace(seq)] = event;
    }
    writes[KEY.traceSeq] = seq;

    for (const keys of chunkEntries(writes, BATCH)) {
      await this.ctx.storage.put(keys);
    }
    return events;
  }
}

// --- helpers ---------------------------------------------------------------

/** Drops the fields the app never sees, so /state matches API.md exactly. */
function toWireCommitment(stored: StoredCommitment): Commitment {
  return {
    id: stored.id,
    text: stored.text,
    dueAt: stored.dueAt,
    graceMin: stored.graceMin,
    status: stored.status,
    // Projected field by field too: step 6 hangs Solana vault bookkeeping off
    // the stake record, and none of that belongs on the wire.
    stake: {
      lamports: stored.stake.lamports,
      status: stored.stake.status,
      txSig: stored.stake.txSig,
    },
  };
}

/** "traditionalStrengthTraining" → "traditional strength training" */
function humanizeType(type: string): string {
  return type.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
}

/** "Sat 19 Sep, 19:24" in the user's zone. */
function localClock(instant: number, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(instant));
}

function solText(lamports: number): string {
  return `${(lamports / 1_000_000_000).toFixed(2)} SOL`;
}

function minutes(durationSec: number): number {
  return Math.round(durationSec / 60);
}

/** Display-ready, in the telemetry voice the trace feed uses. */
function describeWorkout(workout: WorkoutInput): string {
  const type = humanizeType(workout.type);
  if (!workout.end) return `${type} · in progress`;
  const parts = [type, `${minutes(workout.durationSec)} min`];
  if (workout.activeKcal !== null) parts.push(`${Math.round(workout.activeKcal)} kcal`);
  return parts.join(' · ');
}

function* chunkEntries<T>(record: Record<string, T>, size: number): Generator<Record<string, T>> {
  const entries = Object.entries(record);
  for (let i = 0; i < entries.length; i += size) {
    yield Object.fromEntries(entries.slice(i, i + size)) as Record<string, T>;
  }
}
