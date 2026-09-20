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
  brokenStreak,
  currentStreak,
  buildDays,
  countMovesThisWeek,
  countThisWeek,
  countVerifiedThisWeek,
  recentMessages,
  renderContext,
  summarizeContext,
  localDate,
  type AgentContext,
  type WorkoutLike,
} from '../src/agent/context';
import type { Commitment, TraceEvent } from '../src/types';
import { section, eq, isTrue, isFalse, done } from './harness';

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
    workout('2026-09-18T16:00:00Z', 300, 'running'),                               // five minutes
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

  // Turning up counts. Someone who drove to the gym, warmed up, felt awful
  // and left after twenty minutes trained — the floor is there to catch a
  // fake, not to punish a bad day.
  const shortDay = [workout('2026-09-16T16:00:00Z', 1200, 'traditionalStrengthTraining')];
  eq('twenty minutes is a session', countThisWeek(NOW, TZ, shortDay), 1);
}

section('a verified photo fills a goal dot, because it releases a stake');
{
  const real = [
    workout('2026-09-18T16:00:00Z', 2700, 'traditionalStrengthTraining'), // Fri
    workout('2026-09-17T16:00:00Z', 1800, 'running'),                      // Thu
  ];
  const met = (proofAt: string) => ({ status: 'met', dueAt: proofAt, proof: { at: proofAt } });

  eq('the watch alone is unchanged', countVerifiedThisWeek(NOW, TZ, real, []), 2);

  // Wednesday: a photo and nothing on the watch. This is the whole point —
  // the pic is what returns the money, so it has to move the number too.
  eq(
    'a photo-only session counts',
    countVerifiedThisWeek(NOW, TZ, real, [met('2026-09-16T16:00:00Z')]),
    3,
  );

  // Friday already has a workout. Someone who trains with the watch on AND
  // sends a picture did one session; counting it twice flatters the goal.
  eq(
    'a photo on a day that already has a workout does not count twice',
    countVerifiedThisWeek(NOW, TZ, real, [met('2026-09-18T17:00:00Z')]),
    2,
  );

  eq(
    'two photos on the same day are still one day',
    countVerifiedThisWeek(NOW, TZ, real, [met('2026-09-16T14:00:00Z'), met('2026-09-16T20:00:00Z')]),
    3,
  );

  // A commitment that was missed has no proof on it, and last week's does
  // not belong to this week.
  eq(
    'a missed commitment counts for nothing',
    countVerifiedThisWeek(NOW, TZ, real, [{ status: 'missed', dueAt: '2026-09-16T16:00:00Z', proof: null }]),
    2,
  );
  eq(
    'and last week stays in last week',
    countVerifiedThisWeek(NOW, TZ, real, [met('2026-09-11T16:00:00Z')]),
    2,
  );
}

section('the window /state carries for the schedule screen');
{
  // Thirty days of dots, and the streak is counted from them — so the window
  // has to end on today and be contiguous, or a gap reads as a missed day.
  const days = buildDays(NOW, TZ, [workout('2026-09-18T16:00:00Z')], [], 30);
  eq('thirty rows', days.length, 30);
  eq('oldest first', days[0]!.date, '2026-08-21');
  eq('ending today, on their clock', days[29]!.date, '2026-09-19');

  const dates = days.map((d) => d.date);
  eq('no gaps', new Set(dates).size, 30);
  const contiguous = dates.every((date, i) => {
    if (i === 0) return true;
    return Date.parse(date + 'T12:00:00Z') - Date.parse(dates[i - 1]! + 'T12:00:00Z') === 86_400_000;
  });
  isTrue('one day apart, all the way down', contiguous);
  eq('the session lands on its local day', days.find((d) => d.date === '2026-09-18')?.workouts, 1);
}

