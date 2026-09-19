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
import { parseIso } from '../time';
import { DEFAULT_STAKE_LAMPORTS, MAX_RENEGOTIATIONS } from './tools';

export type Guard<T> = { ok: true; value: T } | { ok: false; reason: string };

const deny = (reason: string): Guard<never> => ({ ok: false, reason });
const allow = <T>(value: T): Guard<T> => ({ ok: true, value });

/** A stake below this is not worth a transaction; above it is a fat finger. */
const MIN_STAKE_LAMPORTS = 1_000_000; // 0.001 SOL
const MAX_STAKE_LAMPORTS = 1_000_000_000; // 1 SOL

const MAX_TEXTS = 5;
const MAX_TEXT_LENGTH = 300;

/**
 * How long a workout must run to count, and which HealthKit types qualify.
 *
 * ASSUMPTION, pending Hugo's call: 15 minutes, any type. ROADMAP.md refers to
 * "the same duration floor and workout-type filter as the core loop" as if
 * these were already decided; they are not. A 3-minute walk releasing a gym
 * stake is the first thing a judge would try.
 */
export const MIN_WORKOUT_SEC = 15 * 60;
export const ACCEPTED_WORKOUT_TYPES: readonly string[] | null = null; // null = any

export interface WorkoutWindow {
  start: string;
  end: string | null;
  durationSec: number;
  type: string;
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

export function guardCreate(
  args: Record<string, unknown>,
  now: number,
  openCommitments: Commitment[],
): Guard<CreatedCommitment> {
  const text = typeof args.text === 'string' ? args.text.trim() : '';
  if (!text) return deny('create_commitment needs the commitment in the user\'s words');
  if (text.length > 200) return deny('commitment text is too long');

  const dueAt = typeof args.dueAt === 'string' ? parseIso(args.dueAt) : null;
  if (dueAt === null) return deny('dueAt is not an ISO 8601 timestamp');
  if (dueAt <= now) return deny('dueAt is in the past — a commitment must be ahead of now');

  // The iOS screen shows a single open commitment, and two live stakes at once
  // is not a loop anyone asked for.
  if (openCommitments.length > 0) {
    return deny(`there is already an open commitment (${openCommitments[0]!.id})`);
  }

  let lamports = DEFAULT_STAKE_LAMPORTS;
  if (args.lamports !== undefined && args.lamports !== null) {
    if (typeof args.lamports !== 'number' || !Number.isFinite(args.lamports)) {
      return deny('lamports must be a number');
    }
    lamports = Math.round(args.lamports);
    if (lamports < MIN_STAKE_LAMPORTS) return deny('stake is too small to be worth locking');
    if (lamports > MAX_STAKE_LAMPORTS) return deny('stake is above the 1 SOL ceiling');
  }

  return allow({ text, dueAt: new Date(dueAt).toISOString(), lamports });
}

export function guardReschedule(
  args: Record<string, unknown>,
  commitment: (Commitment & { renegotiations: number }) | null,
  now: number,
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

  const dueAt = typeof args.dueAt === 'string' ? parseIso(args.dueAt) : null;
  if (dueAt === null) return deny('dueAt is not an ISO 8601 timestamp');
  if (dueAt <= now) return deny('the new deadline is already in the past');
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

/** Does a workout actually cover this commitment? HealthKit decides, not the model. */
export function findCoveringWorkout(
  workouts: WorkoutWindow[],
  windowStart: number,
  windowEnd: number,
): WorkoutWindow | null {
  for (const workout of workouts) {
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
