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
  disqualification,
  findCoveringWorkout,
  guardCreate,
  guardMessages,
  guardRelease,
  guardReschedule,
  guardSlash,
  splitSlash,
} from './agent/guards';
import { DEFAULT_GRACE_MIN, SYSTEM_PROMPT, TOOLS } from './agent/tools';
import type { Brain, ToolCall } from './brain';
import { FallbackBrain } from './brains/fallback';
import { OpenAIBrain } from './brains/openai';
import { WorkersAIBrain, type AiBinding } from './brains/workers-ai';
import type { Channel, ChannelName } from './channel';
import { LinqChannel } from './channels/linq';
import { TraceChannel } from './channels/trace';
import { fail, ok, type DoResult } from './http';
import { isOptOut } from './optout';
import { solText } from './money';
import { redact } from './redact';
import type { Address } from '@solana/kit';
import {
  explorerUrl,
  getBalanceLamports,
  newSeed,
  rpcFor,
  transferSol,
  transferSolMany,
  walletFromSeed,
} from './solana/wallet';
import { issueToken, secureEquals } from './ids';
import { endOfLocalDay, localTimeToInstant, parseIso, startOfWeek } from './time';
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
  clockOffset: 'clockOffset',
  wallet: 'wallet',
  workout: (hkUuid: string) => `workout:${hkUuid}`,
  /** Sorts by fire time, so a range scan finds everything due. */
  alarm: (at: number, suffix: string) => `alarm:${String(at).padStart(14, '0')}:${suffix}`,
  commitment: (id: string) => `commitment:${id}`,
  trace: (id: number) => `trace:${String(id).padStart(12, '0')}`,
} as const;

/** '~' sorts above every digit, so it caps a range scan. */
const TRACE_RANGE_END = 'trace:~';
const ALARM_RANGE_START = 'alarm:';

/** Snap asks about the day at this hour, local, when nothing is committed. */
const MORNING_HOUR = 9;
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

/**
 * The user's devnet wallet. Custodial — the backend holds the key, and we say
 * so to the Solana judges. Only the 32-byte seed is stored; the keypair is
 * derived on demand.
 */
interface StoredWallet {
  seed: string;
  address: string;
  funded: boolean;
}

/** Enough to cover a 0.05 SOL stake and the fees around it. */
const USER_FUNDING_LAMPORTS = 100_000_000;

interface StoredWorkout extends WorkoutInput {
  firstSeenAt: string;
  updatedAt: string;
}

/** A commitment plus the bookkeeping the agent needs but the app never sees. */
interface StoredCommitment extends Commitment {
  createdAt: string;
  renegotiations: number;
}

/**
 * A Durable Object has exactly one alarm, but Snap needs several wake-ups
 * pending at once — a grace check, an end-of-day slash, tomorrow's check-in.
 * They are stored as keys sorted by fire time and the single alarm is always
 * armed for the earliest.
 */
type AlarmKind = 'grace' | 'end_of_day' | 'morning';

interface ScheduledAlarm {
  at: number;
  kind: AlarmKind;
  commitmentId?: string;
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
   * Date.now(), so POST /debug/timewarp can move this user into the future
   * without touching anyone else's.
   *
   * Cached in memory because now() is called all over and a storage read per
   * call would be absurd; loadClock() refreshes it when the object wakes.
   */
  private clockOffsetMs = 0;
  private clockLoaded = false;

  private now(): number {
    return Date.now() + this.clockOffsetMs;
  }

  private async loadClock(): Promise<void> {
    if (this.clockLoaded) return;
    this.clockOffsetMs = (await this.ctx.storage.get<number>(KEY.clockOffset)) ?? 0;
    this.clockLoaded = true;
  }

