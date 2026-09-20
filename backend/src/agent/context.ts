/**
 * The context handed to the model on every turn (BACKEND_TASKS step 3):
 * goal, this week's count, last 7 days of hits and skips, open commitments
 * and their stakes, and the recent conversation.
 *
 * Pure functions over stored records so this is testable without a model.
 */

import { startOfMonth, startOfWeek, startOfYear, tzOffsetMs, parseIso } from '../time';
import { disqualification } from './guards';
import { challengeById } from './challenge';
import { MAX_RENEGOTIATIONS, RESCHEDULE_LEAD_MS } from './tools';
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
  /**
   * The longer horizons, when the user set one. Snap is told about them and
   * told which one he is allowed to raise — see `renderContext`.
   */
  monthlyGoal?: number;
  yearlyGoal?: number;
  workoutsThisMonth: number;
  workoutsThisYear: number;
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
   * What goes on the line when the user names no amount — their intensity
   * dial's number, not a constant. The model has to be told it, because the
   * words it writes name an amount and the guard picks one independently: a
   * prompt that says "5 bucks of sol" while the backend locks 0.02 is Snap
   * promising a deal we do not honour.
   */
  defaultStakeLamports: number;
  /**
   * Days in a row, the same number the schedule screen puts at the top. Snap
   * only gets to mention it when it is worth mentioning — see `renderContext`.
   */
  streak: number;
  /**
   * The run that ended, when `streak` is 0. See `brokenStreak` — this is the
   * one worth saying out loud.
   */
  brokenStreak: number;
  /**
   * The session length they asked to be held to. A target Snap says out loud,
   * not a gate — a shorter session still releases the money.
   */
  targetMin: number;
  /**
   * How many sessions they have moved this week, across every commitment.
   * One is a Tuesday; four is the actual behaviour the stake is meant to
   * catch, and Snap can only call it out if he can see it.
   */
  movesThisWeek: number;
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
  /**
   * Active energy, excluding basal. Null when the source did not record it.
   *
   * Here because `disqualification` reads it: a shape that leaves it out
   * typechecks and then quietly skips the effort floor, so "2/4 this week"
   * would count a session the release path rejects. The bar has to be the
   * same bar, and the type is half of saying so.
   */
  activeKcal?: number | null;
}

/**
 * The same bar as releasing a stake. If a 30-minute walk cannot release your
 * money it must not fill a goal dot either, or "2/4 this week" means one
 * thing to the user and another to the agent.
 */
function counts(workout: WorkoutLike): boolean {
  return disqualification(workout) === null;
}

/**
 * Days in a row, counting back from today.
 *
 * Ported from `Streak.current` in `ios/Snap/Model/Models.swift`, rule for rule,
 * because the schedule screen shows this number and Snap says it out loud. Two
 * implementations of one number is how "2/4 this week" ends up meaning one
 * thing on the phone and another in the thread — this repo has paid for that
 * lesson twice already, so if his rule changes, change this one with it.
 *
 * Today with nothing logged yet does NOT break it: the day isn't over, and a
 * streak that resets at midnight and un-resets when you train is a number
 * nobody would trust. Today *skipped* does break it — a commitment that went
 * unmet is a day already decided, the money has moved, and only an undecided
 * day gets the benefit of the doubt.
 *
 * Capped by the window it is given. Thirty days of history cannot prove a
 * forty-day streak, and claiming one would be a lie we could not see.
 */
export function currentStreak(days: DayRecord[]): number {
  let run = 0;
  const last = days.at(-1);
  for (let i = days.length - 1; i >= 0; i--) {
    const day = days[i]!;
    if (day.workouts > 0) {
      run += 1;
    } else if (run === 0 && day.date === last?.date && !day.skipped) {
      continue;
    } else {
      break;
    }
  }
  return run;
}

/**
 * The run that just ended, when there is no run going.
 *
 * "You're on 3 days" is a stat. "You had 3 days going and you binned it
 * yesterday" is a thing a friend says, and it is the one that gets someone
 * back to the gym — the loss is worth more than the number, which is the same
 * reason the stake is allocated up front rather than paid out at the end.
 *
 * Zero whenever a streak is still alive, so the two can never both be talked
 * about, and zero for a run of one, because losing a single session is a
 * Tuesday and calling it a lost streak is how Snap starts sounding like an app.
 */
