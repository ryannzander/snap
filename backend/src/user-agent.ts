import { DurableObject } from 'cloudflare:workers';

import type { Channel, ChannelName } from './channel';
import { LinqChannel } from './channels/linq';
import { TraceChannel } from './channels/trace';
import { fail, ok, type DoResult } from './http';
import { isOptOut } from './optout';
import { issueToken, secureEquals } from './ids';
import { parseIso, startOfWeek } from './time';
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
