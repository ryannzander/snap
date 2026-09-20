/** Request parsing for the endpoints in API.md. Rejects loudly on bad input. */

import { HttpError, badRequest } from './http';
import { LAMPORTS_PER_SOL, MAX_TOPUP_LAMPORTS, MIN_TOPUP_LAMPORTS } from './money';
import { isIntensity } from './agent/intensity';
import { isValidTimezone, parseIso } from './time';
import type { OnboardRequest, WorkoutInput } from './types';

const MAX_BODY_BYTES = 1_000_000;
const MAX_WORKOUTS_PER_REQUEST = 500;
const MAX_SINCE = 1_000_000_000_000;

export async function readJsonBody(request: Request): Promise<unknown> {
  const declared = request.headers.get('content-length');
  if (declared && Number(declared) > MAX_BODY_BYTES) {
    throw new HttpError(413, 'payload_too_large', 'request body is too large');
  }
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    throw new HttpError(413, 'payload_too_large', 'request body is too large');
  }
  if (raw.trim() === '') throw badRequest('expected a JSON body');
  try {
    return JSON.parse(raw);
  } catch {
    throw badRequest('body is not valid JSON');
  }
}

/**
 * A longer-horizon goal, or nothing.
 *
 * The ceilings are three a day over the window: 93 in a month, 1095 in a year.
 * Not a fitness opinion, just the point past which a number is a typo rather
 * than an ambition, and a goal nobody can hit is a goal that teaches somebody
 * their stake is pointless.
 */
function optionalGoal(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = asNumber(value, field);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw badRequest(`${field} must be a whole number between ${min} and ${max}`);
  }
  return n;
}

export function parseOnboardRequest(body: unknown): OnboardRequest {
  const input = asObject(body, 'body');

  const name = asString(input.name, 'name').trim();
  if (name.length === 0) throw badRequest('name must not be empty');
  if (name.length > 100) throw badRequest('name must be 100 characters or fewer');

  const weeklyGoal = asNumber(input.weeklyGoal, 'weeklyGoal');
  if (!Number.isInteger(weeklyGoal) || weeklyGoal < 1 || weeklyGoal > 21) {
    throw badRequest('weeklyGoal must be a whole number between 1 and 21');
  }

  // Optional: a profile made before the dial existed simply runs at medium.
  let intensity: OnboardRequest['intensity'];
  if (input.intensity !== undefined && input.intensity !== null) {
    if (!isIntensity(input.intensity)) throw badRequest('intensity must be easy, medium or hard');
    intensity = input.intensity;
  }

  const timezone = asString(input.timezone, 'timezone');
  if (!isValidTimezone(timezone)) {
    throw badRequest(`timezone "${timezone}" is not a known IANA timezone`);
  }

  const monthlyGoal = optionalGoal(input.monthlyGoal, 'monthlyGoal', 1, 93);
  const yearlyGoal = optionalGoal(input.yearlyGoal, 'yearlyGoal', 1, 1095);

  return {
    name,
    weeklyGoal,
    timezone,
    ...(intensity ? { intensity } : {}),
    ...(monthlyGoal !== undefined ? { monthlyGoal } : {}),
    ...(yearlyGoal !== undefined ? { yearlyGoal } : {}),
  };
}

export function parseWorkoutsRequest(body: unknown): WorkoutInput[] {
  const input = asObject(body, 'body');
  if (!Array.isArray(input.workouts)) throw badRequest('workouts must be an array');
  if (input.workouts.length > MAX_WORKOUTS_PER_REQUEST) {
    throw badRequest(`send at most ${MAX_WORKOUTS_PER_REQUEST} workouts per request`);
  }
  return input.workouts.map((workout, index) => parseWorkout(workout, `workouts[${index}]`));
}

