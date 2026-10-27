import { describe, expect, it } from 'vitest';
import { netPayoutSats } from './payout';

describe('netPayoutSats', () => {
  it.each([
    [0, 0],
    [1, 0],
    [20, 19],
    [21, 19],
    [1000, 950],
    [1001, 950],
  ])('floors %i sats to %i', (gross, net) => {
    expect(netPayoutSats(gross)).toBe(net);
  });

  it('clamps a negative gross to zero', () => {
    expect(netPayoutSats(-5)).toBe(0);
  });
});
