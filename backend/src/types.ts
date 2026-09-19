/**
 * Wire shapes from docs/API.md — the contract with the iOS app.
 * Do not change anything in this file without telling the iOS side first.
 */

export type CommitmentStatus = 'pending' | 'met' | 'missed' | 'renegotiated';

export type StakeStatus = 'none' | 'held' | 'released' | 'slashed';

export type TraceKind =
  | 'commitment_created'
  | 'alarm_fired'
  | 'context'
  | 'decision'
  | 'message_sent'
  | 'message_received'
  | 'workout_detected'
  | 'stake_held'
  | 'stake_released'
  | 'stake_slashed';

/** POST /onboard */
export interface OnboardRequest {
  name: string;
  weeklyGoal: number;
  timezone: string;
}

export interface OnboardResponse {
  userId: string;
  token: string;
  linkCode: string;
  snapContact: { telegram: string; imessage: string };
}

/** POST /workouts */
export interface WorkoutInput {
  hkUuid: string;
  type: string;
  start: string;
  /** null while the workout is still in progress. */
  end: string | null;
  durationSec: number;
  activeKcal: number | null;
  /** Bundle id of whatever wrote the sample: a Watch, Strava, Hevy, Snap. */
  source: string | null;
  /** True when a human typed it into the Health app instead of recording it. */
  wasUserEntered: boolean;
}

export interface WorkoutsRequest {
  workouts: WorkoutInput[];
}

export interface WorkoutsResponse {
  accepted: number;
}

/** GET /state */
export interface Stake {
  lamports: number;
  status: StakeStatus;
  txSig: string | null;
}

export interface Commitment {
  id: string;
  text: string;
  dueAt: string;
  graceMin: number;
  status: CommitmentStatus;
  stake: Stake;
}

export interface StateResponse {
  weeklyGoal: number;
  workoutsThisWeek: number;
  linked: boolean;
  commitments: Commitment[];
}

/** GET /trace?since=<eventId> */
export interface TraceEvent {
  id: number;
  ts: string;
  kind: TraceKind;
  summary: string;
  data?: unknown;
}

export interface TraceResponse {
  events: TraceEvent[];
}
