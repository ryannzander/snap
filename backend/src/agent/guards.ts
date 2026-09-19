/**
 * Model proposes, backend disposes.
 *
 * Every tool call the model makes passes through here first. Testing Workers
 * AI against the real tools showed it slashing a stake at the grace mark and
 * again in response to an excuse, and converting "gym at 7" in Toronto to 3am
 * the next day. A better model makes that rarer, not impossible, and this is
 * money — so the rules live in code and the model only proposes.
 *
 * Pure functions: no storage, no clock of their own, so they are testable.
 */

import type { Commitment } from '../types';
import { localTimeToInstant, parseIso } from '../time';
import { DEFAULT_STAKE_LAMPORTS, MAX_RENEGOTIATIONS } from './tools';

export type Guard<T> = { ok: true; value: T } | { ok: false; reason: string };

const deny = (reason: string): Guard<never> => ({ ok: false, reason });
const allow = <T>(value: T): Guard<T> => ({ ok: true, value });

/**
 * Models emit numbers as strings often enough that rejecting "19" would be
 * rejecting a correct answer over its JSON type.
 */
function coerceNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function coerceInt(value: unknown): number | null {
  const parsed = coerceNumber(value);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
}

/** A stake below this is not worth a transaction; above it is a fat finger. */
const MIN_STAKE_LAMPORTS = 1_000_000; // 0.001 SOL
const MAX_STAKE_LAMPORTS = 1_000_000_000; // 1 SOL

const MAX_TEXTS = 5;
const MAX_TEXT_LENGTH = 300;

/**
 * How long a workout must run to count, and which HealthKit types qualify.
 *
 * 30 minutes is Ryan's call. The floor is inclusive: a workout of exactly 30
 * minutes counts, so the seeded 30-minute run still does.
 *
 * The type filter is still open — any type qualifies, so a 30-minute walk
 * closes a gym commitment. Set ACCEPTED_WORKOUT_TYPES to a list of
 * HKWorkoutActivityType case names to narrow it.
 */
export const MIN_WORKOUT_SEC = 30 * 60;

/**
 * HKWorkoutActivityType case names that count, matching what WorkoutSync
 * sends. Set to null to accept anything.
 *
 * The line is training, not activity. `walking` is the one that had to go —
 * thirty minutes of walking is a Tuesday, not a workout, and it is the first
 * thing anyone would try to release a stake with. `hiking`, `yoga` and
 * `pilates` are real exercise but are not what "gym at 7" means, and
 * `other` covers anything unmapped, which is exactly where a fake would hide.
 *
 * DEMO: whatever gets started on the Watch on stage has to be in this list.
 * "Traditional Strength Training" and "Functional Strength Training" both
 * are; anything exotic arrives as `other` and will not release the stake.
 */
export const ACCEPTED_WORKOUT_TYPES: readonly string[] | null = [
  'traditionalStrengthTraining',
  'functionalStrengthTraining',
  'coreTraining',
  'crossTraining',
  'highIntensityIntervalTraining',
  'running',
  'cycling',
  'rowing',
  'elliptical',
  'stairClimbing',
  'swimming',
  'mixedCardio',
];

export interface WorkoutWindow {
  start: string;
  end: string | null;
  durationSec: number;
  type: string;
  wasUserEntered?: boolean;
}

export interface CreateArgs {
  text: string;
  dueAt: string;
  lamports?: unknown;
}

export interface CreatedCommitment {
  text: string;
  dueAt: string;
  lamports: number;
}

/**
 * Reads the local wall-clock time the model named and converts it here.
 * The model is never asked to do timezone maths: given "gym at 7" in Toronto
 * it produced 3am the next day once and 3pm another time.
 *
 * A time that has already passed today means the next one — someone saying
 * "gym at 7" at 9pm means tomorrow morning.
 */
