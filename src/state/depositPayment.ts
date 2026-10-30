const seenDepositPaymentHashes = new Set<string>();

/**
 * Remember a Lightning payment before the player is credited.
 * Returns false when this hash was already claimed, so a webhook retry cannot credit it again.
 */
export function claimDepositPaymentHash(paymentHash: string): boolean {
  if (seenDepositPaymentHashes.has(paymentHash)) {
    return false;
  }
  seenDepositPaymentHashes.add(paymentHash);
  return true;
}
