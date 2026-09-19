/**
 * Formatting SOL amounts for anything a person reads.
 *
 * Its own module because it is worth testing on its own. The trace, the
 * commitment card and every message the agent sends quote amounts, and an
 * amount that reads wrong is worse than one that reads ugly.
 */

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