export function resolveLocalTime(
  args: Record<string, unknown>,
  now: number,
  tz: string,
): Guard<number> {
  const hour = coerceInt(args.hour);
  if (hour === null || hour < 0 || hour > 23) {
    return deny('hour must be a whole number 0-23 in the user\'s local time');
  }
  let minute = 0;
  if (args.minute !== undefined && args.minute !== null) {
    const parsed = coerceInt(args.minute);
    if (parsed === null || parsed < 0 || parsed > 59) return deny('minute must be a whole number 0-59');
    minute = parsed;
  }

  let instant = localTimeToInstant(now, tz, hour, minute);
  if (instant <= now) instant = localTimeToInstant(now, tz, hour, minute, 1);
  return allow(instant);
}

export function guardCreate(
  args: Record<string, unknown>,
  now: number,
  tz: string,
  openCommitments: Commitment[],
): Guard<CreatedCommitment> {
  const text = typeof args.text === 'string' ? args.text.trim() : '';
  if (!text) return deny('create_commitment needs the commitment in the user\'s words');
  if (text.length > 200) return deny('commitment text is too long');

  const resolved = resolveLocalTime(args, now, tz);
  if (!resolved.ok) return resolved;
  const dueAt = resolved.value;

  // The iOS screen shows a single open commitment, and two live stakes at once
  // is not a loop anyone asked for.
  if (openCommitments.length > 0) {
    return deny(`there is already an open commitment (${openCommitments[0]!.id})`);
  }

  // The stake arrives in SOL, not lamports: asked for lamports the model
  // invented an exchange rate and turned "$5" into 0.15 SOL.
  let lamports = DEFAULT_STAKE_LAMPORTS;
  if (args.sol !== undefined && args.sol !== null) {
    const sol = coerceNumber(args.sol);
    if (sol === null) return deny('sol must be a number');
    lamports = Math.round(sol * 1_000_000_000);
    if (lamports < MIN_STAKE_LAMPORTS) return deny('stake is too small to be worth locking');
    if (lamports > MAX_STAKE_LAMPORTS) return deny('stake is above the 1 SOL ceiling');
  }

  return allow({ text, dueAt: new Date(dueAt).toISOString(), lamports });
}

export function guardReschedule(
  args: Record<string, unknown>,
  commitment: (Commitment & { renegotiations: number }) | null,
  now: number,
  tz: string,
  endOfDay: number,
): Guard<{ dueAt: string; reason: string }> {
  if (!commitment) return deny('no such commitment');
  if (commitment.status !== 'pending' && commitment.status !== 'renegotiated') {
    return deny(`commitment is ${commitment.status} — it cannot be moved`);
  }
  // DESIGN.md: at most one renegotiation per commitment. This is the rule the
  // agent is supposed to hold the line on, so it is not the agent's to bend.
  if (commitment.renegotiations >= MAX_RENEGOTIATIONS) {
    return deny('this commitment has already been rescheduled once — that is the limit');
  }

  const resolved = resolveLocalTime(args, now, tz);
  if (!resolved.ok) return resolved;
  const dueAt = resolved.value;
  // Same stake, new deadline — but the slash still lands at end of day, so a
  // reschedule past midnight would move the goalposts past the consequence.
  if (dueAt > endOfDay) return deny('the new deadline is after end of day');

  const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
  if (!reason) return deny('reschedule_commitment needs a reason for the trace');

  return allow({ dueAt: new Date(dueAt).toISOString(), reason });
}

export function guardMessages(
  args: Record<string, unknown>,
  linked: boolean,
  optedOut: boolean,
): Guard<string[]> {
  if (!linked) return deny('no chat is linked yet — nothing to send to');
  if (optedOut) return deny('the user opted out; nothing may be sent');

  if (!Array.isArray(args.texts)) return deny('texts must be an array');
  const texts: string[] = [];
  for (const entry of args.texts) {
    if (typeof entry !== 'string') return deny('every text must be a string');
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (trimmed.length > MAX_TEXT_LENGTH) {
      return deny('that is a paragraph, not a text — keep them short');
    }
    texts.push(trimmed);
  }
  if (texts.length === 0) return deny('no non-empty texts');
  if (texts.length > MAX_TEXTS) return deny(`at most ${MAX_TEXTS} texts in one burst`);

  return allow(texts);
}

