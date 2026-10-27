/** Winner receives this fraction of the gross pot. The rest is the house fee. */
export const PAYOUT_MULTIPLIER = 0.95;

/** Sats paid to the winner. Fractional sats are floored, and the result is never negative. */
export function netPayoutSats(grossSats: number): number {
  return Math.max(0, Math.floor(grossSats * PAYOUT_MULTIPLIER));
}
