/**
 * The guard layer is the whole safety story: "model proposes, backend
 * disposes". Every rule DESIGN.md states about stakes lives here rather than
 * in a prompt, because a prompt is a suggestion and this is not.
 *
 * Several cases below are regressions from watching real models misbehave
 * against the deployed Worker, and are labelled as such.
 */
import {
  guardCreate,
  guardReschedule,
  guardMessages,
  guardRelease,
  guardSlash,
  findCoveringWorkout,
  disqualification,
  resolveLocalTime,
  splitSlash,
  MIN_WORKOUT_SEC,
  type WorkoutWindow,
} from '../src/agent/guards';
import { endOfLocalDay } from '../src/time';
import { section, eq, allows, denies, isTrue, isFalse, done } from './harness';

const TZ = 'America/Toronto';
const NOW = Date.parse('2026-09-19T23:24:00Z'); // 19:24 EDT, a Saturday
const EOD = endOfLocalDay(NOW, TZ);

const stake = (status = 'held') => ({ lamports: 50_000_000, status, txSig: null }) as any;
const commitment = (over: Record<string, unknown> = {}) =>
  ({
    id: 'c_1',
    text: 'gym at 7',
    dueAt: '2026-09-19T23:00:00Z',
    graceMin: 20,
    status: 'pending',
    stake: stake(),
    renegotiations: 0,
    ...over,
  }) as any;

const workout = (
  start: string,
  durationSec: number,
  type = 'traditionalStrengthTraining',
  wasUserEntered = false,
): WorkoutWindow => ({ start, end: null, durationSec, type, wasUserEntered });

section('local time resolution — the model never does timezone maths');
{
  const at8pm = resolveLocalTime({ hour: 20 }, NOW, TZ);
  allows('20:00 local resolves', at8pm);
  if (at8pm.ok) {
    const local = new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(at8pm.value));
    eq('lands at 20:00 on the user clock', local, '20:00');
  }

  // Regression: the model returned hour as the string "19" and a correct
  // answer was being thrown away by a strict typeof check.
  allows('hour arrives as a string', resolveLocalTime({ hour: '19' }, NOW, TZ));

  // "gym at 7" said at 19:24 means tomorrow morning, not four hours ago.
  const past = resolveLocalTime({ hour: 7 }, NOW, TZ);
  allows('an hour already past today resolves', past);
  isTrue('...and resolves into the future', past.ok && past.value > NOW);

  denies('hour 24 is not a clock hour', resolveLocalTime({ hour: 24 }, NOW, TZ));
  denies('no hour at all', resolveLocalTime({}, NOW, TZ));
  denies('"tonight" is not an hour', resolveLocalTime({ hour: 'tonight' }, NOW, TZ));
  denies('minute out of range', resolveLocalTime({ hour: 19, minute: 90 }, NOW, TZ));
}

section('create_commitment');
{
  allows('a plain commitment', guardCreate({ text: 'gym at 7', hour: 20 }, NOW, TZ, []));
  denies('no text', guardCreate({ hour: 20 }, NOW, TZ, []));
  denies('no time named', guardCreate({ text: 'gym' }, NOW, TZ, []));
  denies(
    'a second open commitment',
    guardCreate({ text: 'gym', hour: 20 }, NOW, TZ, [commitment()]),
  );

  const defaulted = guardCreate({ text: 'gym at 7', hour: 20 }, NOW, TZ, []);
  eq(
    'default stake is 0.05 SOL',
    defaulted.ok ? defaulted.value.lamports : null,
    50_000_000,
  );

  const named = guardCreate({ text: 'gym', hour: 20, sol: 0.1 }, NOW, TZ, []);
  eq('a named stake in SOL becomes lamports', named.ok ? named.value.lamports : null, 100_000_000);

  denies('a stake above the 1 SOL ceiling', guardCreate({ text: 'gym', hour: 20, sol: 99 }, NOW, TZ, []));
  denies('dust', guardCreate({ text: 'gym', hour: 20, sol: 0.0000001 }, NOW, TZ, []));

  // Regression: asked for lamports, the model invented an exchange rate and
  // turned "$5" into 0.15 SOL. The tool takes SOL and only when SOL is named.
  const dollars = guardCreate({ text: '$5 on it', hour: 20 }, NOW, TZ, []);
  eq('a dollar figure does not become a stake', dollars.ok ? dollars.value.lamports : null, 50_000_000);
}

section('reschedule — DESIGN.md allows exactly one');
{
  allows(
    'first reschedule, later the same day',
    guardReschedule({ hour: 22, reason: 'homework' }, commitment(), NOW, TZ, EOD),
  );
  denies(
    'a second reschedule',
    guardReschedule({ hour: 22, reason: 'again' }, commitment({ renegotiations: 1 }), NOW, TZ, EOD),
  );
  denies(
    'past end of local day',
    guardReschedule({ hour: 9, reason: 'tomorrow' }, commitment(), NOW, TZ, EOD),
  );
  denies('without a reason for the trace', guardReschedule({ hour: 22 }, commitment(), NOW, TZ, EOD));
  denies(
    'a commitment already met',
    guardReschedule({ hour: 22, reason: 'x' }, commitment({ status: 'met' }), NOW, TZ, EOD),
  );
  denies('no such commitment', guardReschedule({ hour: 22, reason: 'x' }, null, NOW, TZ, EOD));
}

