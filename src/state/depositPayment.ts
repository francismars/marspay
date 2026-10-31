import { createPaymentHashClaim } from './seenPaymentHashes';

const claimDeposit = createPaymentHashClaim();

/**
 * Remember a Lightning payment before the player is credited.
 * Returns false when this hash was already claimed, so a webhook retry cannot credit it again.
 */
export function claimDepositPaymentHash(paymentHash: string): boolean {
  return claimDeposit(paymentHash);
}
