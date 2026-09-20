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
  | 'stake_slashed'
  | 'reaction_sent'
  | 'reaction_received'
  | 'photo_accepted'
  | 'photo_rejected'
  | 'wallet_funded';

/** POST /onboard */
export interface OnboardRequest {
  name: string;
  weeklyGoal: number;
  timezone: string;
  /** `easy | medium | hard`. How hard Snap pushes. Defaults to medium. */
  intensity?: 'easy' | 'medium' | 'hard';
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

/**
 * The photo that verified a session.
 *
 * Null until one lands. The app draws the difference — a plan with no proof
 * is asking for a picture, a plan with proof is done — so this is the one
 * field on a commitment that changes what the user is being told to do.
 */
export interface Proof {
  at: string;
  /** What the vision model saw, one sentence. Shown to the user.  */
  description: string;
}

/**
 * One time the session was moved. Kept as a list rather than a counter
 * because the count only answers "can they move it again"; the list answers
 * "is this person always moving them", which is the question worth asking.
 */
export interface Reschedule {
  /** When they asked. */
  at: string;
  /** The deadline before and after the move. */
  from: string;
  to: string;
}

export interface Commitment {
  id: string;
  text: string;
  dueAt: string;
  graceMin: number;
  status: CommitmentStatus;
  stake: Stake;
  /** Every move, oldest first. Empty on a commitment nobody has touched. */
  reschedules: Reschedule[];
  proof: Proof | null;
  /**
   * How the session was verified once it is settled: the photo they sent, or
   * the watch quietly covering them when they forgot. Null while open, and
   * on a commitment that was missed.
   */
  verifiedBy: 'photo' | 'watch' | null;
}

export interface StateResponse {
  weeklyGoal: number;
  workoutsThisWeek: number;
  linked: boolean;
  commitments: Commitment[];
}

/** GET /wallet */
export interface WalletEntry {
  id: number;
  /** What moved the money. Mirrors the trace kinds that touch the wallet. */
  kind: 'funded' | 'held' | 'released' | 'slashed';
  /** Always positive: `kind` says which way it went. */
  lamports: number;
  label: string;
  at: string;
  txSig: string | null;
}

export interface WalletResponse {
  address: string;
  cluster: 'devnet';
  /**
   * Spendable right now, read from the chain. Null when the RPC could not be
   * reached — the app says "can't reach the chain" rather than showing a zero
   * balance, which would read as "your money is gone".
   */
  balanceLamports: number | null;
  /** Locked in escrow against open commitments and competition entries. */
  heldLamports: number;
  /** True once the treasury has put something in it. */
  funded: boolean;
  /** Newest first, capped. Deposits, locks, returns and slashes. */
  entries: WalletEntry[];
}

/** POST /wallet/topup */
export interface TopUpResponse extends WalletResponse {
  addedLamports: number;
  txSig: string | null;
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
