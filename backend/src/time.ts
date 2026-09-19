/**
 * Timezone maths. The user's week is theirs, not UTC's — someone in
 * America/Toronto committing at 11pm Sunday is still in that week.
 */

/** True if `tz` is an IANA zone this runtime knows. */
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
