/**
 * Competitions: the pot, the rule, and who gets paid.
 *
 * ROADMAP.md → "Competitions": every competition is a pot, a rule, a set of
 * entrants, and an oracle that settles it from HealthKit data. This file is
 * the rule and the payout maths, kept pure so the money can be tested without
 * a Durable Object, a wallet or a model anywhere near it.
 *
 * The one rule that is not negotiable, from ROADMAP.md → "Money":
 * **winners get 100% of their own stake back.** Loss aversion only works when
 * success costs nothing, and a haircut on winners turns the stake into a fee.
 * The rake comes out of what the skippers forfeited, never out of a winner.
 */

import { disqualification, type WorkoutWindow } from '../agent/guards';

/** What a competition asks of you. All three are things HealthKit can prove. */
export type GoalType = 'workouts' | 'activeHours' | 'activeDays';

export interface Goal {
  type: GoalType;
  /** Sessions, hours, or distinct days — whichever `type` names. */
  target: number;
}

export const GOAL_TYPES: readonly GoalType[] = ['workouts', 'activeHours', 'activeDays'];

/** Rake on the forfeited pot, in basis points. ROADMAP.md → "Money": 15%. */
export const DEFAULT_RAKE_BPS = 1500;
export const MAX_RAKE_BPS = 3000;

export const MIN_ENTRY_LAMPORTS = 1_000_000; // 0.001 SOL
export const MAX_ENTRY_LAMPORTS = 1_000_000_000; // 1 SOL

export interface Standing {
  userId: string;
  name: string;
  stakeLamports: number;
  /** Sessions, hours or days done — the same unit as the goal's target. */
  progress: number;
  met: boolean;
}

export interface Payout {
  userId: string;
  /** Their own stake back, plus their share of the forfeited pot. */
  lamports: number;
  ownStake: number;
  winnings: number;
}

export interface Settlement {
  winners: string[];
  losers: string[];
  /** What the losers forfeited, before rake. */
  potLamports: number;
  rakeLamports: number;
  payouts: Payout[];
  /** To the house: the rake, plus the whole pot when nobody wins. */
  treasuryLamports: number;
}

/**
 * How far along an entrant is, counting only workouts that would release a
 * stake — the same bar as the single-commitment loop. A competition that
 * counts a 20-minute walk while the core loop refuses it would mean "it knows"
 * stops being true the moment there is money on the table.
 */
export function progressFor(
  goal: Goal,
  workouts: WorkoutWindow[],
  windowStart: number,
  windowEnd: number,
  tz: string,
): number {
  const qualifying = workouts.filter((workout) => {
    if (disqualification(workout) !== null) return false;
    const start = Date.parse(workout.start);
    if (Number.isNaN(start)) return false;
    return start >= windowStart && start <= windowEnd;
  });

  if (goal.type === 'workouts') return qualifying.length;

  if (goal.type === 'activeHours') {
    const seconds = qualifying.reduce((sum, w) => sum + w.durationSec, 0);
    // Two decimal places: "3.5 hours of 5" reads better than 3.4999999.
    //
    // Floored, not rounded. This number is not only read, it is the number
    // `meetsGoal` compares against the target — and rounding turned 4h 59m
    // 42s into a 5.00 that met a five-hour goal and took a share of the pot
    // off the people who had actually finished.
    return Math.floor((seconds / 3600) * 100) / 100;
  }

  // activeDays: distinct local calendar days, so two sessions in one evening
  // are one day rather than two.
  const days = new Set<string>();
  for (const workout of qualifying) {
    days.add(
      new Intl.DateTimeFormat('en-CA', { timeZone: tz, dateStyle: 'short' }).format(
        new Date(Date.parse(workout.start)),
      ),
    );
  }
  return days.size;
}

export function meetsGoal(goal: Goal, progress: number): boolean {
  return progress >= goal.target;
}

/**
 * Who gets what.
 *
 * Winners are paid their own stake plus an equal share of what the losers
 * forfeited, after rake. Equal rather than proportional to stake: a
 * competition is a contest of showing up, and paying the biggest wallet the
 * biggest share would make it a contest of wallets.
 *
 * With nobody meeting the goal there is nothing to distribute and the whole
 * pot goes to the house. With everybody meeting it there is no pot at all,
 * so the rake is zero and every entrant is made whole — which is the
 * intended outcome, not an edge case to be clever about.
 */
export function settleCompetition(
  standings: Standing[],
  goal: Goal,
  rakeBps: number,
): Settlement {
  const winners = standings.filter((s) => meetsGoal(goal, s.progress));
  const losers = standings.filter((s) => !meetsGoal(goal, s.progress));

  const potLamports = losers.reduce((sum, s) => sum + s.stakeLamports, 0);

  if (winners.length === 0) {
    return {
      winners: [],
      losers: losers.map((s) => s.userId),
      potLamports,
      rakeLamports: 0,
      payouts: [],
      treasuryLamports: potLamports,
    };
  }

  const rakeLamports = Math.floor((potLamports * rakeBps) / 10_000);
  const distributable = potLamports - rakeLamports;
  const each = Math.floor(distributable / winners.length);
  // Integer division leaves a few lamports over; they go to the house rather
  // than to whichever winner happens to sort first.
  const remainder = distributable - each * winners.length;

  return {
    winners: winners.map((s) => s.userId),
    losers: losers.map((s) => s.userId),
    potLamports,
    rakeLamports,
    payouts: winners.map((s) => ({
      userId: s.userId,
      lamports: s.stakeLamports + each,
      ownStake: s.stakeLamports,
      winnings: each,
    })),
    treasuryLamports: rakeLamports + remainder,
  };
}
