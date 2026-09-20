/**
 * Timezone maths. The user's week is theirs, not UTC's — someone in
 * America/Toronto committing at 11pm Sunday is still in that week.
 */

/** True if `tz` is an IANA zone this runtime knows. */
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Milliseconds to add to a UTC instant to get the wall-clock time in `tz`. */
export function tzOffsetMs(instant: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));

  const field: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== 'literal') field[part.type] = Number(part.value);
  }

  const wallClock = Date.UTC(
    field.year!,
    field.month! - 1,
    field.day!,
    field.hour!,
    field.minute!,
    field.second!,
  );
  // formatToParts has second resolution, so compare against a truncated instant.
  return wallClock - Math.floor(instant / 1000) * 1000;
}

/**
 * UTC instant of the most recent Monday 00:00 local time in `tz`.
 * Resolved twice because the offset on the target midnight can differ from the
 * offset right now (DST).
 */
export function startOfWeek(instant: number, tz: string): number {
  const local = new Date(instant + tzOffsetMs(instant, tz));
  const daysSinceMonday = (local.getUTCDay() + 6) % 7;
  const localMidnight = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() - daysSinceMonday,
  );
  const firstGuess = localMidnight - tzOffsetMs(instant, tz);
  return localMidnight - tzOffsetMs(firstGuess, tz);
}

/** Parses an ISO 8601 timestamp, returning null rather than NaN. */
export function parseIso(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** The local calendar day an instant falls on, as a comparable number. */
function localDayNumber(instant: number, tz: string): number {
  const local = new Date(instant + tzOffsetMs(instant, tz));
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
}

/**
 * UTC instant of the next local midnight in `tz` — the moment "end of day"
 * passes, which is when a stake may be slashed (DESIGN.md → Stake rules).
 */
/**
 * Midnight on the 1st of the user's current month, in their zone.
 *
 * Same two-pass resolve as `startOfWeek`: the offset on the target midnight
 * can differ from the offset right now, which is the whole reason that
 * function is shaped the way it is. A month boundary crosses a DST change
 * twice a year in most zones, so this is not theoretical.
 */
export function startOfMonth(instant: number, tz: string): number {
  const local = new Date(instant + tzOffsetMs(instant, tz));
  const localMidnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1);
  const firstGuess = localMidnight - tzOffsetMs(instant, tz);
  return localMidnight - tzOffsetMs(firstGuess, tz);
}

/** Midnight on January 1st of the user's current year, in their zone. */
export function startOfYear(instant: number, tz: string): number {
  const local = new Date(instant + tzOffsetMs(instant, tz));
  const localMidnight = Date.UTC(local.getUTCFullYear(), 0, 1);
  const firstGuess = localMidnight - tzOffsetMs(instant, tz);
  return localMidnight - tzOffsetMs(firstGuess, tz);
}

export function endOfLocalDay(instant: number, tz: string): number {
  const local = new Date(instant + tzOffsetMs(instant, tz));
  const nextMidnight = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() + 1,
  );
  const firstGuess = nextMidnight - tzOffsetMs(instant, tz);
  const resolved = nextMidnight - tzOffsetMs(firstGuess, tz);

  // A few zones begin DST exactly at midnight — Egypt does, on the last
  // Friday in April, where the local clock reads 23:59 and then 01:00. The
  // midnight resolved above never happens there, and taking it at face value
  // ends the day an hour early. End of day is when money moves, so that is an
  // hour of someone's stake taken while it is still today for them.
  //
  // Only reached on the handful of nights a year this is true of.
  if (localDayNumber(resolved, tz) === localDayNumber(instant, tz)) {
    const today = localDayNumber(instant, tz);
    for (let t = resolved + MINUTE_MS; t <= resolved + 3 * HOUR_MS; t += MINUTE_MS) {
      if (localDayNumber(t, tz) !== today) return t;
    }
  }
  return resolved;
}

/**
 * Turns a local wall-clock time the model named ("7pm") into a UTC instant.
 * The model is never asked to convert timezones — it got that wrong in
 * testing, and this is already property-tested across zones and DST edges.
 */
export function localTimeToInstant(
  reference: number,
  tz: string,
  hour: number,
  minute: number,
  dayOffset = 0,
): number {
  const local = new Date(reference + tzOffsetMs(reference, tz));
  const wallClock = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() + dayOffset,
    hour,
    minute,
  );
  const firstGuess = wallClock - tzOffsetMs(reference, tz);
  return wallClock - tzOffsetMs(firstGuess, tz);
}