/**
 * How a missed stake is divided: half back to the user, half forfeited.
 *
 * A total forfeit reads as a bet, and the first question a judge asks is
 * whether this is gambling. Half back is the answer to that question, and it
 * is also the kinder product — missing one session should sting, not punish.
 *
 * An odd lamport goes back to the user rather than being forfeited, so the two
 * halves always add up to exactly what was staked and nothing is stranded.
 */
export function splitSlash(lamports: number): { refunded: number; forfeited: number } {
  const forfeited = Math.floor(lamports / 2);
  return { refunded: lamports - forfeited, forfeited };
}

/**
 * Why a workout cannot release a stake, or null if it can. Display-ready:
 * the trace shows this so a workout that does not count says so on the brain
 * screen instead of just being missing.
 */
export function disqualification(workout: WorkoutWindow): string | null {
  if (workout.wasUserEntered) return 'typed in by hand';
  if (ACCEPTED_WORKOUT_TYPES && !ACCEPTED_WORKOUT_TYPES.includes(workout.type)) {
    return "doesn't count as training";
  }
  if (workout.durationSec < MIN_WORKOUT_SEC) {
    return `under ${MIN_WORKOUT_SEC / 60} min`;
  }
  return null;
}

/** Does a workout actually cover this commitment? HealthKit decides, not the model. */
export function findCoveringWorkout(
  workouts: WorkoutWindow[],
  windowStart: number,
  windowEnd: number,
): WorkoutWindow | null {
  for (const workout of workouts) {
    // API.md: a workout typed into the Health app must never release a stake.
    // Anyone can open Health -> Workouts -> Add Data and invent one, and
    // "Snap knows rather than asks" has to survive a judge trying exactly
    // that. Stored either way, so the trace can say why it was ignored.
    if (workout.wasUserEntered) continue;
    if (workout.durationSec < MIN_WORKOUT_SEC) continue;
    if (ACCEPTED_WORKOUT_TYPES && !ACCEPTED_WORKOUT_TYPES.includes(workout.type)) continue;

    const start = parseIso(workout.start);
    if (start === null) continue;
    const end = workout.end === null ? start + workout.durationSec * 1000 : parseIso(workout.end);
    if (end === null) continue;

    // Any overlap with the window counts — training that began before the
    // deadline and ran past it is still the workout they promised.
    if (end >= windowStart && start <= windowEnd) return workout;
  }
  return null;
}

export function guardRelease(
  commitment: Commitment | null,
  covering: WorkoutWindow | null,
): Guard<WorkoutWindow> {
  if (!commitment) return deny('no such commitment');
  if (commitment.stake.status !== 'held') {
    return deny(`stake is ${commitment.stake.status}, not held`);
  }
  // The whole product claim is that Snap knows rather than asks. Releasing on
  // the model's say-so would make that a lie.
  if (!covering) return deny('no workout covers this commitment yet');
  return allow(covering);
}

export function guardSlash(
  commitment: (Commitment & { renegotiations: number }) | null,
  now: number,
  endOfDay: number,
  covering: WorkoutWindow | null,
): Guard<{ deadline: number }> {
  if (!commitment) return deny('no such commitment');
  if (commitment.stake.status !== 'held') {
    return deny(`stake is ${commitment.stake.status}, not held`);
  }
  if (covering) return deny('a workout covers this commitment — it cannot be slashed');

  const dueAt = parseIso(commitment.dueAt);
  if (dueAt === null) return deny('commitment has an unreadable dueAt');

  // DESIGN.md: the grace mark is a warning. The money moves at end of day, or
  // at the deadline they renegotiated to. This is the guard that matters most:
  // both models under test tried to slash at grace.
  const deadline = commitment.status === 'renegotiated' ? dueAt : endOfDay;
  if (now < deadline) {
    return deny(
      commitment.status === 'renegotiated'
        ? 'the renegotiated deadline has not passed yet — warn, do not slash'
        : 'it is not end of day yet — the grace mark is a warning, not a slash',
    );
  }

  return allow({ deadline });
}