section('moving sessions is a pattern, so it is counted across all of them');
{
  const moved = (at: string) => ({ reschedules: [{ at }] });

  eq('nothing moved', countMovesThisWeek(NOW, TZ, [{ reschedules: [] }, {}]), 0);
  eq(
    'three sessions moved this week',
    countMovesThisWeek(NOW, TZ, [moved('2026-09-16T16:00:00Z'), moved('2026-09-17T16:00:00Z'), moved('2026-09-18T16:00:00Z')]),
    3,
  );
  // The per-commitment limit answers "can this one move again". This answers
  // "does this person move all of them", which is the one Snap can roast.
  eq(
    'two moves on one commitment still both count',
    countMovesThisWeek(NOW, TZ, [{ reschedules: [{ at: '2026-09-16T16:00:00Z' }, { at: '2026-09-17T16:00:00Z' }] }]),
    2,
  );
  eq('last week stays in last week', countMovesThisWeek(NOW, TZ, [moved('2026-09-11T16:00:00Z')]), 0);
  eq('an unreadable timestamp is not a move', countMovesThisWeek(NOW, TZ, [moved('nope')]), 0);
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
        renegotiations: 0,
      },
    ] as unknown as Array<Commitment & { renegotiations: number }>,
    standingOffer: null,
    movesThisWeek: 0,
    defaultStakeLamports: 50_000_000,
    targetMin: 45,
    streak: 0,
    brokenStreak: 0,
    wallet: { balanceLamports: 120_000_000, heldLamports: 50_000_000 },
    recentMessages: [{ from: 'user', text: 'gym at 7, $5 on it' }],
  };

  eq(
    'the one-line summary on the brain screen',
    summarizeContext(context),
    'no workout today · skipped yesterday · 2/4 this week · 0.05 SOL staked',
  );

  const rendered = renderContext(context);
  // 23:00Z is 19:00 in Toronto. Rendering the UTC stamp made the model read
  // a 19:00 deadline as 23:00 and conclude it had hours left.
  isTrue('the deadline is on their clock', renderContext(context).includes('Sat 19:00'));
  // Without this the model told the user they had used their one reschedule
  // when they had not.
  isTrue('the reschedule count is visible', renderContext(context).includes('reschedules used 0/1'));
  isTrue('the UTC stamp never reaches the model', !renderContext(context).includes('T23:00:00Z'));

  for (const needle of ['weekly goal: 4', 'done this week: 2', 'gym at 7', 'held', 'Ryan']) {
    isTrue(`carries "${needle}"`, rendered.includes(needle));
  }
  // Snap offers stakes unprompted, so it has to know what is actually there
  // to offer — otherwise it proposes 0.05 to a wallet holding 0.01 and the
  // guards refuse a stake the user has already said yes to.
  isTrue('the spendable balance', rendered.includes('0.12 SOL spendable'));
  isTrue('and how many sessions they have moved', rendered.includes('sessions moved this week: 0'));
  {
    const withMove: AgentContext = {
      ...context,
      movesThisWeek: 2,
      openCommitments: [
        {
          ...context.openCommitments[0]!,
          reschedules: [{ at: '2026-09-19T20:00:00Z', from: '2026-09-19T22:00:00Z', to: '2026-09-19T23:00:00Z' }],
        },
      ] as unknown as Array<Commitment & { renegotiations: number }>,
    };
    const movedOut = renderContext(withMove);
    // On their clock, both ends — the model is never asked to do timezone
    // maths, on the way in or the way out.
    isTrue('a move shows where it came from and went to', movedOut.includes('moved Sat 18:00 → Sat 19:00'));
    isTrue('and the week total is there to roast', movedOut.includes('sessions moved this week: 2'));
  }
  isTrue('and what is already locked', rendered.includes('0.05 SOL already locked'));
  isTrue(
    'an unreachable chain is unknown, not empty',
    renderContext({ ...context, wallet: { balanceLamports: null, heldLamports: 0 } }).includes(
      'balance unknown right now',
    ),
  );
}

section('the streak, and it has to be the number on their home screen');
{
  const d = (date: string, workouts: number, skipped = false) => ({ date, workouts, skipped });

  eq('nothing at all', currentStreak([]), 0);
  eq('one day', currentStreak([d('2026-09-19', 1)]), 1);
  eq('three in a row', currentStreak([d('2026-09-17', 1), d('2026-09-18', 1), d('2026-09-19', 1)]), 3);
  eq(
    'a gap breaks it, and only the run up to today counts',
    currentStreak([d('2026-09-15', 1), d('2026-09-16', 1), d('2026-09-17', 0), d('2026-09-18', 1), d('2026-09-19', 1)]),
    2,
  );

  // The two that matter, and the reason this is ported rather than reinvented.
  // Today with nothing logged yet is NOT a break — the day is not over, and a
  // number that resets at midnight and un-resets when you train is one nobody
  // would trust.
  eq(
    'today being empty does not break it',
    currentStreak([d('2026-09-17', 1), d('2026-09-18', 1), d('2026-09-19', 0)]),
    2,
  );
  // But today SKIPPED is a day already decided — the money has moved.
  eq(
    'today being skipped does',
    currentStreak([d('2026-09-17', 1), d('2026-09-18', 1), d('2026-09-19', 0, true)]),
    0,
  );
  eq(
    'and yesterday skipped still breaks it behind an empty today',
    currentStreak([d('2026-09-17', 1), d('2026-09-18', 0, true), d('2026-09-19', 0)]),
    0,
  );
  // Training today after a skipped commitment yesterday starts a fresh run.
  eq(
    'a fresh run starts at one',
    currentStreak([d('2026-09-17', 1), d('2026-09-18', 0, true), d('2026-09-19', 1)]),
    1,
  );

  // Capped by the window it is given: 30 days of history cannot prove 40.
  const thirty = Array.from({ length: 30 }, (_, i) => d(`2026-09-${String(i + 1).padStart(2, '0')}`, 1));
  eq('capped by the window', currentStreak(thirty), 30);
}