  /**
   * Moves this user's clock to `now`, or back to real time with null, then
   * fires whatever that made due. The 1:00 beat of the demo.
   */
  async timewarp(token: string, to: string | null): Promise<DoResult<{ now: string; fired: number }>> {
    await this.loadClock();
    const auth = await this.authenticate(token);
    if (!auth.ok) return auth;

    if (to === null) {
      this.clockOffsetMs = 0;
      this.clockLoaded = true;
      await this.ctx.storage.delete(KEY.clockOffset);
    } else {
      const target = parseIso(to);
      if (target === null) return fail(400, 'bad_request', 'now must be an ISO 8601 timestamp or null');
      this.clockOffsetMs = target - Date.now();
      this.clockLoaded = true;
      await this.ctx.storage.put(KEY.clockOffset, this.clockOffsetMs);
    }

    await this.appendTraces([
      {
        kind: 'alarm_fired',
        summary:
          to === null
            ? 'clock reset to real time'
            : `clock moved to ${clockOnly(this.now(), auth.value.timezone)}`,
        data: { timewarp: to },
      },
    ]);

    const fired = await this.fireDueAlarms();
    return ok({ now: this.nowIso(), fired });
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

    // The daily rhythm starts now: if tomorrow morning arrives with no plan,
    // Snap asks first. Same alarm mechanism as everything else.
    await this.scheduleMorning(profile, 0);

    // The wallet exists immediately; funding it takes a few seconds on devnet
    // and the app is waiting on this response, so it finishes in the
    // background. Linking has to happen before anyone can stake anyway.
    await this.userWallet();
    this.ctx.waitUntil(this.fundUserWallet());

    return ok({ token });
  }

  // --- endpoints -----------------------------------------------------------

  async ingestWorkouts(
    token: string,
    incoming: WorkoutInput[],
  ): Promise<DoResult<WorkoutsResponse>> {
    await this.loadClock();
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
          source: workout.source ?? prior?.source ?? null,
          // Sticky: once a sample is known to be hand-typed, a later resend
          // claiming otherwise must not turn it into a stake-releasing one.
          wasUserEntered: workout.wasUserEntered || (prior?.wasUserEntered ?? false),
          firstSeenAt: prior?.firstSeenAt ?? seenAt,
          updatedAt: seenAt,
        };
        writes[key] = merged;

        const startedAt = parseIso(merged.start);
        const recent = startedAt !== null && startedAt >= traceFloor;
        if (!recent) continue;

