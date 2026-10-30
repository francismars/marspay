import type { Socket } from 'socket.io';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./challengeClaimStore', () => ({
  appendPaidClaim: vi.fn(async () => {}),
  loadDailySpendForDaySync: vi.fn(() => 0),
  loadPaidClaimsSync: vi.fn(() => new Map()),
  recordDailySpendPersisted: vi.fn(async () => {}),
}));

vi.mock('../calls/nostr/challengeEligibility', () => ({
  evaluateChallengeEligibility: vi.fn(async () => ({ eligible: true })),
}));

vi.mock('../calls/NDK/zapRecipientKind1Note', () => ({
  zapRecipientKind1Note: vi.fn(),
}));

vi.mock('../telemetry/trackEvent', () => ({
  trackEvent: vi.fn(),
  trackReject: vi.fn(),
  pubkeyPrefix: (pubkey: string) => pubkey.slice(0, 12),
}));

vi.mock('nostr-tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('nostr-tools')>();
  return {
    ...actual,
    verifyEvent: vi.fn(() => true),
  };
});

import { zapRecipientKind1Note } from '../calls/NDK/zapRecipientKind1Note';
import { claimChallengeBountyHandler } from '../socket/challengeBounty';
import { registerAppNostrSession } from './nostrAppSessionState';
import {
  checkChallengeRunRateLimit,
  checkChallengeSubmitRateLimit,
} from './challengeRateLimit';
import {
  createChallengeRun,
  createClaimToken,
  getDailyZapBudgetRemaining,
  recordDailyZapSpend,
} from './challengeState';

const PUBKEY = 'ab'.repeat(32);

afterEach(() => {
  vi.useRealTimers();
});

describe('challenge daily budget', () => {
  it('spends 21 sats from the 100,000 sat cap and starts fresh the next day', () => {
    process.env.CHALLENGE_BOUNTY_DAILY_CAP_SATS = '100000';

    expect(getDailyZapBudgetRemaining()).toBe(100_000);
    recordDailyZapSpend(21);
    expect(getDailyZapBudgetRemaining()).toBe(99_979);

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2031-06-02T00:00:00.000Z'));
    expect(getDailyZapBudgetRemaining()).toBe(100_000);
  });

  it('rejects a bounty larger than the remainder without publishing or zapping', async () => {
    process.env.CHALLENGE_BOUNTY_DAILY_CAP_SATS = '20';
    const sessionID = 'challenge-over-budget';
    registerAppNostrSession(
      sessionID,
      PUBKEY,
      {
        pubkey: PUBKEY,
        name: 'Ada',
        picture: null,
        nip05: null,
        lud16: 'ada@example.com',
        lud06: null,
      },
      'extension'
    );
    const run = createChallengeRun({ pubkey: PUBKEY, sessionID, challengeId: 'normie' });
    if ('error' in run) {
      throw new Error(run.error);
    }
    const claim = createClaimToken({
      run,
      noteContent: 'win',
      noteTags: [['t', 'chainduel']],
    });
    const emitted: Array<{ event: string; payload: { ok: boolean; reason?: string } }> = [];

    await claimChallengeBountyHandler(fakeSocket(sessionID, emitted), {
      claimToken: claim.token,
      event: {
        kind: 1,
        pubkey: PUBKEY,
        content: 'win',
        tags: [['t', 'chainduel']],
        created_at: 0,
        id: 'event',
        sig: 'sig',
      },
    });

    expect(emitted).toEqual([
      { event: 'resChallengeClaim', payload: { ok: false, reason: 'daily_budget_exceeded' } },
    ]);
    expect(zapRecipientKind1Note).not.toHaveBeenCalled();
  });
});

describe('challenge rate limits', () => {
  it('allows 12 runs per session per minute and rejects the 13th', () => {
    const sessionID = 'rate-run';
    for (let i = 0; i < 12; i += 1) {
      expect(checkChallengeRunRateLimit(sessionID)).toBe(true);
    }
    expect(checkChallengeRunRateLimit(sessionID)).toBe(false);
    expect(checkChallengeRunRateLimit('rate-run-other')).toBe(true);
  });

  it('allows 30 submits per session per minute', () => {
    const sessionID = 'rate-submit';
    for (let i = 0; i < 30; i += 1) {
      expect(checkChallengeSubmitRateLimit(sessionID)).toBe(true);
    }
    expect(checkChallengeSubmitRateLimit(sessionID)).toBe(false);
    expect(checkChallengeSubmitRateLimit('rate-submit-other')).toBe(true);
  });
});

function fakeSocket(
  sessionID: string,
  emitted: Array<{ event: string; payload: { ok: boolean; reason?: string } }>
): Socket {
  return {
    data: { sessionID },
    emit: (event: string, payload: { ok: boolean; reason?: string }) => {
      emitted.push({ event, payload });
    },
  } as unknown as Socket;
}