function parseWorkout(value: unknown, at: string): WorkoutInput {
  const input = asObject(value, at);

  const hkUuid = asString(input.hkUuid, `${at}.hkUuid`).trim();
  if (hkUuid.length === 0) throw badRequest(`${at}.hkUuid must not be empty`);
  if (hkUuid.length > 200) throw badRequest(`${at}.hkUuid is too long`);

  const type = asString(input.type, `${at}.type`).trim();
  if (type.length === 0) throw badRequest(`${at}.type must not be empty`);
  if (type.length > 100) throw badRequest(`${at}.type is too long`);

  const start = asString(input.start, `${at}.start`);
  const startMs = parseIso(start);
  if (startMs === null) throw badRequest(`${at}.start is not an ISO 8601 timestamp`);

  // `end` is null for a workout still in progress.
  let end: string | null = null;
  if (input.end !== null && input.end !== undefined) {
    end = asString(input.end, `${at}.end`);
    const endMs = parseIso(end);
    if (endMs === null) throw badRequest(`${at}.end is not an ISO 8601 timestamp`);
    if (endMs < startMs) throw badRequest(`${at}.end is before ${at}.start`);
  }

  const durationSec = asNumber(input.durationSec, `${at}.durationSec`);
  if (!Number.isFinite(durationSec) || durationSec < 0) {
    throw badRequest(`${at}.durationSec must be a non-negative number`);
  }

  let activeKcal: number | null = null;
  if (input.activeKcal !== null && input.activeKcal !== undefined) {
    activeKcal = asNumber(input.activeKcal, `${at}.activeKcal`);
    if (!Number.isFinite(activeKcal) || activeKcal < 0) {
      throw badRequest(`${at}.activeKcal must be a non-negative number`);
    }
  }

  let source: string | null = null;
  if (input.source !== null && input.source !== undefined) {
    source = asString(input.source, `${at}.source`).trim() || null;
    if (source && source.length > 200) throw badRequest(`${at}.source is too long`);
  }

  // Absent means "recorded", which keeps a client that predates the field
  // working. The app sends it explicitly for anything typed in by hand.
  let wasUserEntered = false;
  if (input.wasUserEntered !== null && input.wasUserEntered !== undefined) {
    if (typeof input.wasUserEntered !== 'boolean') {
      throw badRequest(`${at}.wasUserEntered must be a boolean`);
    }
    wasUserEntered = input.wasUserEntered;
  }

  return { hkUuid, type, start, end, durationSec, activeKcal, source, wasUserEntered };
}

/** `?since=<eventId>` — absent means "from the beginning". */
export function parseSince(raw: string | null): number {
  if (raw === null || raw === '') return 0;
  const since = Number(raw);
  if (!Number.isInteger(since) || since < 0 || since > MAX_SINCE) {
    throw badRequest('since must be a non-negative whole number');
  }
  return since;
}

// --- primitives ------------------------------------------------------------

function asObject(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badRequest(`${at} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, at: string): string {
  if (typeof value !== 'string') throw badRequest(`${at} must be a string`);
  return value;
}

function asNumber(value: unknown, at: string): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw badRequest(`${at} must be a number`);
  }
  return value;
}

/** POST /competitions — creating one. */
export function parseCompetitionRequest(body: unknown): {
  kind: 'solo' | 'h2h' | 'group';
  name: string;
  goal: { type: 'workouts' | 'activeHours' | 'activeDays'; target: number };
  sol?: number;
  days: number;
} {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'bad_request', 'body must be a JSON object');
  }
  const raw = body as Record<string, unknown>;

  const kind = raw.kind === undefined ? 'group' : raw.kind;
  if (kind !== 'solo' && kind !== 'h2h' && kind !== 'group') {
    throw new HttpError(400, 'bad_request', 'kind must be solo, h2h or group');
  }

  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) throw new HttpError(400, 'bad_request', 'name is required');
  if (name.length > 80) throw new HttpError(400, 'bad_request', 'name must be at most 80 characters');

  const goalRaw = raw.goal;
  if (typeof goalRaw !== 'object' || goalRaw === null || Array.isArray(goalRaw)) {
    throw new HttpError(400, 'bad_request', 'goal must be an object');
  }
  const goal = goalRaw as Record<string, unknown>;
  const type = goal.type;
  if (type !== 'workouts' && type !== 'activeHours' && type !== 'activeDays') {
    throw new HttpError(400, 'bad_request', 'goal.type must be workouts, activeHours or activeDays');
  }
  const target = goal.target;
  if (typeof target !== 'number' || !Number.isFinite(target) || target <= 0 || target > 1000) {
    throw new HttpError(400, 'bad_request', 'goal.target must be a positive number');
  }

  let sol: number | undefined;
  if (raw.sol !== undefined && raw.sol !== null) {
    if (typeof raw.sol !== 'number' || !Number.isFinite(raw.sol)) {
      throw new HttpError(400, 'bad_request', 'sol must be a number');
    }
    sol = raw.sol;
  }

  const days = raw.days === undefined ? 7 : raw.days;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 90) {
    throw new HttpError(400, 'bad_request', 'days must be a whole number between 1 and 90');
  }

  return { kind, name, goal: { type, target }, sol, days };
}

/**
 * POST /wallet/topup — `{ "sol": 0.1 }`.
 *
 * Returns lamports, because that is the only unit anything below this line
 * uses. Float SOL exists exactly once, here, where a person typed it: 0.1 SOL
 * is not representable in binary and rounding it at every layer is how a
 * balance ends up one lamport short of what was deposited.
 */
export function parseTopUpRequest(body: unknown): number {
  const raw = asObject(body, 'body');
  const sol = asNumber(raw.sol, 'sol');
  if (!Number.isFinite(sol) || sol <= 0) {
    throw badRequest('sol must be a positive number');
  }
  const lamports = Math.round(sol * LAMPORTS_PER_SOL);
  if (lamports < MIN_TOPUP_LAMPORTS || lamports > MAX_TOPUP_LAMPORTS) {
    throw badRequest('top up between 0.01 and 1 SOL at a time');
  }
  return lamports;
}