section('the run you just lost');
{
  const d = (date: string, workouts: number, skipped = false) => ({ date, workouts, skipped });

  // The seeded demo week, and the reason this exists: three consecutive days,
  // yesterday skipped, today still open. No streak to talk about, but a very
  // good sentence available.
  const seeded = [d('2026-09-16', 1), d('2026-09-17', 1), d('2026-09-18', 1), d('2026-09-19', 0, true), d('2026-09-20', 0)];
  eq('no streak going', currentStreak(seeded), 0);
  eq('but a three day run just ended', brokenStreak(seeded), 3);

  // Never both. A live streak is the thing to protect; a dead one is the thing
  // to get back, and Snap talking about both in one breath is incoherent.
  const alive = [d('2026-09-18', 1), d('2026-09-19', 1), d('2026-09-20', 0)];
  eq('a live streak silences it', brokenStreak(alive), 0);
  isTrue('and the live one is still counted', currentStreak(alive) === 2);

  // One session is a Tuesday. Calling it a lost streak is how Snap starts
  // sounding like an app.
  eq('one lost day is not a lost run', brokenStreak([d('2026-09-18', 1), d('2026-09-19', 0, true)]), 0);
  eq('nothing at all', brokenStreak([d('2026-09-19', 0, true)]), 0);
  eq('no history at all', brokenStreak([]), 0);

  // Only the run immediately before the break, not the best run ever.
  const older = [d('2026-09-10', 1), d('2026-09-11', 1), d('2026-09-12', 1), d('2026-09-13', 1),
                 d('2026-09-14', 0), d('2026-09-18', 1), d('2026-09-19', 1), d('2026-09-20', 0, true)];
  eq('the most recent run, not the longest', brokenStreak(older), 2);
}

section('snap only mentions a streak when there is one');
{
  const base: AgentContext = {
    now: '2026-09-19T14:00:00Z',
    localTime: 'Saturday 10:00',
    timezone: TZ,
    name: 'Ryan',
    weeklyGoal: 4,
    workoutsThisWeek: 2,
    lastSevenDays: [{ date: '2026-09-19', workouts: 0, skipped: false }],
    openCommitments: [],
    standingOffer: null,
    movesThisWeek: 0,
    defaultStakeLamports: 50_000_000,
    targetMin: 45,
    streak: 0,
    brokenStreak: 0,
    wallet: { balanceLamports: 120_000_000, heldLamports: 0 },
    recentMessages: [],
  };

  // One session is a Tuesday, not a streak, and Snap congratulating someone on
  // a "1 day streak" is the single most patronising thing he could say.
  isTrue('none at all is said plainly', renderContext(base).includes('no streak going'));
  isTrue('and one day is not a streak', renderContext({ ...base, streak: 1 }).includes('no streak going'));

  const five = renderContext({ ...base, streak: 5 });
  isTrue('five is', five.includes('5 day streak'));
  isTrue('and he is told it is the number they can see', five.includes('home screen'));
  isFalse('with no invented number', five.includes('no streak going'));
}

