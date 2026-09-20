import { DurableObject } from 'cloudflare:workers';

import {
  buildDays,
  countMovesThisWeek,
  countVerifiedThisWeek,
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
  guardAccept,
  guardOffer,
  guardSlash,
  type StandingOffer,
} from './agent/guards';
import { ACCEPT_OFFER_TOOL, DEFAULT_GRACE_MIN, SYSTEM_PROMPT, TOOLS } from './agent/tools';
import { describeReaction, isAffirmative, isNegative, reactionEmoji, toReaction, type ReactionName } from './reactions';
import type { Brain, ToolCall } from './brain';
import { FallbackBrain } from './brains/fallback';
import { OpenAIBrain } from './brains/openai';
import { WorkersAIBrain, type AiBinding } from './brains/workers-ai';
import type { Channel, ChannelName } from './channel';
import { LinqChannel } from './channels/linq';
import { TraceChannel } from './channels/trace';
import { fail, ok, type DoResult } from './http';
import { asksHowItWorks, onboardingTexts } from './onboarding';
import { isOptOut } from './optout';
import {
  MAX_TOPUP_LAMPORTS,
  MIN_TOPUP_LAMPORTS,
  WALLET_CEILING_LAMPORTS,
  solText,
} from './money';
import { redact } from './redact';
import {
  applyPhotoMode,
  describePhoto,
  photoInstruction,
  photoSummary,
  type PhotoLook,
  type PhotoOutcome,
  type VisionEnv,
} from './vision';
import {
  explorerUrl,
  getBalanceLamports,
  newSeed,
  rpcFor,
  transferSol,
  walletFromSeed,
} from './solana/wallet';
import { issueToken, secureEquals } from './ids';
import { endOfLocalDay, localTimeToInstant, parseIso, startOfWeek } from './time';
import type {
  Commitment,
  Reschedule,
  StateResponse,
  TopUpResponse,
  TraceEvent,
  TraceKind,
  WalletEntry,
  WalletResponse,
  WorkoutInput,
  WorkoutsResponse,
} from './types';

/**
 * One UserAgent per user. Holds that user's profile, workouts, commitments and
 * trace feed. Later steps hang the agent, the channel link and the stake off
 * the same object — its storage is the user's whole world.
 */

/** What a user keeps about a competition they entered. */
export interface CompetitionEntry {
  id: string;
  name: string;
  stakeLamports: number;
  joinedAt: string;
  status: 'entered' | 'settled';
  met?: boolean;
  progress?: number;
  payoutLamports?: number;
  settledAt?: string;
}

const KEY = {
  profile: 'profile',
  token: 'token',
  link: 'link',
  /** Deliberately has no colon: a `trace:` prefixed key would land inside the
   *  lexicographic range that getTrace() scans. */
  traceSeq: 'traceSeq',
  clockOffset: 'clockOffset',
  wallet: 'wallet',
  /** Like `traceSeq`: no colon, so it sits outside the `wallet:` scan range. */
  walletSeq: 'walletSeq',
  walletEntry: (id: number) => `wallet:entry:${String(id).padStart(12, '0')}`,
  /** One photo, one payout: the fingerprint of every picture already spent. */
  proof: (fingerprint: string) => `proof:${fingerprint}`,
  /** Stage settings. See DemoSettings. */
  demo: 'demo',
  competition: (id: string) => `competition:${id}`,
  /** The stake Snap has proposed and the user has not answered yet. */
  offer: 'offer',
  workout: (hkUuid: string) => `workout:${hkUuid}`,
  /** Sorts by fire time, so a range scan finds everything due. */
  alarm: (at: number, suffix: string) => `alarm:${String(at).padStart(14, '0')}:${suffix}`,
  commitment: (id: string) => `commitment:${id}`,
  trace: (id: number) => `trace:${String(id).padStart(12, '0')}`,
} as const;

/** '~' sorts above every digit, so it caps a range scan. */
const TRACE_RANGE_END = 'trace:~';
const ALARM_RANGE_START = 'alarm:';
const WALLET_ENTRY_PREFIX = 'wallet:entry:';

/** How much of the wallet's history the app gets. It is a receipt, not a bank. */
const WALLET_ENTRY_LIMIT = 40;

/** How much history /state carries for the schedule screen. */
const STATE_DAY_WINDOW = 30;

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
  /**
   * The provider's id for the last thing they sent. A tapback has to name the
   * message it hangs off, and the only one Snap ever reacts to is their most
   * recent — reacting to something three texts back reads as a glitch.
   */
  lastInboundMessageId?: string | null;
  /**
   * The last few texts Snap sent, with the ids the channel gave them. An
   * inbound tapback names one of these, and without them a reaction can only
   * be shown as a bare emoji pointing at nothing.
   */
  recentOutbound?: Array<{ id: string; text: string }>;
}

/** How many of Snap's own texts stay addressable for a tapback. */
const RECENT_OUTBOUND = 10;

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

/**
 * Signing costs lamports, and a wallet emptied to the last one cannot pay for
 * the transfer that releases the stake back into it. Staking leaves this much
 * behind.
 */
const FEE_HEADROOM_LAMPORTS = 5_000_000;

/**
 * The balance is read from the chain, which is a network call on a path that
 * runs inside an agent turn. Re-reading it every few seconds is what the RPC
 * rate limit is for, so it is held briefly in memory.
 */
const BALANCE_CACHE_MS = 15_000;

interface StoredWorkout extends WorkoutInput {
  firstSeenAt: string;
  updatedAt: string;
}

/** A commitment plus the bookkeeping the agent needs but the app never sees. */
interface StoredCommitment extends Commitment {
  createdAt: string;
  /**
   * Kept for commitments stored before the log existed. `rescheduleCount`
   * prefers the log and falls back to this, so nothing needs migrating.
   */
  renegotiations: number;
}

