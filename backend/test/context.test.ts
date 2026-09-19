/**
 * What the model reads each turn.
 *
 * Two things here are worth more than the rest: that a workout lands on the
 * user's local day rather than the UTC one, and that the weekly count uses
 * the same bar as releasing a stake. The second was a real bug — a 60-minute
 * walk filled a goal dot while being unable to release money, so the agent
 * would say "3/4 this week" off workouts the release path rejects.
 */
import {
  buildDays,
  countThisWeek,
  recentMessages,
  renderContext,
  summarizeContext,
  localDate,
  type AgentContext,
  type WorkoutLike,
} from '../src/agent/context';
import type { Commitment, TraceEvent } from '../src/types';
import { section, eq, isTrue, done } from './harness';

const TZ = 'America/Toronto';
const NOW = Date.parse('2026-09-19T14:00:00Z'); // Sat 19 Sep, 10:00 EDT

const workout = (
  start: string,
  durationSec = 2700,
  type = 'running',
  wasUserEntered = false,
): WorkoutLike => ({ start, end: start, durationSec, type, wasUserEntered });

section('a workout belongs to the local day, not the UTC one');
{
  // 01:00 UTC Saturday is 21:00 EDT on Friday.
  eq('rolls back across UTC midnight', localDate(Date.parse('2026-09-19T01:00:00Z'), TZ), '2026-09-18');

  const workouts = [
    workout('2026-09-19T01:00:00Z'), // Fri 18th, 21:00 local
    workout('2026-09-17T16:00:00Z'), // Thu 17th, 12:00 local
    workout('2026-09-14T16:00:00Z'), // Mon 14th, 12:00 local
  ];
  const days = buildDays(NOW, TZ, workouts, [], 7);
  eq('seven rows, oldest first, ending today', [days.length, days[0]!.date, days[6]!.date], [7, '2026-09-13', '2026-09-19']);
  eq('Friday gets the 21:00 EDT session', days.find((d) => d.date === '2026-09-18')?.workouts, 1);
  eq('today has none yet', days.find((d) => d.date === '2026-09-19')?.workouts, 0);
  eq('counted from Monday local', countThisWeek(NOW, TZ, workouts), 3);
}

section('the weekly count uses the same bar as releasing a stake');
{
  const junk: WorkoutLike[] = [
    workout('2026-09-18T16:00:00Z', 3600, 'walking'),                              // wrong type
    workout('2026-09-18T16:00:00Z', 1200, 'running'),                              // under the floor
    workout('2026-09-18T16:00:00Z', 2700, 'traditionalStrengthTraining', true),    // hand-entered
    workout('2026-09-18T16:00:00Z', 3600, 'other'),                                // wrong type
  ];
  eq('four workouts that cannot release money count for nothing', countThisWeek(NOW, TZ, junk), 0);
  eq('and fill no goal dots', buildDays(NOW, TZ, junk, [], 7).find((d) => d.date === '2026-09-18')?.workouts, 0);

  const real = [
    workout('2026-09-18T16:00:00Z', 2700, 'traditionalStrengthTraining'),
    workout('2026-09-17T16:00:00Z', 1800, 'running'),
  ];
  eq('two that can, count for two', countThisWeek(NOW, TZ, [...junk, ...real]), 2);
}

section('a missed commitment marks its local day skipped');
{
  const missed = [
    {
      id: 'c1',
      text: 'gym at 7',
      dueAt: '2026-09-18T23:00:00Z',
      graceMin: 20,
      status: 'missed',
      stake: { lamports: 50_000_000, status: 'slashed', txSig: null },
    },
  ] as unknown as Commitment[];
  const days = buildDays(NOW, TZ, [], missed, 7);
  eq('the 18th is marked', days.find((d) => d.date === '2026-09-18')?.skipped, true);
  eq('the 17th is not', days.find((d) => d.date === '2026-09-17')?.skipped, false);
}

section('the conversation is reconstructed from the trace');
{
  const events = [
    { id: 1, ts: '', kind: 'workout_detected', summary: 'running · 45 min' },
    { id: 2, ts: '', kind: 'message_sent', summary: 'bro' },
    { id: 3, ts: '', kind: 'message_received', summary: 'homework bro' },
    { id: 4, ts: '', kind: 'decision', summary: 'intervene' },
    { id: 5, ts: '', kind: 'message_sent', summary: '30 mins then' },
  ] as unknown as TraceEvent[];

  eq('only the two message kinds, in order', recentMessages(events), [
    { from: 'snap', text: 'bro' },
    { from: 'user', text: 'homework bro' },
    { from: 'snap', text: '30 mins then' },
  ]);

  const many = Array.from({ length: 30 }, (_, i) => ({
    id: i, ts: '', kind: 'message_sent', summary: `m${i}`,
  })) as unknown as TraceEvent[];
  const tail = recentMessages(many, 20);
  eq('the newest 20 are kept', [tail.length, tail[0]!.text, tail[19]!.text], [20, 'm10', 'm29']);
}

section('what the model actually sees');
{
  const context: AgentContext = {
    now: '2026-09-19T14:00:00Z',
    localTime: 'Saturday 10:00',
    timezone: TZ,
    name: 'Ryan',
    weeklyGoal: 4,
    workoutsThisWeek: 2,
    lastSevenDays: [
      { date: '2026-09-18', workouts: 0, skipped: true },
      { date: '2026-09-19', workouts: 0, skipped: false },
    ],
    openCommitments: [
      {
        id: 'c1',
        text: 'gym at 7',
        dueAt: '2026-09-19T23:00:00Z',
        graceMin: 20,
        status: 'pending',
        stake: { lamports: 50_000_000, status: 'held', txSig: null },
      },
    ] as unknown as Commitment[],
    recentMessages: [{ from: 'user', text: 'gym at 7, $5 on it' }],
  };

  eq(
    'the one-line summary on the brain screen',
    summarizeContext(context),
    'no workout today · skipped yesterday · 2/4 this week · 0.05 SOL staked',
  );

  const rendered = renderContext(context);
  for (const needle of ['weekly goal: 4', 'done this week: 2', 'gym at 7', 'held', 'Ryan']) {
    isTrue(`carries "${needle}"`, rendered.includes(needle));
  }
}

done('context');