export function brokenStreak(days: DayRecord[]): number {
  if (currentStreak(days) > 0) return 0;

  let i = days.length - 1;
  while (i >= 0 && days[i]!.workouts === 0) i--;

  let run = 0;
  for (; i >= 0 && days[i]!.workouts > 0; i--) run++;
  return run >= 2 ? run : 0;
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

export function countThisWeek(
  now: number,
  tz: string,
  workouts: WorkoutLike[],
): number {
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
 * Sessions this week, by either verifier.
 *
 * The photo is what releases a stake now, so it has to fill a goal dot too —
 * the repo's rule is that the bar which returns your money and the bar which
 * moves "2/4" are the same bar, or the two numbers start disagreeing in front
 * of the user.
 *
 * A photo-verified session only adds a dot on a local day that has no
 * qualifying workout of its own. Someone who trains with a watch on AND sends
 * a picture did one session, and counting it twice would make the goal a lie
 * in the flattering direction.
 */
/**
 * The three horizons, counted off one set of workouts.
 *
 * Weekly is the one that drives behaviour and the one Snap talks about.
 * Monthly is what makes somebody sprint in the last week of a month. Yearly is
 * identity rather than pressure — it is the number that makes a streak feel
 * like it means something, and it is the one he should almost never bring up.
 */
export interface GoalProgress {
  week: number;
  month: number;
  year: number;
}

export function countProgress(
  now: number,
  tz: string,
  workouts: WorkoutLike[],
  commitments: Array<{ status: string; dueAt: string; proof?: { at: string } | null }>,
): GoalProgress {
  return {
    week: countVerifiedSince(startOfWeek(now, tz), tz, workouts, commitments),
    month: countVerifiedSince(startOfMonth(now, tz), tz, workouts, commitments),
    year: countVerifiedSince(startOfYear(now, tz), tz, workouts, commitments),
  };
}

export function countVerifiedThisWeek(
  now: number,
  tz: string,
  workouts: WorkoutLike[],
  commitments: Array<{ status: string; dueAt: string; proof?: { at: string } | null }>,
): number {
  return countVerifiedSince(startOfWeek(now, tz), tz, workouts, commitments);
}

/**
 * The same count over any window, so a month and a year cannot drift from a
 * week.
 *
 * Written once rather than three times on purpose. The rule that a
 * photo-verified session only adds a dot on a day with no qualifying workout
 * of its own is subtle, and three copies of it is three chances for "4/4 this
 * week" and "18/20 this month" to disagree about the same Tuesday.
 */
export function countVerifiedSince(
  since: number,
  tz: string,
  workouts: WorkoutLike[],
  commitments: Array<{ status: string; dueAt: string; proof?: { at: string } | null }>,
): number {
  const daysWithWorkouts = new Set<string>();
  let sessions = 0;
  for (const workout of workouts) {
    if (!counts(workout)) continue;
    const startedAt = parseIso(workout.start);
    if (startedAt === null || startedAt < since) continue;
    sessions += 1;
    daysWithWorkouts.add(localDate(startedAt, tz));
  }

  const photoDays = new Set<string>();
  for (const commitment of commitments) {
    if (commitment.status !== 'met' || !commitment.proof) continue;
    const at = parseIso(commitment.proof.at);
    if (at === null || at < since) continue;
    const day = localDate(at, tz);
    if (!daysWithWorkouts.has(day)) photoDays.add(day);
  }

  return sessions + photoDays.size;
}

/**
 * Sessions moved this week, across every commitment.
 *
 * Counted from the log rather than from the per-commitment limit: the limit
 * says whether THIS session can move again, and that is a different question
 * from whether this person moves all of them.
 */
export function countMovesThisWeek(
  now: number,
  tz: string,
  commitments: Array<{ reschedules?: Array<{ at: string }> }>,
): number {
  const weekStart = startOfWeek(now, tz);
  let moves = 0;
  for (const commitment of commitments) {
    for (const move of commitment.reschedules ?? []) {
      const at = parseIso(move.at);
      if (at !== null && at >= weekStart) moves++;
    }
  }
  return moves;
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
        .map((c) => {
          const moves = (c.reschedules ?? [])
            .map(
              (move) =>
                `moved ${localStamp(move.from, context.timezone)} → ${localStamp(move.to, context.timezone)}`,
            )
            .join('; ');
          // Whether the door is still open, said plainly.
          //
          // The row used to stop at "reschedules used 0/1", which does not
          // answer the question the user is actually asking at 18:50. The
          // model had to call reschedule_commitment and get refused to find
          // out, so the refusal beat only landed when it guessed wrong first.
          const due = parseIso(c.dueAt);
          const used = c.renegotiations >= MAX_RENEGOTIATIONS;
          // An unreadable deadline is a locked door, not an open one:
          // guardReschedule refuses it outright, and the alternative was
          // rendering `0 - an hour` as a 1969 timestamp and telling the user
          // they had until then.
          const tooLate = due === null || due - Date.parse(context.now) < RESCHEDULE_LEAD_MS;
          const door = used
            ? 'locked — they already used their move'
            : tooLate
              ? 'locked — under an hour left, it cannot be moved'
              : `can still be moved, but only until ${localStamp(
                  new Date(due - RESCHEDULE_LEAD_MS).toISOString(),
                  context.timezone,
                )} their time`;
          const ask = challengeById(c.challenge);
          return (
            `- ${c.id} "${c.text}" due ${localStamp(c.dueAt, context.timezone)} their time (+${c.graceMin}m grace) · ${c.status} · stake ${c.stake.lamports} lamports ${c.stake.status} · reschedules used ${c.renegotiations}/${MAX_RENEGOTIATIONS} · ${door}` +
            (ask ? ` · THE PIC FOR THIS ONE NEEDS ${ask.ask.toUpperCase()} — tell them, every time you ask for the pic` : '') +
            (moves ? ` · ${moves}` : '') +
            (c.proof ? ' · pic verified' : '')
          );
        })
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
    goalLine(context),
    `sessions moved this week: ${context.movesThisWeek}`,
    wallet,
    '',
    'last 7 days:',
    days,
    '',
    'open commitments:',
    commitments,
    '',
    `if you offer and they never named an amount, the stake is ${solText(context.defaultStakeLamports)} — use that number in your texts, it is the one that gets locked. they can name their own, the floor is 0.01 SOL`,
    context.streak >= 2
      ? `they are on a ${context.streak} day streak. it is the number on their home screen, so say THAT number or none. worth a mention when they finish one, and worth naming as something to lose when they are wobbling — never twice in a row, and never as a lecture.`
      : context.brokenStreak >= 2
        ? `they HAD a ${context.brokenStreak} day run going and it is gone. that is the thing to bring up when they are talking themselves out of today — not as a telling off, as a thing worth getting back. once, not every turn.`
        : 'no streak going right now. do not bring one up.',
    `they asked to be held to ${context.targetMin}-minute sessions. that is the number you hold them to out loud. it is NOT what decides the money — any session they actually turned up for pays out, even a short one. if they come in under it, say something and then pay them anyway.`,
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

/**
 * Which longer goal, if any, Snap is allowed to bring up right now.
 *
 * Three targets in his context is three things to nag about, and a gym bro who
 * recites your weekly, monthly and yearly numbers in one text is a dashboard
 * with a personality bolted on. So the rule is picked here, in code, rather
 * than left to him:
 *
 * The month only matters when there is still time to do something about it and
 * not much of it — the last ten days, and only if they are actually behind.
 * Ahead of pace is not news. The year is identity rather than pressure, so it
 * is only ever worth saying on the way past a round number.
 */
function goalLine(context: AgentContext): string {
  const { monthlyGoal, yearlyGoal, workoutsThisMonth, workoutsThisYear } = context;

  if (monthlyGoal !== undefined) {
    const day = Number(context.localTime.match(/\b(\d{1,2})\b/)?.[1] ?? 0);
    const left = monthlyGoal - workoutsThisMonth;
    const daysLeft = daysLeftInMonth(context);
    if (left > 0 && daysLeft <= 10 && left >= daysLeft / 2) {
      return `monthly goal: ${workoutsThisMonth}/${monthlyGoal} with ${daysLeft} days left in the month. they are behind and there is still time. worth ONE mention, not a countdown every turn. (${day || ''})`.trim();
    }
  }

  if (yearlyGoal !== undefined && workoutsThisYear > 0 && workoutsThisYear % 25 === 0) {
    return `they just hit ${workoutsThisYear} sessions this year, on the way to ${yearlyGoal}. say it once like a friend would — "that's ${workoutsThisYear} this year bro" — then drop it.`;
  }

  const set = [
    monthlyGoal !== undefined ? `month ${workoutsThisMonth}/${monthlyGoal}` : null,
    yearlyGoal !== undefined ? `year ${workoutsThisYear}/${yearlyGoal}` : null,
  ].filter(Boolean);
  if (set.length === 0) return 'no monthly or yearly goal set. never invent one.';
  return `${set.join(', ')} — context only. do NOT bring these up; the week is the number you talk about.`;
}

/** Whole days remaining in the user's local month, today included. */
function daysLeftInMonth(context: AgentContext): number {
  const now = parseIso(context.now);
  if (now === null) return 31;
  const local = new Date(now + tzOffsetMs(now, context.timezone));
  const inMonth = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 0)).getUTCDate();
  return inMonth - local.getUTCDate() + 1;
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
