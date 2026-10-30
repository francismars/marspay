import crypto from 'crypto';

/** Compare two secrets in constant time. Empty values never match. */
export function secretEqual(provided: string, expected: string): boolean {
  if (provided.length === 0 || expected.length === 0) {
    return false;
  }
  const providedHash = crypto.createHash('sha256').update(provided).digest();
  const expectedHash = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(providedHash, expectedHash);
}
