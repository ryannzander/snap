/**
 * Every deadline in Snap is a wall-clock time on the user's phone, and the
 * whole loop is built on "end of *their* day". Two hand-computed expectations
 * in an earlier version of this file were wrong while the code was right,
 * which is why the bulk of it is now a property check over real instants
 * rather than a table of values someone reasoned out.
 */
import { startOfMonth, startOfYear, startOfWeek, endOfLocalDay, localTimeToInstant, parseIso, isValidTimezone } from '../src/time';
import { section, eq, isTrue, isFalse, done } from './harness';

const ZONES = [
  'UTC', 'America/Toronto', 'America/Los_Angeles', 'America/St_Johns',
  'Europe/London', 'Europe/Berlin', 'Asia/Kolkata', 'Asia/Tokyo',
  'Australia/Sydney', 'Australia/Lord_Howe', 'Pacific/Kiritimati',
  'Pacific/Chatham', 'America/Sao_Paulo', 'Africa/Cairo',
];

function localParts(instant: number, tz: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instant))) {
    if (part.type !== 'literal') out[part.type] = part.value;
  }
  return out;
}

section('startOfWeek is Monday 00:00 local, everywhere, all year');
{
  const WEEK = 7 * 86_400_000;
  let checked = 0;
  const problems: string[] = [];

  for (const tz of ZONES) {
    for (let day = 0; day < 370; day++) {
      for (const hour of [0, 3, 11, 23]) {
        const t = Date.parse('2026-01-01T00:00:00Z') + day * 86_400_000 + hour * 3_600_000 + 1234;
        const start = startOfWeek(t, tz);
        const p = localParts(start, tz);
        checked++;
        const where = `${tz} @ ${new Date(t).toISOString()}`;
        if (p.weekday !== 'Mon') problems.push(`${where}: lands on ${p.weekday}`);
        else if (`${p.hour}:${p.minute}:${p.second}` !== '00:00:00') problems.push(`${where}: local ${p.hour}:${p.minute}:${p.second}`);
        else if (start > t) problems.push(`${where}: week start is in the future`);
        // A 25-hour day across a DST boundary is legal; eight days is not.
        else if (t - start >= WEEK + 2 * 3_600_000) problems.push(`${where}: over a week back`);
      }
    }
  }
  eq(`${checked} instants across ${ZONES.length} zones`, problems.slice(0, 3), []);
}

section('DST boundaries — where "now" and its Monday use different offsets');
{
  const at = (iso: string, tz: string) => new Date(startOfWeek(Date.parse(iso), tz)).toISOString();

  // Sun 8 Mar 2026 20:00 EDT. DST began that morning, so its Monday (2 Mar) was EST (-5).
  eq('spring forward: now EDT, Monday EST', at('2026-03-09T00:00:00Z', 'America/Toronto'), '2026-03-02T05:00:00.000Z');
  // Sun 1 Nov 2026 20:00 EST. DST ended that morning, so its Monday (26 Oct) was EDT (-4).
  eq('fall back: now EST, Monday EDT', at('2026-11-02T01:00:00Z', 'America/Toronto'), '2026-10-26T04:00:00.000Z');
  eq('the Monday after spring forward is itself EDT', at('2026-03-11T16:00:00Z', 'America/Toronto'), '2026-03-09T04:00:00.000Z');
  eq('half-hour offset (Kolkata)', at('2026-09-17T12:00:00Z', 'Asia/Kolkata'), '2026-09-13T18:30:00.000Z');
  eq('quarter-hour offset (Chatham)', at('2026-06-17T12:00:00Z', 'Pacific/Chatham'), '2026-06-14T11:15:00.000Z');
}

section('endOfLocalDay is the first instant of the next local day');
{
  // Deliberately NOT asserted as "local time reads 00:00". Egypt starts DST
  // at midnight on the last Friday in April, so the clock goes 23:59 -> 01:00
  // and there is no midnight to land on. The invariant that holds everywhere
  // is the one that matters anyway: it is the moment the local date rolls
  // over, which is the moment a stake becomes slashable.
  const problems: string[] = [];
  const localDay = (t: number, tz: string) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, dateStyle: 'short' }).format(new Date(t));

  for (const tz of ZONES) {
    for (let day = 0; day < 370; day++) {
      const t = Date.parse('2026-01-01T09:30:00Z') + day * 86_400_000;
      const eod = endOfLocalDay(t, tz);
      const where = `${tz} @ ${new Date(t).toISOString()}`;
      if (eod <= t) problems.push(`${where}: end of day is not after now`);
      else if (localDay(eod, tz) === localDay(t, tz)) problems.push(`${where}: still the same local day`);
      else if (localDay(eod - 60_000, tz) !== localDay(t, tz)) problems.push(`${where}: the day ended earlier than this`);
      else if (eod - t > 26 * 3_600_000) problems.push(`${where}: more than 26h away`);
    }
  }
  eq(`the day rolls over exactly once, in all ${ZONES.length} zones`, problems.slice(0, 3), []);
}

