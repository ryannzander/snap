/**
 * The context handed to the model on every turn (BACKEND_TASKS step 3):
 * goal, this week's count, last 7 days of hits and skips, open commitments
 * and their stakes, and the recent conversation.
 *
 * Pure functions over stored records so this is testable without a model.
 */

import { startOfWeek, tzOffsetMs, parseIso } from '../time';
import { disqualification } from './guards';
import { MAX_RENEGOTIATIONS } from './tools';
import { solText } from '../money';
import type { Commitment, TraceEvent } from '../types';

export interface DayRecord {
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  workouts: number;
  /** A commitment existed that day and was not met. */
  skipped: boolean;
}

export interface AgentContext {
  now: string;
  /** The user's wall clock, so the model never has to work it out. */
  localTime: string;
  timezone: string;
  name: string;
  weeklyGoal: number;
  workoutsThisWeek: number;
  lastSevenDays: DayRecord[];
  /**
   * Carries `renegotiations` on top of the wire shape: without it the model
   * could not tell whether the one allowed reschedule had been used, and
   * asserted to the user that it had when it had not.
   */
  openCommitments: Array<Commitment & { renegotiations: number }>;
  /** A stake Snap has proposed and the user has not answered yet. */
  standingOffer: { text: string; dueAt: string; lamports: number } | null;
  /**
   * What is actually in their wallet, so Snap can size an offer to it rather
   * than proposing a stake the guards will then refuse. `balanceLamports` is
   * null when devnet could not be reached — unknown, not empty.
   */
  wallet: { balanceLamports: number | null; heldLamports: number };
  recentMessages: Array<{ from: 'snap' | 'user'; text: string }>;
}

export interface WorkoutLike {
  start: string;
  durationSec: number;
  type: string;
  end: string | null;
  wasUserEntered?: boolean;
}

/**
 * The same bar as releasing a stake. If a 30-minute walk cannot release your
 * money it must not fill a goal dot either, or "2/4 this week" means one
 * thing to the user and another to the agent.
 */
function counts(workout: WorkoutLike): boolean {
  return disqualification(workout) === null;
}

/** Local YYYY-MM-DD for an instant, in the user's zone. */
export function localDate(instant: number, tz: string): string {
  return new Date(instant + tzOffsetMs(instant, tz)).toISOString().slice(0, 10);
}

export function buildDays(
  now: number,
  tz: string,
  workouts: WorkoutLike[],
  commitments: Commitment[],
  days = 7,
): DayRecord[] {
  const perDay = new Map<string, number>();
  for (const workout of workouts) {
    if (!counts(workout)) continue;
    const startedAt = parseIso(workout.start);
    if (startedAt === null) continue;
    const date = localDate(startedAt, tz);
    perDay.set(date, (perDay.get(date) ?? 0) + 1);
  }

  const missedDays = new Set<string>();
  for (const commitment of commitments) {
    if (commitment.status !== 'missed') continue;
    const dueAt = parseIso(commitment.dueAt);
    if (dueAt !== null) missedDays.add(localDate(dueAt, tz));
  }

  const out: DayRecord[] = [];
  for (let back = days - 1; back >= 0; back--) {
    const date = localDate(now - back * 86_400_000, tz);
    out.push({ date, workouts: perDay.get(date) ?? 0, skipped: missedDays.has(date) });
  }
  return out;
}

export function countThisWeek(now: number, tz: string, workouts: WorkoutLike[]): number {
  const weekStart = startOfWeek(now, tz);
  let count = 0;
  for (const workout of workouts) {
    if (!counts(workout)) continue;
    const startedAt = parseIso(workout.start);
    if (startedAt !== null && startedAt >= weekStart) count++;
  }
  return count;
}

/**
 * Pulls the conversation back out of the trace feed, newest last. The trace is
 * already the record of everything said, so there is no second message store
 * to keep in sync.
 */