section('send_messages');
{
  allows('a normal burst', guardMessages({ texts: ['bro', '7:24 and no workout 😭'] }, true, false));
  denies('before a chat is linked', guardMessages({ texts: ['bro'] }, false, false));
  denies('after the user opted out', guardMessages({ texts: ['bro'] }, true, true));
  denies('a paragraph, not a text', guardMessages({ texts: ['x'.repeat(400)] }, true, false));
  denies('six in one burst', guardMessages({ texts: ['a', 'b', 'c', 'd', 'e', 'f'] }, true, false));
  denies('nothing but whitespace', guardMessages({ texts: ['   ', ''] }, true, false));
  denies('texts is not an array', guardMessages({ texts: 'bro' }, true, false));
}

section('what counts as training');
{
  eq('a real 45-minute session', disqualification(workout('2026-09-19T22:00:00Z', 2700)), null);
  eq(
    'hand-entered',
    disqualification(workout('2026-09-19T22:00:00Z', 2700, 'traditionalStrengthTraining', true)),
    'typed in by hand',
  );
  eq(
    'a walk',
    disqualification(workout('2026-09-19T22:00:00Z', 3600, 'walking')),
    "doesn't count as training",
  );
  eq(
    'under the floor',
    disqualification(workout('2026-09-19T22:00:00Z', 1200, 'running')),
    `under ${MIN_WORKOUT_SEC / 60} min`,
  );
  // The floor is inclusive: exactly 30 minutes counts.
  eq('exactly at the floor', disqualification(workout('2026-09-19T22:00:00Z', MIN_WORKOUT_SEC, 'running')), null);
}

section('does a workout cover the commitment?');
{
  const winStart = Date.parse('2026-09-19T12:00:00Z');
  const winEnd = Date.parse('2026-09-19T23:20:00Z');
  const covers = (w: WorkoutWindow) => !!findCoveringWorkout([w], winStart, winEnd);

  isTrue('a 45-minute session inside the window', covers(workout('2026-09-19T22:00:00Z', 2700)));
  isFalse('a 3-minute walk', covers(workout('2026-09-19T22:00:00Z', 180, 'walking')));
  isFalse('yesterday', covers(workout('2026-09-18T22:00:00Z', 2700)));
  isTrue(
    'started before the deadline and ran past it',
    covers(workout('2026-09-19T23:10:00Z', 3600)),
  );
  isFalse(
    'hand-entered, however long',
    covers(workout('2026-09-19T22:00:00Z', 7200, 'traditionalStrengthTraining', true)),
  );
  isFalse('an unreadable start', covers(workout('not-a-date', 2700)));
}

section('release — Snap knows rather than asks');
{
  const covering = workout('2026-09-19T22:00:00Z', 2700);
  allows('with a workout that covers it', guardRelease(commitment(), covering));
  denies('on the model\'s say-so alone', guardRelease(commitment(), null));
  denies('a stake already released', guardRelease(commitment({ stake: stake('released') }), covering));
  denies('no such commitment', guardRelease(null, covering));
}

section('slash — the rule both models tried to break');
{
  const covering = workout('2026-09-19T22:00:00Z', 2700);
  denies('AT THE GRACE MARK (grace is a warning, not a charge)', guardSlash(commitment(), NOW, EOD, null));
  allows('after end of local day', guardSlash(commitment(), EOD + 1000, EOD, null));
  denies('when a workout covers it', guardSlash(commitment(), EOD + 1000, EOD, covering));
  denies(
    'before a renegotiated deadline',
    guardSlash(commitment({ status: 'renegotiated', dueAt: '2026-09-20T01:00:00Z' }), NOW, EOD, null),
  );
  allows(
    'after the renegotiated deadline',
    guardSlash(
      commitment({ status: 'renegotiated', dueAt: '2026-09-20T01:00:00Z' }),
      Date.parse('2026-09-20T01:30:00Z'),
      EOD,
      null,
    ),
  );
  denies(
    'a stake already slashed',
    guardSlash(commitment({ stake: stake('slashed') }), EOD + 1000, EOD, null),
  );
}

section('a miss returns half the stake');
{
  eq('0.05 SOL splits evenly', splitSlash(50_000_000), { refunded: 25_000_000, forfeited: 25_000_000 });
  eq('0.1 SOL splits evenly', splitSlash(100_000_000), { refunded: 50_000_000, forfeited: 50_000_000 });
  eq('an odd lamport goes back to the user', splitSlash(7), { refunded: 4, forfeited: 3 });
  eq('one lamport cannot be halved away', splitSlash(1), { refunded: 1, forfeited: 0 });

  // Nothing may be stranded or invented: whatever was staked is exactly what
  // comes back out. An odd lamport favours the user, because it is their
  // money being divided.
  const problems: string[] = [];
  for (const staked of [1, 2, 3, 7, 999, 1_000_001, 50_000_000, 50_000_001, 123_456_789]) {
    const { refunded, forfeited } = splitSlash(staked);
    if (refunded + forfeited !== staked) problems.push(`${staked}: halves sum to ${refunded + forfeited}`);
    else if (refunded < forfeited) problems.push(`${staked}: forfeited ${forfeited} exceeds refunded ${refunded}`);
    else if (forfeited < 0) problems.push(`${staked}: negative forfeit`);
  }
  eq('the halves always add back up to the stake, favouring the user', problems, []);
}

done('guards');
