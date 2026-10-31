import { createPaymentHashClaim } from './seenPaymentHashes';

const claimWithdraw = createPaymentHashClaim();

/**
 * Remember a Lightning withdrawal before claimedCount moves.
 * Returns false when this hash was already claimed, so a webhook retry cannot count it again.
 */
export function claimWithdrawPaymentHash(paymentHash: string): boolean {
  return claimWithdraw(paymentHash);
}
