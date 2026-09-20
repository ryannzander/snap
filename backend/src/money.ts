/**
 * Formatting SOL amounts for anything a person reads.
 *
 * Its own module because it is worth testing on its own. The trace, the
 * commitment card and every message the agent sends quote amounts, and an
 * amount that reads wrong is worse than one that reads ugly.
 */

import { MAX_DEFAULT_STAKE_LAMPORTS } from './agent/intensity';

export const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * What POST /wallet/topup will move in one go, and how full a wallet is
 * allowed to get. Here rather than next to the route or the Durable Object
 * because both of them enforce it — the edge rejects the obvious cases before
 * any work is done, and the object re-checks against the live balance — and
 * two copies of a money limit is one copy too many.
 */
export const MIN_TOPUP_LAMPORTS = 10_000_000; // 0.01 SOL
export const MAX_TOPUP_LAMPORTS = LAMPORTS_PER_SOL; // 1 SOL

/**
 * The treasury funds top-ups on devnet, so a wallet must not be usable as a
 * tap: past this a top-up is refused rather than draining the account every
 * other part of the demo depends on.
 */
export const WALLET_CEILING_LAMPORTS = 2 * LAMPORTS_PER_SOL;

/**
 * Signing costs lamports, and a wallet emptied to the last one cannot pay for
 * the transfer that releases the stake back into it. Staking leaves this much
 * behind.
 */
export const FEE_HEADROOM_LAMPORTS = 5_000_000;

/**
 * What a new wallet starts with: the biggest stake the intensity dial can put
 * up on its own, plus enough fee headroom to stake, release and still move.
 *
 * It was a flat 0.1 SOL, written when every default stake was 0.05. HARD puts
 * up 0.1, so a new HARD user's very first offer was refused for want of funds
 * — *"their wallet holds 0.1 SOL and this stake needs 0.1 SOL"* — and Snap
 * said nothing about a stake at all. Derived, so adding a harder mode cannot
 * quietly bring that back.
 *
 * Then it was doubled, for "room for a second stake", and that was the wrong
 * trade. Every new wallet is a withdrawal from one devnet treasury nobody can
 * top up on stage, and doubling it halved how many people could onboard before
 * funding started failing — which is exactly how it failed: *"Transfer:
 * insufficient lamports 129570000, need 210000000"*, discovered by onboarding
 * a test user rather than by anything in the app saying so. Nobody needs two
 * stakes in flight; a second one is refused by the one-open-commitment rule
 * anyway. One stake and three fees' worth of room is the honest number, and it
 * supports twice as many users out of the same treasury.
 */
export const USER_FUNDING_LAMPORTS = MAX_DEFAULT_STAKE_LAMPORTS + 3 * FEE_HEADROOM_LAMPORTS;

/**
 * "0.05 SOL", "0.025 SOL", "1 SOL", "0.0005 SOL".
 *
 * Exact, with trailing zeros trimmed — never a fixed number of places. Half
 * of a 0.05 SOL stake is 0.025, which two decimals round to 0.03, so a slash
 * read "0.03 back, 0.03 forfeited" out of a 0.05 stake. Three decimals only
 * moved the same bug down to the 0.001 minimum, whose halves both round back
 * up to 0.001 and display as twice what was staked.
 *
 * A lamport is a billionth, so nine places can always represent the amount
 * exactly and the halves of anything always add back up to the whole.
 * Trimmed as a string rather than through Number(), which would render small
 * amounts in scientific notation.
 */
export function solText(lamports: number): string {
  const exact = (lamports / LAMPORTS_PER_SOL).toFixed(9);
  const trimmed = exact.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return `${trimmed} SOL`;
}
