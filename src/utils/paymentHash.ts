/** Trim and lowercase a Lightning payment hash. Empty values are rejected. */
export function normalizePaymentHash(paymentHash: unknown): string | null {
  if (typeof paymentHash !== 'string') return null;
  const hash = paymentHash.trim().toLowerCase();
  if (hash === '') return null;
  return hash;
}
