import { describe, expect, it } from 'vitest';
import { createPaymentHashClaim } from './seenPaymentHashes';

describe('createPaymentHashClaim', () => {
  it('claims a hash once and drops the oldest hash past the cap', () => {
    const claim = createPaymentHashClaim(2);

    expect(claim('a')).toBe(true);
    expect(claim('a')).toBe(false);
    expect(claim('b')).toBe(true);
    expect(claim('c')).toBe(true);
    expect(claim('a')).toBe(true);
    expect(claim('c')).toBe(false);
  });
});