/** How many times this session has been moved — the log, or the old counter. */
function rescheduleCount(commitment: { reschedules?: Reschedule[]; renegotiations?: number }): number {
  return commitment.reschedules?.length ?? commitment.renegotiations ?? 0;
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

/** A photo fingerprint that has already been counted. See `judgePhoto`. */
interface UsedProof {
  at: string;
}

/**
 * The demo's safety valve, per user, behind the same DEBUG_KEY as everything
 * else in /debug.
 *
 * The closing beat now depends on a vision model judging a photo live, in a
 * venue, under whatever lighting — and when OpenAI is unreachable the
 * fallback is a small Workers AI model that is markedly worse at returning
 * clean JSON, which `readVerdict` reads as `unsure`. `unsure` does not
 * release a stake, so the most likely way this demo dies is the verifier
 * shrugging at a perfectly good photo of Ryan in a gym.
 *
 * `lenient` is the one to run on stage: it rescues `unsure` only, so a
 * screenshot is still refused and the roast beat still works. `always`
 * accepts anything that loads and exists for the case where the vision model
 * is down entirely.
 *
 * Whenever either of them changes an outcome the trace says so, in the row
 * judges are watching. The brain screen is the honesty of this product; a
 * switch that quietly forges a verdict would be worth less than a failed
 * demo.
 */
interface DemoSettings {
  photoMode: 'strict' | 'lenient' | 'always';
  /** Lets the same picture be spent twice, so a beat can be rehearsed. */
  allowReplay: boolean;
}

const STRICT_DEMO: DemoSettings = { photoMode: 'strict', allowReplay: false };

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

  /** See BALANCE_CACHE_MS. Dropped whenever this object moves money itself. */
  private balanceCache: { lamports: number; at: number } | null = null;

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
        const profile = auth.value;
        this.ctx.waitUntil(
          (async () => {
            // Settle first, in code. Whether a workout covers a commitment is
            // something HealthKit answered, not something to ask a model — and
            // a turn where it simply forgets to call release_stake leaves the
            // stake held forever with the loop looking finished.
            await this.settle(closing, 'met', 'released', 'watch');
            await this.announce(
              profile,
              `a workout just showed up on their watch and it covers "${closing.text}". they never sent a pic, but you could see it anyway, so you gave them their ${solText(closing.stake.lamports)} back. tell them — and tell them the pic is still the quicker way to get paid.`,
            );
          })() as unknown as Promise<unknown>,
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

    // Same bar as releasing a stake — a verified photo or a qualifying
    // workout — so the dots on the screen and the agent's "2/4 this week"
    // never disagree.
    const workoutsThisWeek = countVerifiedThisWeek(
      this.now(),
      profile.timezone,
      [...workouts.values()],
      [...commitments.values()],
    );

    return ok({
      weeklyGoal: profile.weeklyGoal,
      workoutsThisWeek,
      linked: link?.linked ?? false,
      // The window the app counts a streak from. Thirty days is enough to show
      // a month of dots and to make "best streak" mean something, and small
      // enough that it rides along on a poll that runs every two seconds.
      days: buildDays(
        this.now(),
        profile.timezone,
        [...workouts.values()],
        [...commitments.values()].map(toWireCommitment),
        STATE_DAY_WINDOW,
      ),
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
    // Nine texts a second apart is nine seconds, and this runs inside the Linq
    // webhook, which retries anything slow — so it finishes in the background
    // while the webhook answers now. Same reason the inbound turn does.
    this.ctx.waitUntil(
      this.sendTexts(onboardingTexts(profile?.name ?? null, profile?.weeklyGoal ?? null)),
    );
    return ok({ greeted: true });
  }

  /**
   * The same explainer, on demand. "help", "how does this work", "what do you
   * do" — the three things anyone types at a number they just met.
   *
   * Deliberately not a model turn: the one question whose answer must never
   * be improvised is how the money works.
   */
  private async explainAgain(): Promise<void> {
    const profile = await this.ctx.storage.get<Profile>(KEY.profile);
    await this.sendTexts(onboardingTexts(profile?.name ?? null, profile?.weeklyGoal ?? null, true));
  }

  /** Records an inbound text, or a photo. The agent acts on it in `runInboundTurn`. */
  async receiveMessage(
    text: string,
    imageUrls: string[] = [],
    messageId: string | null = null,
  ): Promise<DoResult<{ optedOut: boolean }>> {
    await this.loadClock();
    const link = await this.ctx.storage.get<Link>(KEY.link);
    if (!link) return fail(404, 'not_found', 'no such user');

    // A photo is recorded as a message so the conversation the model reads
    // shows it happened; the URLs ride in `data` for anyone who needs them.
    await this.appendTraces([
      imageUrls.length > 0
        ? { kind: 'message_received', summary: photoSummary(text, imageUrls.length), data: { imageUrls } }
        : { kind: 'message_received', summary: text },
    ]);

    const optedOut = isOptOut(text);
    // Linq clears an opt-out as soon as the recipient replies again with
    // anything that is not itself a keyword, so mirror that rather than
    // keeping our own permanent block — otherwise one STOP kills the user
    // forever even after they text back.
    if (optedOut !== link.optedOut || (messageId && messageId !== link.lastInboundMessageId)) {
      await this.ctx.storage.put(KEY.link, {
        ...link,
        optedOut,
        lastInboundMessageId: messageId ?? link.lastInboundMessageId ?? null,
      } satisfies Link);
    }
    return ok({ optedOut });
  }

  /**
   * Reads the stage settings, or writes them. Demo only — the Worker checks
   * DEBUG_KEY before this is ever reached.
   */
  async demoSettings(
    token: string,
    update?: Partial<DemoSettings>,
  ): Promise<DoResult<DemoSettings>> {
    const auth = await this.authenticate(token);
    if (!auth.ok) return auth;

    const current = (await this.ctx.storage.get<DemoSettings>(KEY.demo)) ?? STRICT_DEMO;
    if (!update) return ok(current);

    const next: DemoSettings = {
      photoMode: update.photoMode ?? current.photoMode,
      allowReplay: update.allowReplay ?? current.allowReplay,
    };
    await this.ctx.storage.put(KEY.demo, next);
    await this.appendTraces([
      {
        kind: 'decision',
        summary: `demo settings — photos ${next.photoMode}${next.allowReplay ? ', replays allowed' : ''}`,
        data: next,
      },
    ]);
    return ok(next);
  }

  private async demo(): Promise<DemoSettings> {
    return (await this.ctx.storage.get<DemoSettings>(KEY.demo)) ?? STRICT_DEMO;
  }

  // --- reactions -----------------------------------------------------------

  /**
   * A tapback on one of Snap's texts.
   *
   * Reactions are the cheapest thing a person can send, which is exactly why
   * they matter: the user who will not type "ok" will still tap 👍, and a
   * thread where only one side reacts feels like a broadcast. So they run a
   * real turn — but a narrow one, and Snap is told plainly that silence is
   * usually the right answer to a thumbs up.
   *
   * The one case that is not conversational: a 👍 or ❤️ on a standing offer
   * is a yes, and takes their money. That is deliberate and it is said out
   * loud in onboarding, because a tapback that quietly moves money and was
   * never explained is a trap.
   */
  async receiveReaction(
    emoji: string,
    name: ReactionName | null,
    targetMessageId: string | null,
    removed = false,
  ): Promise<DoResult<{ optedOut: boolean; accepted: boolean }>> {
    await this.loadClock();
    const link = await this.ctx.storage.get<Link>(KEY.link);
    if (!link) return fail(404, 'not_found', 'no such user');

    const target = await this.outboundText(targetMessageId);
    await this.appendTraces([
      {
        kind: 'reaction_received',
        summary: describeReaction(emoji, target, removed),
        data: { emoji, name, targetMessageId, removed },
      },
    ]);

    if (link.optedOut) return ok({ optedOut: true, accepted: false });
    // Taking a tapback back is not a new thing to say. It is recorded and
    // that is all — answering it would make un-tapping something a way to
    // summon Snap.
    if (removed) return ok({ optedOut: false, accepted: false });

    // A yes on a standing offer, decided here rather than by the model: the
    // answer to "did they agree?" is not a judgement call when the answer is
    // a thumbs up, and money should not move on a model's reading of an
    // emoji when it does not have to.
    if (name && isAffirmative(name)) {
      const accepted = await this.acceptStandingOffer(`tapped ${emoji}`);
      if (accepted) return ok({ optedOut: false, accepted: true });
    }

    return ok({ optedOut: false, accepted: false });
  }

  /**
   * The conversational half of a reaction: Snap gets a turn, with the tapback
   * described to it the way a person would read it.
   *
   * Run after `receiveReaction`, and skipped entirely when the reaction
   * already did something (accepting an offer says everything it needs to).
   */
  async runReactionTurn(emoji: string, name: ReactionName | null, targetMessageId: string | null): Promise<DoResult<{ ran: boolean }>> {
    await this.loadClock();
    const target = await this.outboundText(targetMessageId);
    const sentiment = name
      ? isAffirmative(name)
        ? 'that is agreement'
        : isNegative(name)
          ? 'that is a no'
          : name === 'laugh'
            ? 'they thought it was funny'
            : name === 'question'
              ? 'they are confused'
              : 'they are emphasising it'
      : 'you cannot tell exactly which tapback it was';

    // Not `fromUser`: the two narrow passes that flag is for are both wrong
    // here. An affirmative tapback was already taken as agreement above, by
    // the backend, before this turn ran — and letting the acceptance pass see
    // a 😂 on a standing offer would let a laugh take someone's money. A
    // tapback never names a session time either, so there is nothing for the
    // offer pass to find.
    return this.runAgent(
      `they just tapped ${emoji} on ${target ? `your text "${target}"` : 'one of your texts'}. ${sentiment}. ` +
        'a tapback is not a conversation — stay_quiet unless it actually changes something, ' +
        'and if you do answer, one short text or a tapback of your own, never a speech.',
      false,
    );
  }

  /** Tapbacks Snap sends. The trace row is written whether or not it lands. */
  private async sendReaction(name: ReactionName): Promise<boolean> {
    const link = await this.ctx.storage.get<Link>(KEY.link);
    if (!link?.linked || !link.chatId || !link.channel) return false;
    if (link.optedOut) return false;

    const emoji = reactionEmoji(name);
    const target = await this.lastInboundText();
    await this.appendTraces([
      {
        kind: 'reaction_sent',
        summary: describeReaction(emoji, target),
        data: { emoji, name, targetMessageId: link.lastInboundMessageId ?? null },
      },
    ]);

    await this.channelFor(link.channel).react(
      link.chatId,
      name,
      link.lastInboundMessageId ?? null,
    );
    return true;
  }

  /**
   * Which of Snap's texts an inbound tapback was aimed at.
   *
   * Only the ids the channel handed back are addressable, and only the last
   * few of those. A tapback on anything older, or sent through a channel that
   * does not return ids, still shows — as the bare emoji. An unlabelled
   * reaction is better than one labelled with the wrong line.
   */
  private async outboundText(messageId: string | null): Promise<string | null> {
    if (!messageId) return null;
    const link = await this.ctx.storage.get<Link>(KEY.link);
    return link?.recentOutbound?.find((entry) => entry.id === messageId)?.text ?? null;
  }

  /**
   * The last thing the user said. Snap only ever tapbacks their most recent
   * message, so this is always the line his own reaction hangs off.
   */
  private async lastInboundText(): Promise<string | null> {
    const events = await this.ctx.storage.list<TraceEvent>({
      start: KEY.trace(1),
      end: TRACE_RANGE_END,
      reverse: true,
      limit: 20,
    });
    for (const event of events.values()) {
      if (event.kind === 'message_received') return event.summary;
    }
    return null;
  }

  /**
   * Turns a standing offer into a held stake without a model in the loop, and
   * says so. Used by the affirmative tapback; the guards are the same ones
   * the `accept_offer` tool goes through, so there is no second path to
   * someone's money.
   */
  private async acceptStandingOffer(how: string): Promise<boolean> {
    const profile = await this.ctx.storage.get<Profile>(KEY.profile);
    if (!profile) return false;

    const offer = await this.standingOffer();
    const open = (await this.loadCommitments())
      .filter((c) => c.status === 'pending' || c.status === 'renegotiated')
      .map(toWireCommitment);
    const guard = guardAccept(offer, this.now(), open);
    if (!guard.ok) return false;

    if (!(await this.canCover(guard.value.lamports))) {
      await this.appendTraces([
        {
          kind: 'decision',
          summary: `${how} — but the wallet cannot cover ${solText(guard.value.lamports)}`,
        },
      ]);
      await this.sendTexts([
        'bro your wallet is empty 💀',
        'add some sol in the app and tap it again',
      ]);
      return false;
    }

    await this.ctx.storage.delete(KEY.offer);
    await this.appendTraces([
      { kind: 'decision', summary: `${how} — that's a yes`, data: { lamports: guard.value.lamports } },
    ]);
    const commitment = await this.startCommitment(guard.value, profile, this.now());
    await this.announce(
      profile,
      `they just agreed to the stake by tapping a reaction on your text. ${solText(commitment.stake.lamports)} is now locked on "${commitment.text}". ` +
        'confirm it in one or two short texts so they know the money is actually on the line, and tell them to send a pic from the gym.',
    );
    return true;
  }

  /**
   * The agent's turn on something the user sent. A plain text is handed over
   * as is. A photo is looked at first, the look is traced, and the agent gets
   * the description in its instruction — it never sees pixels itself, and the
   * guards never hear about the photo at all: a photo is a hype beat, and the
   * money still only moves on the watch.
   */
  async runInboundTurn(text: string, imageUrls: string[] = []): Promise<DoResult<{ ran: boolean }>> {
    if (imageUrls.length === 0) {
      // "how does this work" is the one question that gets the same answer
      // every time, and it is the answer the model is least allowed to
      // improvise — it is about money.
      if (asksHowItWorks(text)) {
        await this.loadClock();
        await this.appendTraces([
          { kind: 'decision', summary: 'they asked how it works — said it straight, no model' },
        ]);
        await this.explainAgain();
        return ok({ ran: true });
      }
      return this.runAgent(`the user just texted you: "${text}". decide what to do.`, true);
    }

    await this.loadClock();
    const url = imageUrls[0]!;
    let look: PhotoLook | null = null;
    try {
      // The generated `Ai` binding type is model-specific; the vision module
      // only needs `run`, the same loosening `brain()` does.
      look = await describePhoto(this.env as unknown as VisionEnv, url);
      await this.appendTraces([
        {
          kind: 'context',
          summary: `looked at the photo · ${look.description}`,
          data: { via: look.via, imageUrl: url, verdict: look.verdict },
        },
      ]);
    } catch (error) {
      await this.appendTraces([
        {
          kind: 'decision',
          summary: 'could not see the photo — reacting blind',
          data: { error: redact(String(error)) },
        },
      ]);
    }

    // The money moves here, in code, before the model says a word. A turn
    // that decides for itself whether a picture counts is a turn that can be
    // talked into paying out, and this is the verifier now.
    const outcome = look ? await this.judgePhoto(look) : { kind: 'unseen' as const };

    return this.runAgent(photoInstruction(text, look?.description ?? null, outcome), true);
  }

  /**
   * Is this photo proof, and does it close anything?
   *
   * Three ways to fail, in the order someone would actually try them: it is
   * not a training photo, it is a photo we have already been paid for, or it
   * is a fine photo with nothing on the line. Only the fourth case moves
   * money, and it moves it before the model is asked to speak.
   */
  private async judgePhoto(look: PhotoLook): Promise<PhotoOutcome> {
    const demo = await this.demo();

    // The stage valve. `lenient` rescues only `unsure` — the verdict a good
    // photo gets when the model hedges or the fallback model mangles its JSON
    // — so a screenshot is still refused and the roast beat still works.
    // `always` accepts anything that loaded, for a vision model that is down.
    const { verdict, overridden } = applyPhotoMode(look.verdict, demo.photoMode);
    // Said out loud, in the row the judges are watching. A switch that
    // quietly forged a verdict would cost more than a failed demo.
    const demoNote = overridden ? ` · demo mode (${overridden})` : '';

    if (verdict !== 'training') {
      const reason = look.rejection ?? 'that is not a workout';
      await this.appendTraces([
        {
          kind: 'photo_rejected',
          summary: `not proof · ${reason}`,
          data: { verdict: look.verdict, description: look.description },
        },
      ]);
      return { kind: look.verdict === 'unsure' ? 'unsure' : 'rejected', reason };
    }

    // Sending Monday's gym selfie again on Tuesday is the first thing anyone
    // would try. The bytes are the same, so the fingerprint is. Rehearsing the
    // beat means sending the same picture over and over, which is what
    // allowReplay is for.
    const seen = await this.ctx.storage.get<UsedProof>(KEY.proof(look.fingerprint));
    if (seen && !demo.allowReplay) {
      await this.appendTraces([
        {
          kind: 'photo_rejected',
          summary: 'not proof · you already sent me that exact photo',
          data: { fingerprint: look.fingerprint, firstSeenAt: seen.at },
        },
      ]);
      return { kind: 'replay', reason: 'you already sent me that exact photo' };
    }

    // Whatever stake is open right now. No window check beyond that: the photo
    // arrived now, so it is necessarily after the commitment was made, and a
    // deadline that has already passed has been settled by the end-of-day
    // alarm and is no longer open. Someone who trains early and sends the pic
    // before the hour they named gets paid early, which is the right answer —
    // the stake is on training, not on punctuality.
    const open = (await this.loadCommitments()).find(
      (c) =>
        (c.status === 'pending' || c.status === 'renegotiated') && c.stake.status === 'held',
    );

    if (!open) {
      await this.appendTraces([
        {
          kind: 'photo_accepted',
          summary: `proof · nothing on the line for it${demoNote}`,
          data: { description: look.description, demoMode: overridden },
        },
      ]);
      return { kind: 'no_stake' };
    }

    // Only now is the image spent. Burning the fingerprint before this point
    // would disqualify a photo that was never paid out for — a pic sent with
    // nothing on the line, or one sent a beat early in rehearsal.
    await this.ctx.storage.put(KEY.proof(look.fingerprint), {
      at: this.nowIso(),
    } satisfies UsedProof);

    const verified: StoredCommitment = {
      ...open,
      proof: { at: this.nowIso(), description: look.description },
    };
    await this.ctx.storage.put(KEY.commitment(open.id), verified);
    await this.appendTraces([
      {
        kind: 'photo_accepted',
        summary: `proof · ${solText(open.stake.lamports)} back on "${open.text}"${demoNote}`,
        data: { commitmentId: open.id, description: look.description, demoMode: overridden },
      },
    ]);
    await this.settle(verified, 'met', 'released', 'photo');

    return { kind: 'released', text: open.text, lamports: open.stake.lamports };
  }

  /**
   * Demo only. Puts a message in front of the agent exactly as an inbound text
   * does, without the channel vendor in the path. An `imageUrl` makes it a
   * photo turn, which is how the photo beat gets rehearsed without spending
   * the sandbox budget.
   *
   * The webhook backgrounds the turn because Linq retries anything slow. Here
   * there is nothing retrying, so this awaits it: a caller that gets the
   * decision back is what makes the loop measurable at all, and what lets a
   * debug button show a result rather than hoping.
   */
  async receiveDebugMessage(
    token: string,
    text: string,
    imageUrls: string[] = [],
  ): Promise<DoResult<{ optedOut: boolean; ran: boolean }>> {
    await this.loadClock();
    const auth = await this.authenticate(token);
    if (!auth.ok) return auth;

    const received = await this.receiveMessage(text, imageUrls);
    if (!received.ok) return received;
    if (received.value.optedOut) return ok({ optedOut: true, ran: false });

    const agent = await this.runInboundTurn(text, imageUrls);
    if (!agent.ok) return agent;
    return ok({ optedOut: false, ran: agent.value.ran });
  }

  // --- competitions ---------------------------------------------------------

  /**
   * Everything a competition needs to judge this entrant: who they are, what
   * clock they are on, and the workouts in the window.
   *
   * The competition does the counting rather than being handed a number, so
   * the rule lives in exactly one place no matter how many entrants there are.
   */
  async competitionData(
    windowStart: number,
    windowEnd: number,
  ): Promise<DoResult<{ name: string; timezone: string; workouts: StoredWorkout[] }>> {
    const profile = await this.ctx.storage.get<Profile>(KEY.profile);
    if (!profile) return fail(404, 'not_found', 'no such user');

    const workouts = (await this.loadWorkouts()).filter((workout) => {
      const start = parseIso(workout.start);
      return start !== null && start >= windowStart && start <= windowEnd;
    });
    return ok({ name: profile.name, timezone: profile.timezone, workouts });
  }

  /** Every competition this user has entered, newest first. */
  async listCompetitions(token: string): Promise<DoResult<{ competitions: CompetitionEntry[] }>> {
    const auth = await this.authenticate(token);
    if (!auth.ok) return auth;
    const entries = [
      ...(await this.ctx.storage.list<CompetitionEntry>({ prefix: 'competition:' })).values(),
    ];
    entries.sort((a, b) => (b.joinedAt ?? '').localeCompare(a.joinedAt ?? ''));
    return ok({ competitions: entries });
  }

  /** Locks an entry stake into the same escrow the commitment loop uses. */
  async enterCompetition(
    competitionId: string,
    name: string,
    lamports: number,
  ): Promise<DoResult<{ name: string; txSig: string | null }>> {
    await this.loadClock();
    const profile = await this.ctx.storage.get<Profile>(KEY.profile);
    if (!profile) return fail(404, 'not_found', 'no such user');

    await this.ctx.storage.put(KEY.competition(competitionId), {
      id: competitionId,
      name,
      stakeLamports: lamports,
      joinedAt: this.nowIso(),
      status: 'entered',
    } satisfies CompetitionEntry);

    await this.appendTraces([
      {
        kind: 'stake_held',
        summary: `${solText(lamports)} into "${name}"`,
        data: { competitionId },
      },
    ]);

    const txSig = await this.onChain('competition entry', async () => {
      const wallet = await this.userWallet();
      const user = await walletFromSeed(wallet.seed);
      const escrowSeed = this.env.SNAP_ESCROW_SEED;
      if (!escrowSeed) throw new Error('no escrow configured');
      const escrow = await walletFromSeed(escrowSeed);
      return transferSol(this.rpc(), user, escrow.address, lamports);
    });
    if (txSig) this.balanceCache = null;

    await this.recordWalletEntry({
      kind: 'held',
      lamports,
      label: name,
      txSig,
      ref: competitionId,
    });

    return ok({ name: profile.name, txSig });
  }

  /**
   * Pays an entrant what the competition decided, and tells them.
   *
   * A payout of zero is still a settlement: they staked, they did not make it,
   * and hearing about it is the whole point of having staked.
   */
  async settleCompetitionEntry(
    competitionId: string,
    name: string,
    payoutLamports: number,
    met: boolean,
    progress: number,
    goal: { type: string; target: number },
    entrants: number,
  ): Promise<DoResult<{ txSig: string | null }>> {
    await this.loadClock();
    const profile = await this.ctx.storage.get<Profile>(KEY.profile);
    if (!profile) return fail(404, 'not_found', 'no such user');

    const stored = await this.ctx.storage.get<CompetitionEntry>(KEY.competition(competitionId));
    const staked = stored?.stakeLamports ?? 0;

    await this.ctx.storage.put(KEY.competition(competitionId), {
      id: competitionId,
      name,
      stakeLamports: staked,
      joinedAt: stored?.joinedAt ?? this.nowIso(),
      status: 'settled',
      met,
      progress,
      payoutLamports,
      settledAt: this.nowIso(),
    } satisfies CompetitionEntry);

    let txSig: string | null = null;
    if (payoutLamports > 0) {
      txSig = await this.onChain('competition payout', async () => {
        const wallet = await this.userWallet();
        const user = await walletFromSeed(wallet.seed);
        const escrowSeed = this.env.SNAP_ESCROW_SEED;
        if (!escrowSeed) throw new Error('no escrow configured');
        const escrow = await walletFromSeed(escrowSeed);
        return transferSol(this.rpc(), escrow, user.address, payoutLamports);
      });
      if (txSig) this.balanceCache = null;
    }

    await this.recordWalletEntry({
      kind: met ? 'released' : 'slashed',
      lamports: met ? payoutLamports : staked,
      label: name,
      txSig,
      ref: competitionId,
    });

    const won = payoutLamports > staked;
    await this.appendTraces([
      {
        kind: met ? 'stake_released' : 'stake_slashed',
        summary: met
          ? `"${name}" — ${progress}/${goal.target}, ${solText(payoutLamports)} back${won ? ' (won the pot)' : ''}`
          : `"${name}" — ${progress}/${goal.target}, ${solText(staked)} gone`,
        data: { competitionId, payoutLamports, met, progress, txSig },
      },
    ]);

    await this.announce(
      profile,
      met
        ? `the competition "${name}" just ended. they hit ${progress} of ${goal.target} and you sent them ${solText(payoutLamports)}${won ? ' — they took a share of the pot off the people who skipped' : ' — their stake back'}. ${entrants} people were in it. tell them.`
        : `the competition "${name}" just ended. they only managed ${progress} of ${goal.target}, so their ${solText(staked)} went into the pot for the people who did. ${entrants} people were in it. tell them straight, no lecture.`,
    );

    return ok({ txSig });
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
      const ids = await this.channelFor(link.channel).send(link.chatId, texts);
      await this.rememberOutbound(texts, ids);
    } catch (error) {
      // A send failure must not lose the trace or fail the caller's request;
      // the brain screen still shows what Snap decided to say.
      console.error('channel send failed', redact(String(error)));
    }
  }

  /** Keeps the last few of Snap's texts addressable, so a tapback can name one. */
  private async rememberOutbound(texts: string[], ids: Array<string | null>): Promise<void> {
    const fresh = texts
      .map((text, index) => ({ id: ids[index] ?? null, text }))
      .filter((entry): entry is { id: string; text: string } => entry.id !== null);
    if (fresh.length === 0) return;

    // Re-read: the send took a second per text and the agent may have moved on.
    const link = await this.ctx.storage.get<Link>(KEY.link);
    if (!link) return;
    await this.ctx.storage.put(KEY.link, {
      ...link,
      recentOutbound: [...(link.recentOutbound ?? []), ...fresh].slice(-RECENT_OUTBOUND),
    } satisfies Link);
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

    // 'proof:' belongs in here: the fingerprints outlive the commitments they
    // were spent on, so without it the second rehearsal of the photo beat gets
    // "you already sent me that exact photo" and the stake never releases.
    for (const prefix of ['workout:', 'commitment:', 'trace:', 'proof:', ALARM_RANGE_START]) {
      const keys = await this.ctx.storage.list({ prefix });
      for (const key of keys.keys()) await this.ctx.storage.delete(key);
    }
    await this.ctx.storage.delete(KEY.traceSeq);

    // Clearing ALARM_RANGE_START took the morning check-in with it, and rearm()
    // only points the alarm at what is left. Re-book it, or the proactive beat
    // is dead on a seeded account.
    await this.scheduleMorning(profile, 0);
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

    // Yesterday: committed, skipped, money gone. This is what makes the agent
    // able to say "you said that yesterday".
    const yesterdayDue = localTimeToInstant(now, tz, 19, 0, -1);
    const missed: StoredCommitment = {
      id: 'c_seed_yesterday',
      text: 'gym at 7',
      dueAt: new Date(yesterdayDue).toISOString(),
      graceMin: DEFAULT_GRACE_MIN,
      status: 'missed',
      stake: { lamports: 50_000_000, status: 'slashed', txSig: null },
      reschedules: [],
      // No pic yesterday and nothing on the watch either — which is exactly
      // why the money went. The agent reads this back as "you said that
      // yesterday".
      proof: null,
      verifiedBy: null,
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
      { at: endOfLocalDay(yesterdayDue, tz), kind: 'stake_slashed', summary: `${solText(50_000_000)} gone` },
    ]);

    return ok({ workouts: workoutDays.length, commitments: 1 });
  }

  /**
   * Stands this user down for good: everything stored is dropped and the alarm
   * is disarmed.
   *
   * "reset app" used to be a phone-only affair — it threw away the token and
   * went back to onboarding, and the agent on this side carried on. Its alarms
   * still fired, so the thread kept getting texts about a commitment made
   * before the reset, and the chat stayed bound to a user the phone had
   * forgotten. Whoever resets is starting over; this is the other half of it.
   *
   * Returns what the chat was bound to, because unbinding lives in the
   * directory and only the Worker talks to that.
   */
  async forget(
    token: string,
  ): Promise<DoResult<{ channel: ChannelName | null; chatId: string | null; linkCode: string }>> {
    const auth = await this.authenticate(token);
    if (!auth.ok) return auth;

    const link = await this.ctx.storage.get<Link>(KEY.link);
    const released = {
      channel: link?.channel ?? null,
      chatId: link?.chatId ?? null,
      linkCode: link?.linkCode ?? '',
    };

    // deleteAll covers the profile and the token too, so the next request with
    // this token is a clean 401 rather than a half-erased user.
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();

    return ok(released);
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
      const topUp = USER_FUNDING_LAMPORTS - balance;
      const treasury = await walletFromSeed(treasurySeed);
      const txSig = await transferSol(rpc, treasury, wallet.address as never, topUp);
      await this.ctx.storage.put(KEY.wallet, { ...wallet, funded: true });
      this.balanceCache = null;
      await this.recordWalletEntry({
        kind: 'funded',
        lamports: topUp,
        label: 'starting balance from snap',
        txSig,
      });
    });
  }

  // --- wallet --------------------------------------------------------------

  /**
   * What the app's wallet screen draws.
   *
   * Two numbers, because they are two different things and conflating them is
   * how "where did my money go" happens: `balanceLamports` is what is actually
   * in the user's wallet on devnet, and `heldLamports` is what has already
   * left it for escrow against an open commitment or a competition entry.
   */
  async getWallet(token: string): Promise<DoResult<WalletResponse>> {
    await this.loadClock();
    const auth = await this.authenticate(token);
    if (!auth.ok) return auth;
    return ok(await this.walletView());
  }

  /**
   * Puts money in. On devnet that is a transfer from Snap's treasury — there
   * is nothing to charge a card for, and the public faucet rate-limits hard
   * enough that a demo cannot depend on it (see fundUserWallet).
   *
   * Real money is the production path and nothing above this line changes
   * when it arrives: the app asks for an amount, the wallet gets it, and the
   * stake comes out of the same balance.
   */
  async topUpWallet(token: string, lamports: number): Promise<DoResult<TopUpResponse>> {
    await this.loadClock();
    const auth = await this.authenticate(token);
    if (!auth.ok) return auth;

    if (!Number.isInteger(lamports) || lamports < MIN_TOPUP_LAMPORTS || lamports > MAX_TOPUP_LAMPORTS) {
      return fail(400, 'bad_request', 'top up between 0.01 and 1 SOL at a time');
    }

    const treasurySeed = this.env.SNAP_TREASURY_SEED;
    if (!treasurySeed) {
      return fail(503, 'chain_unavailable', 'no treasury configured — nothing can be topped up');
    }

    const wallet = await this.userWallet();
    const balance = await this.balance(true);
    if (balance !== null && balance + lamports > WALLET_CEILING_LAMPORTS) {
      return fail(400, 'bad_request', 'that would put the wallet over its 2 SOL ceiling');
    }

    const txSig = await this.onChain('top up', async () => {
      const treasury = await walletFromSeed(treasurySeed);
      return transferSol(this.rpc(), treasury, wallet.address as never, lamports);
    });

    if (!txSig) {
      // The money did not move. Saying it did, and then showing an unchanged
      // balance a second later, is worse than a plain no.
      return fail(503, 'chain_unavailable', 'devnet would not take the transfer — try again');
    }

    this.balanceCache = null;
    await this.ctx.storage.put(KEY.wallet, { ...wallet, funded: true });
    await this.recordWalletEntry({
      kind: 'funded',
      lamports,
      label: 'you added money',
      txSig,
    });
    await this.appendTraces([
      {
        kind: 'wallet_funded',
        summary: `${solText(lamports)} added to your wallet`,
        data: { txSig, explorer: explorerUrl(txSig) },
      },
    ]);

    const view = await this.walletView();
    return ok({ ...view, addedLamports: lamports, txSig });
  }

  private async walletView(): Promise<WalletResponse> {
    const wallet = await this.userWallet();
    const [balance, held, entries] = await Promise.all([
      this.balance(),
      this.heldLamports(),
      this.walletEntries(),
    ]);
    return {
      address: wallet.address,
      cluster: 'devnet',
      balanceLamports: balance,
      heldLamports: held,
      funded: wallet.funded,
      entries,
    };
  }

  /** Everything that has left this wallet and not come back yet. */
  private async heldLamports(): Promise<number> {
    const [commitments, competitions] = await Promise.all([
      this.loadCommitments(),
      this.ctx.storage.list<CompetitionEntry>({ prefix: 'competition:' }),
    ]);
    let held = 0;
    for (const commitment of commitments) {
      if (commitment.stake.status === 'held') held += commitment.stake.lamports;
    }
    for (const entry of competitions.values()) {
      if (entry.status === 'entered') held += entry.stakeLamports;
    }
    return held;
  }

  private async walletEntries(): Promise<WalletEntry[]> {
    const stored = await this.ctx.storage.list<WalletEntry>({
      prefix: WALLET_ENTRY_PREFIX,
      reverse: true,
      limit: WALLET_ENTRY_LIMIT,
    });
    return [...stored.values()];
  }

  /**
   * The on-chain balance, or null when devnet could not be reached. Null is
   * not zero: the app shows "can't reach the chain" for one and an empty
   * wallet for the other, and they are very different sentences to read
   * under a stake.
   */
  private async balance(fresh = false): Promise<number | null> {
    const cached = this.balanceCache;
    if (!fresh && cached && Date.now() - cached.at < BALANCE_CACHE_MS) return cached.lamports;

    const wallet = await this.userWallet();
    const lamports = await this.onChain('balance', async () =>
      getBalanceLamports(this.rpc(), wallet.address as never),
    );
    if (lamports === null) return cached?.lamports ?? null;

    this.balanceCache = { lamports, at: Date.now() };
    return lamports;
  }

  /**
   * Whether the wallet can cover a stake of this size, leaving the fees the
   * release transfer will need. `true` when the chain could not be reached:
   * a devnet hiccup must not be able to tell a user they are broke.
   */
  private async canCover(lamports: number): Promise<boolean> {
    const balance = await this.balance();
    if (balance === null) return true;
    return balance >= lamports + FEE_HEADROOM_LAMPORTS;
  }

  private async recordWalletEntry(entry: Omit<WalletEntry, 'id' | 'at'> & { ref?: string }): Promise<void> {
    const seq = ((await this.ctx.storage.get<number>(KEY.walletSeq)) ?? 0) + 1;
    await this.ctx.storage.put({
      [KEY.walletSeq]: seq,
      [KEY.walletEntry(seq)]: { ...entry, id: seq, at: this.nowIso() },
    });
  }

  /**
   * Hangs the signature on an entry once the chain confirms it, which is
   * seconds after the money is recorded as moved. Scans the recent entries
   * rather than keying by reference: the ledger is short by construction and
   * one linear pass is cheaper than a second index to keep in sync.
   */
  private async attachWalletTx(ref: string, kind: WalletEntry['kind'], txSig: string): Promise<void> {
    const stored = await this.ctx.storage.list<WalletEntry & { ref?: string }>({
      prefix: WALLET_ENTRY_PREFIX,
      reverse: true,
      limit: WALLET_ENTRY_LIMIT,
    });
    for (const [key, entry] of stored) {
      if (entry.ref === ref && entry.kind === kind && !entry.txSig) {
        await this.ctx.storage.put(key, { ...entry, txSig });
        return;
      }
    }
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
      return transferSol(rpc, escrow, treasury.address, amount);
    });

    if (!signature) return;

    // Re-read: the agent may have moved on while the chain was confirming.
    const current = await this.commitment(commitmentId);
    if (!current) return;
    await this.ctx.storage.put(KEY.commitment(commitmentId), {
      ...current,
      stake: { ...current.stake, txSig: signature },
    } satisfies StoredCommitment);

    // The money actually moved, so whatever balance was cached is stale.
    this.balanceCache = null;
    await this.attachWalletTx(
      commitmentId,
      direction === 'stake' ? 'held' : direction === 'release' ? 'released' : 'slashed',
      signature,
    );

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

        // A verified photo settles the commitment the moment it lands, so
        // this is belt and braces — but nagging someone who has already sent
        // the picture is the one mistake this alarm must never make.
        if (commitment.proof) return;
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
          `you woke yourself up. "${commitment.text}" was due at ${clockOnly(parseIso(commitment.dueAt) ?? this.now(), profile.timezone)} and the ${commitment.graceMin} minute grace has passed with no pic from them. their ${solText(commitment.stake.lamports)} is still locked and you take it at end of day, not now. if you text, ask for the pic — that is how they get it back. decide whether to text them.`,
        );
        return;
      }

      case 'end_of_day': {
        const commitment = await this.commitment(scheduled.commitmentId);
        if (!commitment || (commitment.status !== 'pending' && commitment.status !== 'renegotiated')) return;

        const covering = commitment.proof
          ? null
          : findCoveringWorkout(
              await this.loadWorkouts(),
              parseIso(commitment.createdAt) ?? 0,
              this.endOfDayFor(commitment, profile),
            );
        const met = commitment.proof ? 'photo' : covering ? 'watch' : null;

        await this.appendTraces([
          {
            kind: 'alarm_fired',
            summary: met
              ? `end of day — ${commitment.text} was met`
              : `end of day — ${commitment.text} is unmet`,
            data: { commitmentId: commitment.id, kind: 'end_of_day', verifiedBy: met },
          },
        ]);
        // The clock and the two verifiers decide this, not the model. It used
        // to be asked to "decide", which meant a turn that chose the wrong
        // tool left a missed commitment sitting held and the demo's last beat
        // missing.
        if (met) {
          await this.settle(commitment, 'met', 'released', met);
          await this.announce(
            profile,
            met === 'photo'
              ? `end of day. "${commitment.text}" got done — they sent the pic — and you already gave them their ${solText(commitment.stake.lamports)} back. tell them.`
              : `end of day. they never sent a pic for "${commitment.text}", but their watch shows they trained anyway, so you gave them their ${solText(commitment.stake.lamports)} back. tell them, and tell them the pic is the quicker way.`,
          );
        } else {
          await this.settle(commitment, 'missed', 'slashed');
          await this.announce(
            profile,
            `end of day. no pic, nothing on their watch either, so "${commitment.text}" never happened and you just took their ${solText(commitment.stake.lamports)}. tell them straight — no lecture.`,
          );
        }
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
    await this.loadClock();
    const next = await this.ctx.storage.list<ScheduledAlarm>({
      start: ALARM_RANGE_START,
      end: 'alarm:~',
      limit: 1,
    });
    const first = [...next.values()][0];
    if (!first) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    // Wake-ups are stored on the agent's clock, which /debug/timewarp moves.
    // setAlarm takes real wall-clock time, and the two are the same thing only
    // while the offset is zero.
    //
    // The floor matters more than the conversion: an alarm set in the real
    // past fires immediately, finds nothing due on the warped clock, rearms to
    // the same past instant and fires again — a hot loop that never advances.
    // A backward warp is the obvious way in, and a demo operator resetting the
    // clock is exactly who would find it.
    const realAt = first.at - this.clockOffsetMs;
    await this.ctx.storage.setAlarm(Math.max(realAt, Date.now() + 1_000));
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
  async runAgent(
    instruction: string,
    /**
     * Whether a person just said something. The narrow offer and acceptance
     * passes only make sense as readings of a message — run on a turn a
     * workout or an alarm started, they read the instruction as if the user
     * had spoken, and Snap congratulates someone on a session and then offers
     * to stake the session they have just finished.
     */
    fromUser = false,
  ): Promise<DoResult<{ ran: boolean }>> {
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

    const standingOffer = await this.standingOffer();

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

    // Actions first, then the talking. The model writes its texts assuming
    // every tool it called will work, so a refusal has to be known BEFORE a
    // word is sent: a reschedule the guards threw out was being announced to
    // the user as "alright, push it to tomorrow then", and then the stake was
    // slashed on the original deadline anyway.
    const isTalking = (name: string) =>
      name === 'send_messages' || name === 'stay_quiet' || name === 'react';
    const executed: string[] = [];
    const refusals: string[] = [];

    for (const call of decision.toolCalls) {
      if (isTalking(call.name)) continue;
      if (await this.dispatch(call, profile, refusals)) executed.push(call.name);
    }

    if (refusals.length > 0) {
      // Whatever it was about to say is now wrong. Say the truth instead.
      await this.correct(brain, profile, instruction, refusals);
      executed.push('send_messages');
    } else {
      for (const call of decision.toolCalls) {
        if (!isTalking(call.name)) continue;
        if (await this.dispatch(call, profile)) executed.push(call.name);
      }
    }

    // With an offer on the table, the likeliest thing any reply means is yes
    // or no — and "did they agree?" against two options is a far easier call
    // than picking one of eight tools. This is the whole reason Snap offers
    // rather than waiting to be told an amount.
    if (fromUser && standingOffer && !executed.includes('accept_offer') && !executed.includes('create_commitment')) {
      if (await this.confirmAcceptance(brain, profile, instruction)) {
        executed.push('accept_offer');
      }
    }

    // Nothing on the table and nothing recorded: did they name a time we
    // missed? Measured against the deployed Worker, "7pm gym, $5 on it"
    // produced a commitment 0 times out of 4 on the Workers AI fallback, so
    // this second look exists. It can only ever OFFER — the backup path must
    // not be able to take money, only to ask.
    if (
      fromUser &&
      !standingOffer &&
      !executed.includes('offer_stake') &&
      !executed.includes('create_commitment') &&
      !executed.includes('accept_offer')
    ) {
      const open = (await this.loadCommitments()).filter(
        (c) => c.status === 'pending' || c.status === 'renegotiated',
      );
      if (open.length === 0) {
        if (await this.confirmOffer(brain, profile, instruction)) executed.push('offer_stake');
      }
    }

    // Some models emit one tool call per turn, so a commitment gets recorded
    // and the user hears nothing — which is the product failing silently.
    // Ask once more, with only the two talking tools available.
    // offer_stake carries its own words, so a turn that offered has spoken.
    // A tapback is an answer. Forcing a text on top of one is how a thread
    // ends up with a 👍 and then "👍" typed out underneath it.
    const spoke =
      executed.includes('send_messages') ||
      executed.includes('stay_quiet') ||
      executed.includes('react') ||
      executed.includes('offer_stake');

    if (!spoke) {
      // Creating a commitment or accepting an offer is a moment that demands
      // a reply: silence right after taking someone's money is the worst
      // possible turn to be quiet on, so stay_quiet is not offered here.
      const mustSpeak =
        executed.includes('create_commitment') || executed.includes('accept_offer');
      await this.followUp(brain, profile, instruction, executed, mustSpeak);
    }

    return ok({ ran: true });
  }

  /**
   * "Did they name a time to train?" — one question, two tools. Declining is
   * a first-class answer: "ill hit the gym later" must not become a stake.
   *
   * This offers; it never creates. A backup pass that could take money would
   * be a backup pass that takes money when it misreads someone.
   */
  private async confirmOffer(
    brain: Brain,
    profile: Profile,
    instruction: string,
  ): Promise<boolean> {
    const narrow = TOOLS.filter(
      (tool) => tool.function.name === 'offer_stake' || tool.function.name === 'stay_quiet',
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

if yes, call offer_stake with that hour on their clock.
if they named no time at all ("later", "tomorrow sometime", "i should go"),
call stay_quiet — a vague intention is not a session and is not worth offering on.`,
        tools: narrow,
      });

      const chose = decision.toolCalls.map((call) => call.name);
      await this.appendTraces([
        {
          kind: 'decision',
          summary: chose.includes('offer_stake')
            ? 'they named a time — offering'
            : `no time named — ${chose.join(' + ') || 'no answer'}`,
          data: { pass: 'offer', tools: chose, reasoning: decision.reasoning },
        },
      ]);

      for (const call of decision.toolCalls) {
        if (call.name !== 'offer_stake') continue;
        if (await this.dispatch(call, profile)) return true;
      }
    } catch (error) {
      await this.appendTraces([
        { kind: 'decision', summary: 'could not re-check for a commitment', data: { error: redact(String(error)) } },
      ]);
    }
    return false;
  }

  /**
   * "Did they just say yes?" — the easiest question the model is ever asked,
   * and the one the money turns on.
   *
   * Only reached when an offer is actually standing, and the guard checks
   * again that it is. A no is a first-class answer: hesitation is not
   * agreement, and "idk maybe" must not take anyone's money.
   */
  private async confirmAcceptance(
    brain: Brain,
    profile: Profile,
    instruction: string,
  ): Promise<boolean> {
    const quiet = TOOLS.filter((tool) => tool.function.name === 'stay_quiet');

    try {
      const context = await this.buildContext(profile);
      const decision = await brain.decide({
        system: SYSTEM_PROMPT,
        context: renderContext(context),
        instruction: `${instruction}

you offered them a stake and this is their answer. one question, nothing else:
did they agree to it?

"deal", "bet", "ok", "yes", "lets go", "im in" — that is a yes, call accept_offer.
"nah", "how much", "idk", "maybe later", or anything hesitant or asking a
question — that is not a yes. call stay_quiet. their money only moves on a
clear yes.`,
        tools: [ACCEPT_OFFER_TOOL, ...quiet],
      });

      const chose = decision.toolCalls.map((call) => call.name);
      await this.appendTraces([
        {
          kind: 'decision',
          summary: chose.includes('accept_offer')
            ? 'they said yes'
            : `not a yes — ${chose.join(' + ') || 'no answer'}`,
          data: { pass: 'accept', tools: chose, reasoning: decision.reasoning },
        },
      ]);

      for (const call of decision.toolCalls) {
        if (call.name !== 'accept_offer') continue;
        if (await this.dispatch(call, profile)) return true;
      }
    } catch (error) {
      await this.appendTraces([
        {
          kind: 'decision',
          summary: 'could not check whether they agreed',
          data: { error: redact(String(error)) },
        },
      ]);
    }
    return false;
  }

  /**
   * The backend said no. Tell them what actually happened.
   *
   * Without this the model's own texts went out unchanged, written on the
   * assumption that the tool it called had worked — so a refused reschedule
   * was announced as granted, and the stake was slashed on the original
   * deadline regardless. Guards that quietly disagree with what the user was
   * told are worse than no guards.
   */
  private async correct(
    brain: Brain,
    profile: Profile,
    instruction: string,
    refusals: string[],
  ): Promise<void> {
    const talking = TOOLS.filter((tool) => tool.function.name === 'send_messages');

    try {
      const context = await this.buildContext(profile);
      const decision = await brain.decide({
        system: SYSTEM_PROMPT,
        context: renderContext(context),
        instruction: `${instruction}

you tried to do this and the rules would not allow it:
${refusals.map((r) => `- ${r}`).join('\n')}

it did NOT happen. do not tell them it did, and do not apologise or explain
the rules to them. hold the line in your own voice — this is you saying no,
not a system rejecting them.`,
        tools: talking,
      });
      for (const call of decision.toolCalls) await this.dispatch(call, profile);
    } catch (error) {
      await this.appendTraces([
        {
          kind: 'decision',
          summary: 'could not tell them the answer was no',
          data: { error: redact(String(error)) },
        },
      ]);
    }
  }

  /**
   * The money has already moved. Say so.
   *
   * Settling is a fact — HealthKit saw the workout, or the day ended — not a
   * judgement, so it is not the model's to make. It only gets to do the
   * talking, and it does not get to stay quiet about someone's stake.
   */
  private async announce(profile: Profile, instruction: string): Promise<void> {
    const brain = this.brain();
    if (!brain) return;
    await this.followUp(brain, profile, instruction, [], true);
  }

  /** Second pass: you acted, now say something — or justify not saying it. */
  private async followUp(
    brain: Brain,
    profile: Profile,
    instruction: string,
    executed: string[],
    mustSpeak = false,
  ): Promise<void> {
    const did = executed.length ? `you just called: ${executed.join(', ')}.` : 'you did nothing yet.';
    const talking = TOOLS.filter(
      (tool) =>
        tool.function.name === 'send_messages' ||
        (!mustSpeak && tool.function.name === 'stay_quiet'),
    );

    try {
      const context = await this.buildContext(profile);
      const decision = await brain.decide({
        system: SYSTEM_PROMPT,
        context: renderContext(context),
        instruction: mustSpeak
          ? `${instruction}\n\n${did} text them about it now, in your voice. saying nothing is not an option here — their money is on the line and they need to hear it from you.`
          : `${instruction}\n\n${did} now text them about it, in your voice. if silence is genuinely right, call stay_quiet instead.`,
        tools: talking,
      });
      for (const call of decision.toolCalls) await this.dispatch(call, profile);
    } catch (error) {
      await this.appendTraces([
        { kind: 'decision', summary: 'could not reach the brain for a reply', data: { error: redact(String(error)) } },
      ]);
    }
  }

  /**
   * Locks the money and starts the clock. Reached two ways — the user named
   * an amount themselves, or they said yes to one Snap offered — and it has
   * to be identical either way, because the stake is real from here on.
   */
  private async startCommitment(
    proposal: { text: string; dueAt: string; lamports: number },
    profile: Profile,
    now: number,
  ): Promise<StoredCommitment> {
    const commitment: StoredCommitment = {
      id: `c_${crypto.randomUUID().slice(0, 8)}`,
      text: proposal.text,
      dueAt: proposal.dueAt,
      graceMin: DEFAULT_GRACE_MIN,
      status: 'pending',
      stake: { lamports: proposal.lamports, status: 'held', txSig: null },
      reschedules: [],
      proof: null,
      verifiedBy: null,
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

    await this.recordWalletEntry({
      kind: 'held',
      lamports: commitment.stake.lamports,
      label: commitment.text,
      txSig: null,
      ref: commitment.id,
    });

    // Confirming on devnet takes seconds. The commitment is already real and
    // Snap can already text about it; the signature catches up.
    this.ctx.waitUntil(this.moveStake(commitment.id, 'stake'));
    return commitment;
  }

  /**
   * Why a stake cannot be taken, in words the correction pass can turn into a
   * text. It names the number on purpose: "you're broke" is a joke, "you have
   * 0.01 and this needs 0.05" is something the user can act on.
   */
  private async brokeReason(lamports: number): Promise<string> {
    const balance = await this.balance();
    const have = balance === null ? 'nothing spendable' : solText(balance);
    return `their wallet holds ${have} and this stake needs ${solText(lamports)} — they have to add sol in the app first, so nothing was locked`;
  }

  /** Runs one proposed tool call, or records why it was refused. */
  private async dispatch(
    call: ToolCall,
    profile: Profile,
    refusals?: string[],
  ): Promise<boolean> {
    const now = this.now();
    const commitments = await this.loadCommitments();
    const open = commitments.filter((c) => c.status === 'pending' || c.status === 'renegotiated');

    // The arguments go in the trace too: a refusal you cannot see the input
    // for is a dead end when the model starts doing something new.
    const refuse = async (reason: string): Promise<boolean> => {
      refusals?.push(`${call.name}: ${reason}`);
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
        if (!(await this.canCover(guard.value.lamports))) {
          return refuse(await this.brokeReason(guard.value.lamports));
        }

        // Naming an amount outright is itself agreement, so nothing is being
        // taken unasked — but any standing offer is now moot.
        await this.ctx.storage.delete(KEY.offer);
        await this.startCommitment(guard.value, profile, now);
        return true;
      }

      case 'offer_stake': {
        const guard = guardOffer(call.arguments, now, profile.timezone, open.map(toWireCommitment));
        if (!guard.ok) return refuse(guard.reason);
        // Offering money they do not have ends with "deal" and no stake, which
        // is the one outcome worse than not offering at all.
        if (!(await this.canCover(guard.value.lamports))) {
          return refuse(await this.brokeReason(guard.value.lamports));
        }

        // Nothing is locked and nothing moves. The only effect is that a yes
        // now means something — which is the whole point of asking first.
        const offer: StandingOffer = {
          text: guard.value.text,
          dueAt: guard.value.dueAt,
          lamports: guard.value.lamports,
          offeredAt: this.nowIso(),
        };
        await this.ctx.storage.put(KEY.offer, offer);

        await this.appendTraces([
          {
            kind: 'decision',
            summary: `offered ${solText(offer.lamports)} on ${offer.text} — waiting on a yes`,
            data: { dueAt: offer.dueAt, lamports: offer.lamports },
          },
        ]);

        // The offer and the words that make it are one action. Left to a
        // follow-up pass this was intermittently silent — the model had
        // "just offered" and reasoned itself into staying quiet, so the
        // stake was on the table and the user never heard about it.
        const link = await this.ctx.storage.get<Link>(KEY.link);
        const spoken = guardMessages(call.arguments, link?.linked ?? false, link?.optedOut ?? false);
        if (spoken.ok) await this.sendTexts(spoken.value);
        else await refuse(`offer_stake could not be spoken — ${spoken.reason}`);
        return true;
      }

      case 'accept_offer': {
        const offer = (await this.ctx.storage.get<StandingOffer>(KEY.offer)) ?? null;
        const guard = guardAccept(offer, now, open.map(toWireCommitment));
        if (!guard.ok) return refuse(guard.reason);
        if (!(await this.canCover(guard.value.lamports))) {
          return refuse(await this.brokeReason(guard.value.lamports));
        }

        // One offer, one acceptance: drop it before creating anything, so a
        // repeated yes cannot stake twice.
        await this.ctx.storage.delete(KEY.offer);
        await this.startCommitment(guard.value, profile, now);
        return true;
      }

      case 'reschedule_commitment': {
        const id = String(call.arguments.commitmentId ?? '');
        const existing = commitments.find((c) => c.id === id) ?? null;
        const guard = guardReschedule(
          call.arguments,
          existing && { ...toWireCommitment(existing), renegotiations: rescheduleCount(existing) },
          now,
          profile.timezone,
          this.endOfDayFor(existing, profile),
        );
        if (!guard.ok || !existing) return refuse(guard.ok ? 'no such commitment' : guard.reason);

        const moved: StoredCommitment = {
          ...existing,
          dueAt: guard.value.dueAt,
          status: 'renegotiated',
          // Both: the log is the record, the counter keeps working for
          // anything still reading it.
          reschedules: [
            ...(existing.reschedules ?? []),
            { at: this.nowIso(), from: existing.dueAt, to: guard.value.dueAt },
          ],
          renegotiations: rescheduleCount(existing) + 1,
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

      case 'react': {
        const name = toReaction(call.arguments.reaction);
        if (!name) return refuse('that is not one of the six tapbacks');
        if (!(await this.sendReaction(name))) return refuse('no chat is linked yet — nothing to react to');
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
    /**
     * Which verifier closed it. The photo is the one Snap asks for and talks
     * about; the watch is the fallback that pays people who trained and
     * forgot, and the app says which so nobody has to guess why their money
     * came back.
     */
    verifiedBy: 'photo' | 'watch' | null = null,
  ): Promise<void> {
    await this.ctx.storage.put(KEY.commitment(commitment.id), {
      ...commitment,
      status,
      verifiedBy,
      stake: { ...commitment.stake, status: stake },
    } satisfies StoredCommitment);

    // Settled: nothing left to wake up about.
    await this.unschedule('grace', commitment.id);
    await this.unschedule('end_of_day', commitment.id);
    await this.rearm();

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

    await this.recordWalletEntry({
      kind: stake,
      lamports: commitment.stake.lamports,
      label: commitment.text,
      txSig: null,
      ref: commitment.id,
    });

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
      workoutsThisWeek: countVerifiedThisWeek(now, profile.timezone, workouts, commitments),
      lastSevenDays: buildDays(now, profile.timezone, workouts, commitments.map(toWireCommitment)),
      openCommitments: commitments
        .filter((c) => c.status === 'pending' || c.status === 'renegotiated')
        .map((c) => ({ ...toWireCommitment(c), renegotiations: rescheduleCount(c) })),
      standingOffer: await this.standingOffer(),
      movesThisWeek: countMovesThisWeek(now, profile.timezone, commitments),
      wallet: { balanceLamports: await this.balance(), heldLamports: await this.heldLamports() },
      recentMessages: recentMessages([...events.values()]),
    };
  }

  /**
   * The offer on the table, if it is still answerable. A session whose time
   * has passed is not something anyone can still say yes to, so it stops
   * being shown rather than tempting the model to accept it.
   */
  private async standingOffer(): Promise<StandingOffer | null> {
    const offer = (await this.ctx.storage.get<StandingOffer>(KEY.offer)) ?? null;
    if (!offer) return null;
    const dueAt = parseIso(offer.dueAt);
    if (dueAt === null || dueAt <= this.now()) return null;
    return offer;
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
    reschedules: (stored.reschedules ?? []).map((move) => ({
      at: move.at,
      from: move.from,
      to: move.to,
    })),
    proof: stored.proof
      ? { at: stored.proof.at, description: stored.proof.description }
      : null,
    verifiedBy: stored.verifiedBy ?? null,
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
