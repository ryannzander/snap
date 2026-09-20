/**
 * The competition pot.
 *
 * ROADMAP.md → "Money" states the rule this suite exists to hold: **winners
 * get 100% of their own stake back.** The rake comes out of what the skippers
 * forfeited. If a winner ever ends up down on a competition they won, the
 * product stops working — nobody stakes twice.
 */
import {
  settleCompetition,
  progressFor,
  meetsGoal,
  DEFAULT_RAKE_BPS,
  type Standing,
  type Goal,
} from '../src/competitions/rules';
import type { WorkoutWindow } from '../src/agent/guards';
import { section, eq, isTrue, done } from './harness';

const TZ = 'America/Toronto';
const stake = 100_000_000; // 0.1 SOL

const who = (userId: string, progress: number, lamports = stake): Standing => ({
  userId,
  name: userId,
  stakeLamports: lamports,
  progress,
  met: false,
});

const goal: Goal = { type: 'workouts', target: 4 };

section('a winner never loses money');
{
  // The rule from ROADMAP.md, asserted over every shape a competition can take.
  const problems: string[] = [];
  const shapes: Standing[][] = [
    [who('a', 4), who('b', 1)],
    [who('a', 4), who('b', 4)],
    [who('a', 0), who('b', 0)],
    [who('a', 4), who('b', 0), who('c', 0), who('d', 0)],
    [who('a', 9), who('b', 4), who('c', 3)],
    [who('a', 4, 1_000_000), who('b', 0, 1_000_000_000)],
    [who('a', 5)],
    [who('a', 1)],
  ];
  for (const standings of shapes) {
    const s = settleCompetition(standings, goal, DEFAULT_RAKE_BPS);
    for (const payout of s.payouts) {
      const entrant = standings.find((e) => e.userId === payout.userId)!;
      if (payout.lamports < entrant.stakeLamports) {
        problems.push(`${payout.userId} got ${payout.lamports} back on a ${entrant.stakeLamports} stake`);
      }
    }
  }
  eq('every winner is paid at least their whole stake', problems, []);
}

section('nothing is invented and nothing is stranded');
{
  const problems: string[] = [];
  const shapes: Standing[][] = [
    [who('a', 4), who('b', 1)],
    [who('a', 4), who('b', 4), who('c', 0)],
    [who('a', 0), who('b', 0)],
    [who('a', 4), who('b', 0), who('c', 0)],
    [who('a', 4, 50_000_001), who('b', 0, 50_000_001), who('c', 0, 3)],
  ];
  for (const standings of shapes) {
    const s = settleCompetition(standings, goal, DEFAULT_RAKE_BPS);
    const staked = standings.reduce((sum, e) => sum + e.stakeLamports, 0);
    const out = s.payouts.reduce((sum, p) => sum + p.lamports, 0) + s.treasuryLamports;
    if (out !== staked) problems.push(`in ${staked}, out ${out}`);
  }
  eq('every lamport staked is paid out or goes to the house', problems, []);
}

section('the pot');
{
  const two = settleCompetition([who('a', 4), who('b', 1)], goal, DEFAULT_RAKE_BPS);
  eq('the loser funds the pot', two.potLamports, stake);
  eq('rake is 15% of the pot', two.rakeLamports, 15_000_000);
  eq('the winner takes their stake plus the rest', two.payouts[0]!.lamports, stake + 85_000_000);
  eq('and the house keeps only the rake', two.treasuryLamports, 15_000_000);

  const allWin = settleCompetition([who('a', 4), who('b', 4)], goal, DEFAULT_RAKE_BPS);
  eq('everyone winning means no pot', allWin.potLamports, 0);
  eq('...and no rake — the house earns nothing on a successful workout', allWin.rakeLamports, 0);
  eq('...and both get exactly their stake', allWin.payouts.map((p) => p.lamports), [stake, stake]);

  const noneWin = settleCompetition([who('a', 1), who('b', 2)], goal, DEFAULT_RAKE_BPS);
  eq('nobody winning pays nobody', noneWin.payouts, []);
  eq('...and the whole pot goes to the house', noneWin.treasuryLamports, 2 * stake);

  const split = settleCompetition([who('a', 4), who('b', 4), who('c', 0)], goal, DEFAULT_RAKE_BPS);
  eq('two winners split the pot evenly', split.payouts.map((p) => p.winnings), [42_500_000, 42_500_000]);

  // Equal shares, not proportional to stake: showing up is the contest.
  const uneven = settleCompetition(
    [who('a', 4, 1_000_000), who('b', 4, 500_000_000), who('c', 0, 100_000_000)],
    goal,
    DEFAULT_RAKE_BPS,
  );
  eq('a bigger wallet does not win a bigger share', uneven.payouts.map((p) => p.winnings), [42_500_000, 42_500_000]);
}

section('progress is measured by the same bar that releases a stake');
{
  const w = (start: string, durationSec: number, type = 'running', wasUserEntered = false): WorkoutWindow =>
    ({ start, end: null, durationSec, type, wasUserEntered });

  const from = Date.parse('2026-09-14T00:00:00Z');
  const to = Date.parse('2026-09-21T00:00:00Z');
  const real = [
    w('2026-09-15T16:00:00Z', 2700),
    w('2026-09-16T16:00:00Z', 1800),
    w('2026-09-16T23:00:00Z', 3600), // same local day as the one above
  ];
  const junk = [
    w('2026-09-15T16:00:00Z', 1200),                              // under the floor
    w('2026-09-15T16:00:00Z', 3600, 'walking'),                   // wrong type
    w('2026-09-15T16:00:00Z', 3600, 'running', true),             // hand-entered
    w('2026-09-01T16:00:00Z', 3600),                              // before the window
  ];

  eq('sessions count only qualifying ones', progressFor({ type: 'workouts', target: 4 }, [...real, ...junk], from, to, TZ), 3);
  eq('hours are summed from the same set', progressFor({ type: 'activeHours', target: 2 }, [...real, ...junk], from, to, TZ), 2.25);
  eq('days are distinct local days', progressFor({ type: 'activeDays', target: 2 }, [...real, ...junk], from, to, TZ), 2);
  eq('nothing at all is zero, not an error', progressFor({ type: 'workouts', target: 4 }, junk, from, to, TZ), 0);

  isTrue('the target is inclusive', meetsGoal({ type: 'workouts', target: 3 }, 3));
  isTrue('and beating it still counts', meetsGoal({ type: 'workouts', target: 3 }, 9));
}

done('competitions');