section('the model is told the gesture it will later enforce');
{
  // Enforcement reads the stored commitment; this row is the only place the
  // model can learn what to ask for. They were wired separately once, and the
  // projection between them dropped the field — which would have shipped as
  // Snap refusing a photo for missing a gesture he never mentioned.
  const withChallenge: AgentContext = {
    now: '2026-09-19T14:00:00Z',
    localTime: 'Saturday 10:00',
    timezone: TZ,
    name: 'Ryan',
    weeklyGoal: 4,
    workoutsThisWeek: 2,
    lastSevenDays: [{ date: '2026-09-19', workouts: 0, skipped: false }],
    openCommitments: [
      {
        id: 'c_1',
        text: 'gym at 7',
        dueAt: '2026-09-19T23:00:00Z',
        graceMin: 20,
        status: 'pending',
        stake: { lamports: 50_000_000, status: 'held', txSig: null },
        reschedules: [],
        proof: null,
        verifiedBy: null,
        challenge: 'thumb',
        renegotiations: 0,
      },
    ] as unknown as Array<Commitment & { renegotiations: number }>,
    standingOffer: null,
    movesThisWeek: 0,
    defaultStakeLamports: 50_000_000,
    targetMin: 45,
    streak: 0,
    brokenStreak: 0,
    wallet: { balanceLamports: 120_000_000, heldLamports: 50_000_000 },
    recentMessages: [],
  };
  const rendered = renderContext(withChallenge);
  isTrue('the gesture is named', rendered.includes('A THUMBS UP IN THE PIC'));
  isTrue('and snap is told to repeat it', rendered.includes('tell them, every time'));

  const without = renderContext({
    ...withChallenge,
    openCommitments: withChallenge.openCommitments.map((c) => ({ ...c, challenge: undefined })),
  });
  isFalse('a commitment from before challenges says nothing', without.includes('THE PIC FOR THIS ONE NEEDS'));
}

section('the model is told which number to say');
{
  // The prompt used to hard-code "5 bucks of sol". With the dial moving the
  // default per user, a fixed number in the prompt is Snap promising a deal
  // the guard does not honour — so the amount is rendered, not baked in.
  const base: AgentContext = {
    now: '2026-09-19T14:00:00Z',
    localTime: 'Saturday 10:00',
    timezone: TZ,
    name: 'Ryan',
    weeklyGoal: 4,
    workoutsThisWeek: 2,
    lastSevenDays: [{ date: '2026-09-19', workouts: 0, skipped: false }],
    openCommitments: [],
    standingOffer: null,
    movesThisWeek: 0,
    defaultStakeLamports: 50_000_000,
    targetMin: 45,
    streak: 0,
    brokenStreak: 0,
    wallet: { balanceLamports: 120_000_000, heldLamports: 0 },
    recentMessages: [],
  };
  const easy = renderContext({ ...base, defaultStakeLamports: 20_000_000 });
  const hard = renderContext({ ...base, defaultStakeLamports: 100_000_000 });
  isTrue('easy names 0.02', easy.includes('the stake is 0.02 SOL'));
  isTrue('hard names 0.1', hard.includes('the stake is 0.1 SOL'));
  isFalse('and it is not a constant', easy.includes('0.1 SOL —'));
}

section('an offer on the table is something the model must see');
{
  const base: AgentContext = {
    now: '2026-09-19T14:00:00Z',
    localTime: 'Saturday 10:00',
    timezone: TZ,
    name: 'Ryan',
    weeklyGoal: 4,
    workoutsThisWeek: 2,
    lastSevenDays: [{ date: '2026-09-19', workouts: 0, skipped: false }],
    openCommitments: [],
    standingOffer: null,
    movesThisWeek: 0,
    defaultStakeLamports: 50_000_000,
    targetMin: 45,
    streak: 0,
    brokenStreak: 0,
    wallet: { balanceLamports: 120_000_000, heldLamports: 0 },
    recentMessages: [],
  };

  isTrue('with none, the block says so', renderContext(base).includes('stake you have offered and they have not answered:\n- none'));

  const offered: AgentContext = {
    ...base,
    standingOffer: { text: 'gym at 7', dueAt: '2026-09-19T23:00:00Z', lamports: 50_000_000 },
  };
  const rendered = renderContext(offered);
  isTrue('the offer is rendered', rendered.includes('"gym at 7"'));
  isTrue('with its deadline on their clock, not UTC', rendered.includes('Sat 19:00'));
  isTrue('and never as a UTC stamp', !rendered.includes('2026-09-19T23:00:00Z'));
  isTrue('and that it is unanswered', rendered.includes('waiting on their yes'));

  // The summary must not claim money is staked when it is only offered —
  // nothing has moved until they say yes.
  eq(
    'the summary says offered, not staked',
    summarizeContext(offered),
    'no workout today · 2/4 this week · 0.05 SOL offered, no answer yet',
  );
  isTrue('and never the word staked', !summarizeContext(offered).includes('staked'));
}

done('context');