        if (!prior) {
          const why = disqualification(merged);
          traces.push({
            kind: 'workout_detected',
            summary: why
              ? `${humanizeType(merged.type)} · ${minutes(merged.durationSec)} min · ${why}`
              : describeWorkout(merged),
            data: {
              hkUuid: merged.hkUuid,
              wasUserEntered: merged.wasUserEntered,
              source: merged.source,
              disqualified: why,
            },
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

    // BACKEND_TASKS step 4: a workout that covers an open commitment closes
    // the loop — release the stake and hype them up. Backgrounded so POST
    // /workouts stays fast; the phone is waiting on this response.
    if (traces.length > 0) {
      const closing = await this.coveredCommitment(auth.value);
      if (closing) {
        this.ctx.waitUntil(
          this.runAgent(
            `a workout just showed up on their watch and it covers "${closing.text}". that is the commitment met — give them their ${solText(closing.stake.lamports)} back and hype them up.`,
          ) as unknown as Promise<unknown>,
        );
      }
    }

    // Every workout in the request was stored, resends included — the app is
    // told to resend freely, so a resend must not look like a rejection.
    return ok({ accepted: workouts.length });
  }

  async getState(token: string): Promise<DoResult<StateResponse>> {
    await this.loadClock();
    const auth = await this.authenticate(token);
    if (!auth.ok) return auth;
    const profile = auth.value;

    const [link, workouts, commitments] = await Promise.all([
      this.ctx.storage.get<Link>(KEY.link),
      this.ctx.storage.list<StoredWorkout>({ prefix: 'workout:' }),
      this.ctx.storage.list<StoredCommitment>({ prefix: 'commitment:' }),
    ]);

    // Same bar as releasing a stake, so the dots on the screen and the
    // agent's "2/4 this week" never disagree.
    const workoutsThisWeek = countThisWeek(
      this.now(),
      profile.timezone,
      [...workouts.values()],
    );

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
    await this.loadClock();
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
    await this.loadClock();
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
   * Demo only. Puts a message in front of the agent exactly as an inbound text
   * does, without the channel vendor in the path.
   *
   * The webhook backgrounds the turn because Linq retries anything slow. Here
   * there is nothing retrying, so this awaits it: a caller that gets the
   * decision back is what makes the loop measurable at all, and what lets a
   * debug button show a result rather than hoping.
   */
  async receiveDebugMessage(
    token: string,
    text: string,
  ): Promise<DoResult<{ optedOut: boolean; ran: boolean }>> {
    await this.loadClock();
    const auth = await this.authenticate(token);
    if (!auth.ok) return auth;

    const received = await this.receiveMessage(text);
    if (!received.ok) return received;
    if (received.value.optedOut) return ok({ optedOut: true, ran: false });

    const agent = await this.runAgent(`the user just texted you: "${text}". decide what to do.`);
    if (!agent.ok) return agent;
    return ok({ optedOut: false, ran: agent.value.ran });
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
      console.error('channel send failed', redact(String(error)));
    }
  }

  private channelFor(name: ChannelName): Channel {
    if (name === 'linq' && this.env.LINQ_API_KEY) return new LinqChannel(this.env.LINQ_API_KEY);
    return new TraceChannel();
  }

  /**
   * Plants the week of history the demo needs: 2 of 4 done, skipped
   * yesterday, one earlier excuse in the thread (API.md → POST /debug/seed).
   *
   * Clears prior workouts, commitments and trace first, so the demo can be
   * rehearsed from the same starting point as many times as needed. The chat
   * link and the token survive — re-linking between rehearsals would mean
   * re-texting the code every time.
   *
   * Seeded data, real reasoning. DESIGN.md says to admit that if asked.
   */
  async seed(token: string): Promise<DoResult<{ workouts: number; commitments: number }>> {
    await this.loadClock();
    const auth = await this.authenticate(token);
    if (!auth.ok) return auth;
    const profile = auth.value;

    for (const prefix of ['workout:', 'commitment:', 'trace:', ALARM_RANGE_START]) {
      const keys = await this.ctx.storage.list({ prefix });
      for (const key of keys.keys()) await this.ctx.storage.delete(key);
    }
    await this.ctx.storage.delete(KEY.traceSeq);
    await this.rearm();

    const now = this.now();
    const tz = profile.timezone;
    const weekStart = startOfWeek(now, tz);

    // Two sessions earlier in the week, skipping yesterday — that is the day
    // the story needs empty. Walk back until two days land inside this week.
    const workoutDays: number[] = [];
    for (let back = 2; back <= 6 && workoutDays.length < 2; back++) {
      const at = localTimeToInstant(now, tz, 18, 0, -back);
      if (at >= weekStart && at < now) workoutDays.push(at);
    }
    // Early in the week there are not two earlier days, so use this morning.
    while (workoutDays.length < 2) {
      const at = localTimeToInstant(now, tz, 7 + workoutDays.length, 0, 0);
      workoutDays.push(at < now ? at : now - 3600_000);
    }

    const seeded: Record<string, StoredWorkout> = {};
    const shapes = [
      { type: 'traditionalStrengthTraining', durationSec: 2700, activeKcal: 310 },
      { type: 'running', durationSec: 1800, activeKcal: 260 },
    ];
    workoutDays.forEach((at, index) => {
      const shape = shapes[index % shapes.length]!;
      const hkUuid = `SEED-${index}-${new Date(at).toISOString().slice(0, 10)}`;
      seeded[KEY.workout(hkUuid)] = {
        hkUuid,
        type: shape.type,
        start: new Date(at).toISOString(),
        end: new Date(at + shape.durationSec * 1000).toISOString(),
        durationSec: shape.durationSec,
        activeKcal: shape.activeKcal,
        // Seeded history stands in for a real Watch, so it must count.
        source: 'com.apple.health.seed',
        wasUserEntered: false,
        firstSeenAt: new Date(at).toISOString(),
        updatedAt: new Date(at).toISOString(),
      };
    });
    await this.ctx.storage.put(seeded);

    // Yesterday: committed, skipped, half the money gone. This is what makes
    // the agent able to say "you said that yesterday".
    const yesterdayDue = localTimeToInstant(now, tz, 19, 0, -1);
    const yesterdaySplit = splitSlash(50_000_000);
    const missed: StoredCommitment = {
      id: 'c_seed_yesterday',
      text: 'gym at 7',
      dueAt: new Date(yesterdayDue).toISOString(),
      graceMin: DEFAULT_GRACE_MIN,
      status: 'missed',
      stake: {
        lamports: 50_000_000,
        status: 'slashed',
        refundedLamports: yesterdaySplit.refunded,
        forfeitedLamports: yesterdaySplit.forfeited,
        txSig: null,
      },
      createdAt: new Date(yesterdayDue - 6 * 3600_000).toISOString(),
      renegotiations: 0,
    };
    await this.ctx.storage.put(KEY.commitment(missed.id), missed);

    // The excuse the agent gets to remember.
    await this.appendTracesAt([
      { at: workoutDays[0]!, kind: 'workout_detected', summary: 'traditional strength training · 45 min · 310 kcal' },
      { at: workoutDays[1]!, kind: 'workout_detected', summary: 'running · 30 min · 260 kcal' },
      { at: yesterdayDue - 6 * 3600_000, kind: 'commitment_created', summary: 'gym at 7 · 0.05 SOL on it' },
      { at: yesterdayDue - 6 * 3600_000, kind: 'stake_held', summary: '0.05 SOL locked' },
      { at: yesterdayDue + 24 * 60_000, kind: 'alarm_fired', summary: '19:24 — checking on gym at 7' },
      { at: yesterdayDue + 24 * 60_000, kind: 'message_sent', summary: 'bro' },
      { at: yesterdayDue + 25 * 60_000, kind: 'message_sent', summary: '7:24 and no workout 😭' },
      { at: yesterdayDue + 40 * 60_000, kind: 'message_received', summary: 'cant today bro, too much work' },
      { at: yesterdayDue + 41 * 60_000, kind: 'message_sent', summary: 'thats the excuse every time' },
      {
        at: endOfLocalDay(yesterdayDue, tz),
        kind: 'stake_slashed',
        summary: `${solText(yesterdaySplit.refunded)} back, ${solText(yesterdaySplit.forfeited)} forfeited`,
      },
    ]);

    return ok({ workouts: workoutDays.length, commitments: 1 });
  }

  /** Like appendTraces, but for history that did not happen just now. */
  private async appendTracesAt(
    entries: Array<{ at: number; kind: TraceKind; summary: string }>,
  ): Promise<void> {
    let seq = (await this.ctx.storage.get<number>(KEY.traceSeq)) ?? 0;
    const writes: Record<string, unknown> = {};
    for (const entry of [...entries].sort((a, b) => a.at - b.at)) {
      seq++;
      writes[KEY.trace(seq)] = {
        id: seq,
        ts: new Date(entry.at).toISOString(),
        kind: entry.kind,
        summary: entry.summary,
      } satisfies TraceEvent;
    }
    writes[KEY.traceSeq] = seq;
    await this.ctx.storage.put(writes);
  }

  // --- solana ---------------------------------------------------------------

  /**
   * Every chain call goes through here. Devnet being slow, rate-limited or
   * down must never stop a commitment being made or a text being sent — the
   * signature simply arrives late, or not at all, and API.md already says
   * txSig is null until the transaction lands.
   */
  private async onChain<T>(what: string, run: () => Promise<T>): Promise<T | null> {
    try {
      return await run();
    } catch (error) {
      // Redacted: RPC errors embed the request URL, and the working devnet
      // URL carries its API key in the query string.
      const safe = redact(String(error));
      console.error(`solana ${what} failed`, safe);
      await this.appendTraces([
        { kind: 'decision', summary: `chain ${what} failed — the loop continues without it`, data: { error: safe } },
      ]);
      return null;
    }
  }

  private rpc() {
    return rpcFor(this.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com');
  }

  /** The user's wallet, created on first use. */
  private async userWallet(): Promise<StoredWallet> {
    const existing = await this.ctx.storage.get<StoredWallet>(KEY.wallet);
    if (existing) return existing;

    const seed = newSeed();
    const { address } = await walletFromSeed(seed);
    const wallet: StoredWallet = { seed, address, funded: false };
    await this.ctx.storage.put(KEY.wallet, wallet);
    return wallet;
  }

  /**
   * Tops the user up from the treasury. Deliberately not the devnet faucet:
   * it rate-limits hard (it refused this backend outright while this was
   * being built), and a demo that needs the faucet to cooperate on stage is a
   * demo that fails on stage.
   */
  private async fundUserWallet(): Promise<void> {
    const treasurySeed = this.env.SNAP_TREASURY_SEED;
    if (!treasurySeed) return;

    const wallet = await this.userWallet();
    await this.onChain('funding', async () => {
      const rpc = this.rpc();
      const balance = await getBalanceLamports(rpc, wallet.address as never);
      if (balance >= USER_FUNDING_LAMPORTS) {
        await this.ctx.storage.put(KEY.wallet, { ...wallet, funded: true });
        return;
      }
      const treasury = await walletFromSeed(treasurySeed);
      await transferSol(rpc, treasury, wallet.address as never, USER_FUNDING_LAMPORTS - balance);
      await this.ctx.storage.put(KEY.wallet, { ...wallet, funded: true });
    });
  }

  /**
   * Moves a stake and records the signature on the commitment.
   *
   * `stake` is signed by the user's own wallet; `release` and `slash` are
   * signed by the escrow, which is the oracle role the Anchor program will
   * take over in step 6.
   */
  private async moveStake(
    commitmentId: string,
    direction: 'stake' | 'release' | 'slash',
  ): Promise<void> {
    const escrowSeed = this.env.SNAP_ESCROW_SEED;
    const treasurySeed = this.env.SNAP_TREASURY_SEED;
    if (!escrowSeed || !treasurySeed) return;

    const commitment = await this.commitment(commitmentId);
    if (!commitment) return;

    const signature = await this.onChain(direction, async () => {
      const rpc = this.rpc();
      const wallet = await this.userWallet();
      const user = await walletFromSeed(wallet.seed);
      const escrow = await walletFromSeed(escrowSeed);
      const treasury = await walletFromSeed(treasurySeed);
      const amount = commitment.stake.lamports;

      if (direction === 'stake') {
        return transferSol(rpc, user, escrow.address, amount);
      }
      if (direction === 'release') {
        return transferSol(rpc, escrow, user.address, amount);
      }

      // A miss returns half and forfeits the rest. Both legs ride in one
      // transaction: two would mean two signatures for one stake, and a
      // window where the refund landed and the forfeit did not.
      //
      // With no charity address configured the forfeited half goes to the
      // treasury instead. The user still gets their half either way, so the
      // mechanic the app describes is true whether or not it is set.
      const { refunded, forfeited } = splitSlash(amount);
      const charity = this.env.SNAP_CHARITY_ADDRESS;
      const forfeitTo = charity ? (charity as Address) : treasury.address;
      return transferSolMany(rpc, escrow, [
        { to: user.address, amountLamports: refunded },
        { to: forfeitTo, amountLamports: forfeited },
      ]);
    });

    if (!signature) return;

    // Re-read: the agent may have moved on while the chain was confirming.
    const current = await this.commitment(commitmentId);
    if (!current) return;
    await this.ctx.storage.put(KEY.commitment(commitmentId), {
      ...current,
      stake: { ...current.stake, txSig: signature },
    } satisfies StoredCommitment);

    await this.appendTraces([
      {
        kind: direction === 'stake' ? 'stake_held' : direction === 'release' ? 'stake_released' : 'stake_slashed',
        summary: `on devnet · ${signature.slice(0, 8)}…`,
        data: { txSig: signature, explorer: explorerUrl(signature) },
      },
    ]);
  }

  // --- alarms -------------------------------------------------------------

  /**
   * Fires whatever is due, then re-arms for the next thing. This is what makes
   * Snap proactive — DESIGN.md is explicit that it is alarms, not cron.
   */
  async alarm(): Promise<void> {
    await this.fireDueAlarms();
  }

  /**
   * Runs every alarm at or before the agent's clock. Split out from alarm()
   * so POST /debug/timewarp can move the clock and fire what is now due.
   */
  async fireDueAlarms(): Promise<number> {
    await this.loadClock();
    const profile = await this.ctx.storage.get<Profile>(KEY.profile);
    if (!profile) return 0;

    const due = await this.ctx.storage.list<ScheduledAlarm>({
      start: ALARM_RANGE_START,
      end: KEY.alarm(this.now() + 1, ''),
    });

    let fired = 0;
    for (const [key, scheduled] of due) {
      // Delete first: a wake-up that throws must not fire forever.
      await this.ctx.storage.delete(key);
      await this.runAlarm(scheduled, profile);
      fired++;
    }

    await this.rearm();
    return fired;
  }

  private async runAlarm(scheduled: ScheduledAlarm, profile: Profile): Promise<void> {
    switch (scheduled.kind) {
      case 'grace': {
        const commitment = await this.commitment(scheduled.commitmentId);
        // Already settled, or talked forward — nothing to check on.
        if (!commitment || commitment.status !== 'pending') return;

        const covering = findCoveringWorkout(
          await this.loadWorkouts(),
          parseIso(commitment.createdAt) ?? 0,
          this.endOfDayFor(commitment, profile),
        );
        if (covering) return;

        await this.appendTraces([
          {
            kind: 'alarm_fired',
            summary: `${clockOnly(this.now(), profile.timezone)} — checking on ${commitment.text}`,
            data: { commitmentId: commitment.id, kind: 'grace' },
          },
        ]);
        await this.runAgent(
          `you woke yourself up. "${commitment.text}" was due at ${clockOnly(parseIso(commitment.dueAt) ?? this.now(), profile.timezone)} and the ${commitment.graceMin} minute grace has passed with no workout. their ${solText(commitment.stake.lamports)} is still locked and you take it at end of day, not now. decide whether to text them.`,
        );
        return;
      }

      case 'end_of_day': {
        const commitment = await this.commitment(scheduled.commitmentId);
        if (!commitment || (commitment.status !== 'pending' && commitment.status !== 'renegotiated')) return;

        const covering = findCoveringWorkout(
          await this.loadWorkouts(),
          parseIso(commitment.createdAt) ?? 0,
          this.endOfDayFor(commitment, profile),
        );

        await this.appendTraces([
          {
            kind: 'alarm_fired',
            summary: covering
              ? `end of day — ${commitment.text} was met`
              : `end of day — ${commitment.text} is unmet`,
            data: { commitmentId: commitment.id, kind: 'end_of_day' },
          },
        ]);
        await this.runAgent(
          covering
            ? `end of day. "${commitment.text}" got done. release their ${solText(commitment.stake.lamports)} and hype them up.`
            : `end of day. "${commitment.text}" never happened and no workout covers it. their ${solText(commitment.stake.lamports)} is yours to take now. decide.`,
        );
        return;
      }

      case 'morning': {
        // Tomorrow's check-in is booked before this one runs anything, so a
        // failure today does not end the daily rhythm.
        await this.scheduleMorning(profile, 1);

        const commitments = await this.loadCommitments();
        const today = localDay(this.now(), profile.timezone);
        const hasToday = commitments.some(
          (c) =>
            (c.status === 'pending' || c.status === 'renegotiated') &&
            localDay(parseIso(c.dueAt) ?? 0, profile.timezone) === today,
        );
        if (hasToday) return;

        const link = await this.ctx.storage.get<Link>(KEY.link);
        if (!link?.linked || link.optedOut) return;

        await this.appendTraces([
          { kind: 'alarm_fired', summary: 'morning — no plan yet', data: { kind: 'morning' } },
        ]);
        await this.runAgent(
          'morning check-in. they have not said what they are doing today. ask them the plan — short, and only if it is not nagging.',
        );
        return;
      }
    }
  }

  /** Points the object's single alarm at whichever wake-up comes first. */
  private async rearm(): Promise<void> {
    const next = await this.ctx.storage.list<ScheduledAlarm>({
      start: ALARM_RANGE_START,
      end: 'alarm:~',
      limit: 1,
    });
    const first = [...next.values()][0];
    if (first) await this.ctx.storage.setAlarm(first.at);
    else await this.ctx.storage.deleteAlarm();
  }

  private async schedule(at: number, kind: AlarmKind, commitmentId?: string): Promise<void> {
    const suffix = commitmentId ? `${kind}:${commitmentId}` : kind;
    const entry: ScheduledAlarm = commitmentId ? { at, kind, commitmentId } : { at, kind };
    await this.ctx.storage.put(KEY.alarm(at, suffix), entry);
    await this.rearm();
  }

  /** Drops any pending wake-up of this kind for this commitment. */
  private async unschedule(kind: AlarmKind, commitmentId: string): Promise<void> {
    const all = await this.ctx.storage.list<ScheduledAlarm>({
      start: ALARM_RANGE_START,
      end: 'alarm:~',
    });
    for (const [key, scheduled] of all) {
      if (scheduled.kind === kind && scheduled.commitmentId === commitmentId) {
        await this.ctx.storage.delete(key);
      }
    }
  }

  private async scheduleMorning(profile: Profile, dayOffset: number): Promise<void> {
    const at = localTimeToInstant(this.now(), profile.timezone, MORNING_HOUR, 0, dayOffset);
    await this.schedule(at, 'morning');
  }

  private async commitment(id: string | undefined): Promise<StoredCommitment | null> {
    if (!id) return null;
    return (await this.ctx.storage.get<StoredCommitment>(KEY.commitment(id))) ?? null;
  }

  // --- the agent ----------------------------------------------------------

  /**
   * One turn of the loop. Assembles context, asks the brain what to do, and
   * runs each proposed tool call through its guard before anything happens.
   * Every stage writes a trace event, including a refusal — the brain screen
   * is supposed to show the agent deciding *not* to act too.
   */
  async runAgent(instruction: string): Promise<DoResult<{ ran: boolean }>> {
    await this.loadClock();
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
        { kind: 'decision', summary: `brain unavailable (${brain.name})`, data: { error: redact(String(error)) } },
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

    // Choosing among six tools is where small models fall down. Measured
    // against the deployed Worker, "7pm gym, $5 on it" produced a commitment
    // 0 times out of 4, and "gym at 7" 2 out of 4 — both perfectly ordinary
    // ways to text it. A missed commitment means no stake, no alarms and
    // nothing to demo, so it gets a second look as a single yes/no question,
    // which is a far easier call than picking a tool.
    if (!executed.includes('create_commitment')) {
      const open = (await this.loadCommitments()).filter(
        (c) => c.status === 'pending' || c.status === 'renegotiated',
      );
      if (open.length === 0) {
        if (await this.confirmCommitment(brain, profile, instruction)) {
          executed.push('create_commitment');
        }
      }
    }

    // Some models emit one tool call per turn, so a commitment gets recorded
    // and the user hears nothing — which is the product failing silently.
    // Ask once more, with only the two talking tools available.
    if (!executed.includes('send_messages') && !executed.includes('stay_quiet')) {
      await this.followUp(brain, profile, instruction, executed);
    }

    return ok({ ran: true });
  }

  /**
   * "Did they name a time to train?" — one question, two tools. Declining is
   * a first-class answer: "ill hit the gym later" must not become a stake.
   */
  private async confirmCommitment(
    brain: Brain,
    profile: Profile,
    instruction: string,
  ): Promise<boolean> {
    const narrow = TOOLS.filter(
      (tool) => tool.function.name === 'create_commitment' || tool.function.name === 'stay_quiet',
    );

    try {
      const context = await this.buildContext(profile);
      const decision = await brain.decide({
        system: SYSTEM_PROMPT,
        context: renderContext(context),
        instruction: `${instruction}

answer one question and nothing else: did they just say they are training at a
particular time? "7pm gym" and "gym at 7" and "workout at 6 tonight" all count —
the hour is what matters, however they wrote it.

if yes, call create_commitment with that hour on their clock.
if they named no time at all ("later", "tomorrow sometime", "i should go"),
call stay_quiet — a vague intention is not a commitment and must not take money.`,
        tools: narrow,
      });

      for (const call of decision.toolCalls) {
        if (call.name !== 'create_commitment') continue;
        if (await this.dispatch(call, profile)) return true;
      }
    } catch (error) {
      await this.appendTraces([
        { kind: 'decision', summary: 'could not re-check for a commitment', data: { error: redact(String(error)) } },
      ]);
    }
    return false;
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
        { kind: 'decision', summary: 'could not reach the brain for a reply', data: { error: redact(String(error)) } },
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

        // Grace is the warning; end of day is when the money moves.
        const dueAt = parseIso(commitment.dueAt) ?? now;
        await this.schedule(dueAt + commitment.graceMin * 60_000, 'grace', commitment.id);
        await this.schedule(this.endOfDayFor(commitment, profile), 'end_of_day', commitment.id);

        await this.appendTraces([
          {
            kind: 'commitment_created',
            summary: `${commitment.text} · ${solText(commitment.stake.lamports)} on it`,
            data: { id: commitment.id, dueAt: commitment.dueAt },
          },
          { kind: 'stake_held', summary: `${solText(commitment.stake.lamports)} locked`, data: { id: commitment.id } },
        ]);

        // Confirming on devnet takes seconds. The commitment is already real
        // and Snap can already text about it; the signature catches up.
        this.ctx.waitUntil(this.moveStake(commitment.id, 'stake'));
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

        const moved: StoredCommitment = {
          ...existing,
          dueAt: guard.value.dueAt,
          status: 'renegotiated',
          renegotiations: existing.renegotiations + 1,
        };
        await this.ctx.storage.put(KEY.commitment(existing.id), moved);

        // The old grace wake-up is about a deadline that no longer exists.
        await this.unschedule('grace', existing.id);
        await this.unschedule('end_of_day', existing.id);
        const newDue = parseIso(moved.dueAt) ?? now;
        await this.schedule(newDue + moved.graceMin * 60_000, 'grace', moved.id);
        // A renegotiated deadline IS the slash point, not end of day.
        await this.schedule(newDue, 'end_of_day', moved.id);

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
    const split = stake === 'slashed' ? splitSlash(commitment.stake.lamports) : null;

    await this.ctx.storage.put(KEY.commitment(commitment.id), {
      ...commitment,
      status,
      stake: {
        ...commitment.stake,
        status: stake,
        ...(split ? { refundedLamports: split.refunded, forfeitedLamports: split.forfeited } : {}),
      },
    } satisfies StoredCommitment);

    // Settled: nothing left to wake up about.
    await this.unschedule('grace', commitment.id);
    await this.unschedule('end_of_day', commitment.id);
    await this.rearm();

    await this.appendTraces([
      {
        kind: stake === 'released' ? 'stake_released' : 'stake_slashed',
        summary:
          split === null
            ? `${solText(commitment.stake.lamports)} back in your wallet`
            : `${solText(split.refunded)} back, ${solText(split.forfeited)} forfeited`,
        data: { id: commitment.id, ...(split ?? {}) },
      },
    ]);

    this.ctx.waitUntil(this.moveStake(commitment.id, stake === 'released' ? 'release' : 'slash'));
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

  /** An open commitment that a stored workout now covers, if any. */
  private async coveredCommitment(profile: Profile): Promise<StoredCommitment | null> {
    const [commitments, workouts] = await Promise.all([this.loadCommitments(), this.loadWorkouts()]);
    for (const commitment of commitments) {
      if (commitment.status !== 'pending' && commitment.status !== 'renegotiated') continue;
      if (commitment.stake.status !== 'held') continue;
      const covering = findCoveringWorkout(
        workouts,
        parseIso(commitment.createdAt) ?? 0,
        this.endOfDayFor(commitment, profile),
      );
      if (covering) return commitment;
    }
    return null;
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
    const ai = (this.env as unknown as { AI?: AiBinding }).AI;
    const workersAI = ai
      ? new WorkersAIBrain(ai, this.env.WORKERS_AI_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast')
      : null;

    if (!this.env.OPENAI_API_KEY) return workersAI;

    const openai = new OpenAIBrain(this.env.OPENAI_API_KEY, this.env.OPENAI_MODEL || 'gpt-4o');
    if (!workersAI) return openai;

    // A wrong model name or a dead key used to mean the agent said nothing.
    // The binding is already there; use it rather than going quiet.
    return new FallbackBrain(openai, workersAI, async (error) => {
      await this.appendTraces([
        {
          kind: 'decision',
          summary: `openai unavailable — falling back to ${workersAI.name}`,
          data: { error: redact(error), model: this.env.OPENAI_MODEL || 'gpt-4o' },
        },
      ]);
    });
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
      // Only present on a slash, and the app needs them: `slashed` alone no
      // longer says how much came back.
      ...(stored.stake.refundedLamports === undefined
        ? {}
        : { refundedLamports: stored.stake.refundedLamports }),
      ...(stored.stake.forfeitedLamports === undefined
        ? {}
        : { forfeitedLamports: stored.stake.forfeitedLamports }),
      txSig: stored.stake.txSig,
    },
  };
}

/** "traditionalStrengthTraining" → "traditional strength training" */
function humanizeType(type: string): string {
  return type.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
}

/** "19:24" in the user's zone. */
function clockOnly(instant: number, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(instant));
}

/** Local YYYY-MM-DD, for "is there a commitment for today". */
function localDay(instant: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(instant));
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
