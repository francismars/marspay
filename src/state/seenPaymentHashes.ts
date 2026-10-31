const MAX_SEEN_PAYMENT_HASHES = 10_000;

/**
 * Remember payment hashes in insertion order.
 * Once the cap is passed, the oldest hash is dropped.
 */
export function createPaymentHashClaim(limit = MAX_SEEN_PAYMENT_HASHES) {
  const seen = new Set<string>();
  return (paymentHash: string): boolean => {
    if (seen.has(paymentHash)) {
      return false;
    }
    seen.add(paymentHash);
    if (seen.size > limit) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) {
        seen.delete(oldest);
      }
    }
    return true;
  };
}