export function recentMessages(
  events: TraceEvent[],
  limit = 20,
): Array<{ from: 'snap' | 'user'; text: string }> {
  const messages: Array<{ from: 'snap' | 'user'; text: string }> = [];
  for (const event of events) {
    if (event.kind === 'message_sent') messages.push({ from: 'snap', text: event.summary });
    else if (event.kind === 'message_received') messages.push({ from: 'user', text: event.summary });
  }
  return messages.slice(-limit);
}

/** Renders the context as the compact block the model reads. */
/**
 * An instant on the user's clock, e.g. "Sat 19:00".
 *
 * The model is never asked to do timezone maths on the way in — it names an
 * hour and the backend converts. This is the same rule on the way out, and it
 * was missing: deadlines were rendered as raw UTC, so at 19:25 local the model
 * read "due 2026-09-19T23:00:00Z", concluded the deadline was hours away, and
 * stayed quiet through the grace warning it had been woken up to send.
 */
function localStamp(iso: string, tz: string): string {
  const at = parseIso(iso);
  if (at === null) return iso;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(at));
}

export function renderContext(context: AgentContext): string {
  const days = context.lastSevenDays
    .map((day) => {
      const mark = day.workouts > 0 ? `${day.workouts}x` : day.skipped ? 'skipped' : '-';
      return `${day.date} ${mark}`;
    })
    .join('\n');

  const commitments = context.openCommitments.length
    ? context.openCommitments
        .map(
          (c) =>
            `- ${c.id} "${c.text}" due ${localStamp(c.dueAt, context.timezone)} their time (+${c.graceMin}m grace) · ${c.status} · stake ${c.stake.lamports} lamports ${c.stake.status} · reschedules used ${c.renegotiations}/${MAX_RENEGOTIATIONS}`,
        )
        .join('\n')
    : '- none';

  const conversation = context.recentMessages.length
    ? context.recentMessages.map((m) => `${m.from}: ${m.text}`).join('\n')
    : '(nothing yet)';

  const wallet =
    context.wallet.balanceLamports === null
      ? 'wallet: balance unknown right now — do not tell them how much they have'
      : `wallet: ${solText(context.wallet.balanceLamports)} spendable, ${solText(context.wallet.heldLamports)} already locked in stakes. they top it up in the app.`;

  return [
    `their local time right now: ${context.localTime} (${context.timezone})`,
    `user: ${context.name}`,
    `weekly goal: ${context.weeklyGoal}, done this week: ${context.workoutsThisWeek}`,
    wallet,
    '',
    'last 7 days:',
    days,
    '',
    'open commitments:',
    commitments,
    '',
    'stake you have offered and they have not answered:',
    context.standingOffer
      ? `- "${context.standingOffer.text}" due ${localStamp(context.standingOffer.dueAt, context.timezone)} their time · ${context.standingOffer.lamports} lamports · waiting on their yes`
      : '- none',
    '',
    'recent conversation:',
    conversation,
  ].join('\n');
}

/** One-line display summary for the `context` trace event. */
export function summarizeContext(context: AgentContext): string {
  const today = context.lastSevenDays.at(-1);
  const yesterday = context.lastSevenDays.at(-2);
  const parts = [
    today && today.workouts > 0 ? `${today.workouts} workout today` : 'no workout today',
  ];
  if (yesterday?.skipped) parts.push('skipped yesterday');
  else if (yesterday && yesterday.workouts > 0) parts.push('trained yesterday');
  parts.push(`${context.workoutsThisWeek}/${context.weeklyGoal} this week`);

  const staked = context.openCommitments
    .filter((c) => c.stake.status === 'held')
    .reduce((sum, c) => sum + c.stake.lamports, 0);
  if (staked > 0) parts.push(`${solText(staked)} staked`);
  else if (context.standingOffer) parts.push(`${solText(context.standingOffer.lamports)} offered, no answer yet`);

  return parts.join(' · ');
}