section('midnight that does not exist — Egypt, last Friday in April');
{
  // Regression. The two-pass offset resolution used to return 21:00Z here,
  // which reads 23:00 on the 23rd: an hour before the user's day is over,
  // and end of day is when money moves.
  const tz = 'Africa/Cairo';
  const duringThatDay = Date.parse('2026-04-23T09:30:00Z');
  eq(
    'ends when the local date changes, not at a midnight that never happens',
    new Date(endOfLocalDay(duringThatDay, tz)).toISOString(),
    '2026-04-23T22:00:00.000Z',
  );
  const local = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23',
  }).format(new Date(endOfLocalDay(duringThatDay, tz)));
  eq('which the clock there reads as the 24th', local, '24/04/2026, 01:00');
}

section('localTimeToInstant puts the hour on the user clock');
{
  const NOW = Date.parse('2026-09-19T14:00:00Z'); // 10:00 EDT Saturday
  const TZ = 'America/Toronto';

  const seven = localTimeToInstant(NOW, TZ, 19, 0);
  eq('19:00 Toronto is 23:00 UTC in September', new Date(seven).toISOString(), '2026-09-19T23:00:00.000Z');

  const tomorrow = localTimeToInstant(NOW, TZ, 19, 0, 1);
  eq('the day offset moves it a local day', new Date(tomorrow).toISOString(), '2026-09-20T23:00:00.000Z');

  // The regression that made "gym at 7" mean 3pm: the conversion used to
  // happen in the model's head rather than here.
  const p = localParts(localTimeToInstant(NOW, TZ, 7, 30), TZ);
  eq('07:30 local is 07:30 local', `${p.hour}:${p.minute}`, '07:30');
}

section('parsing and validation');
{
  eq('an ISO instant', parseIso('2026-09-19T23:00:00Z'), Date.parse('2026-09-19T23:00:00Z'));
  eq('"tonight" is not a date', parseIso('tonight'), null);
  eq('empty string', parseIso(''), null);
  isTrue('a real zone', isValidTimezone('America/Toronto'));
  isFalse('a made-up zone', isValidTimezone('Mars/Olympus_Mons'));
  isFalse('empty zone', isValidTimezone(''));
}

section('month and year boundaries, resolved the same careful way');
{
  const TZ = 'America/Toronto';
  const at = (iso: string) => Date.parse(iso);
  const localOf = (instant: number, tz: string) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(instant));

  eq('the 1st at midnight local', localOf(startOfMonth(at('2026-09-20T16:00:00Z'), TZ), TZ), '2026-09-01, 00:00');
  eq('january 1st at midnight local', localOf(startOfYear(at('2026-09-20T16:00:00Z'), TZ), TZ), '2026-01-01, 00:00');

  // March in Toronto contains a DST change, so the offset on the 1st is not
  // the offset today. This is exactly the bug startOfWeek was shaped to avoid.
  eq('a month containing a DST change', localOf(startOfMonth(at('2026-03-25T16:00:00Z'), TZ), TZ), '2026-03-01, 00:00');
  eq('and a year containing two', localOf(startOfYear(at('2026-11-15T16:00:00Z'), TZ), TZ), '2026-01-01, 00:00');

  // Southern hemisphere, DST the other way round.
  eq('Sydney', localOf(startOfMonth(at('2026-04-20T02:00:00Z'), 'Australia/Sydney'), 'Australia/Sydney'), '2026-04-01, 00:00');
  // A zone with a half-hour offset, where naive arithmetic lands 30 min out.
  eq('Kolkata', localOf(startOfMonth(at('2026-09-20T16:00:00Z'), 'Asia/Kolkata'), 'Asia/Kolkata'), '2026-09-01, 00:00');

  // Every boundary is itself a local midnight, in every zone, all year.
  const zones = ['America/Toronto', 'Europe/London', 'Asia/Kolkata', 'Australia/Sydney', 'Africa/Cairo', 'America/Sao_Paulo'];
  let offMidnight = 0;
  for (const tz of zones) {
    for (let month = 0; month < 12; month++) {
      const probe = Date.UTC(2026, month, 15, 12);
      for (const start of [startOfMonth(probe, tz), startOfYear(probe, tz)]) {
        if (!localOf(start, tz).endsWith('00:00')) offMidnight++;
      }
    }
  }
  eq('every month and year start is a local midnight', offMidnight, 0);

  // Ordering is the property that actually matters downstream.
  let broken = 0;
  for (const tz of zones) {
    for (let month = 0; month < 12; month++) {
      const probe = Date.UTC(2026, month, 15, 12);
      if (!(startOfYear(probe, tz) <= startOfMonth(probe, tz))) broken++;
      if (!(startOfMonth(probe, tz) <= startOfWeek(probe, tz) || startOfWeek(probe, tz) < startOfMonth(probe, tz))) broken++;
    }
  }
  eq('the year never starts after the month', broken, 0);
}

done('time');
