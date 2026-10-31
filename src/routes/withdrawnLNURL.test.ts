import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GameMode, PlayerRole } from '../types/game';
import { getGameInfoFromID, setGameInfoByID } from '../state/gameState';
import { getLNURLWFromID, setIDToLNURLW, setLNURLWToID } from '../state/lnurlwState';

const emit = vi.fn();

vi.mock('../io', () => ({
  io: {
    to: vi.fn(() => ({ emit })),
  },
}));

vi.mock('../socket/onlineRoom', () => ({
  broadcastOnlineRoomLists: vi.fn(),
}));

vi.mock('../utils/json', () => ({
  appendGameInfotoJSON: vi.fn(),
}));

vi.mock('../calls/LNBits/deleteLNURLW', () => ({
  default: vi.fn(async () => null),
}));

vi.mock('../calls/LNBits/deleteLNURLP', () => ({
  default: vi.fn(async () => null),
}));

import { broadcastOnlineRoomLists } from '../socket/onlineRoom';
import { io } from '../io';
import withdrawnLNURL from './withdrawnLNURL';

const WEBHOOK_SECRET = 'test-webhook-secret';

const app = express();
app.use(express.json());
app.use('/api/LNURL/withdrawn', withdrawnLNURL);

beforeEach(() => {
  process.env.LNBITS_WEBHOOK_SECRET = WEBHOOK_SECRET;
  emit.mockClear();
  vi.mocked(io.to).mockClear();
  vi.mocked(broadcastOnlineRoomLists).mockClear();
});

describe('withdrawn LNURL webhook', () => {
  it('rejects a caller that does not know the webhook secret and leaves the game in place', async () => {
    const sessionID = 'withdraw-wrong-secret';
    seedGame(sessionID, GameMode.P2P);
    seedWithdraw(sessionID, 'lnurlw-wrong-secret');

    const res = await post('/api/LNURL/withdrawn', { lnurlw: 'lnurlw-wrong-secret' }, 'wrong-secret');

    expect(res.status).toBe(403);
    expect(res.text).toBe('Access denied');
    expect(getGameInfoFromID(sessionID)?.mode).toBe(GameMode.P2P);
    expect(getLNURLWFromID(sessionID)?.id).toBe('lnurlw-wrong-secret');
    expect(emit).not.toHaveBeenCalled();
  });

  it('rejects a missing or unknown LNURL-withdraw', async () => {
    const missing = await post('/api/LNURL/withdrawn', {});
    const unknown = await post('/api/LNURL/withdrawn', { lnurlw: 'missing-withdraw' });

    expect(missing.status).toBe(404);
    expect(missing.text).toBe('LNURLw not sent.');
    expect(unknown.status).toBe(404);
    expect(unknown.text).toBe('Session ID not found.');
    expect(emit).not.toHaveBeenCalled();
  });

  it('emits prizeWithdrawn and ends a normal game', async () => {
    const sessionID = 'withdraw-p2p';
    seedGame(sessionID, GameMode.P2P);
    seedWithdraw(sessionID, 'lnurlw-p2p');

    const res = await post('/api/LNURL/withdrawn', {
      lnurlw: 'lnurlw-p2p',
      payment_hash: 'hash-p2p',
    });

    expect(res.status).toBe(200);
    expect(res.text).toBe('{"body":"Withdrawn"}');
    expect(io.to).toHaveBeenCalledWith(`marspay:session:${sessionID}`);
    expect(emit).toHaveBeenCalledWith('prizeWithdrawn');
    expect(broadcastOnlineRoomLists).toHaveBeenCalledOnce();
    expect(getGameInfoFromID(sessionID)).toBeUndefined();
    expect(getLNURLWFromID(sessionID)).toBeUndefined();
  });

  it('keeps a tournament open until the claim that fills the last withdrawal', async () => {
    const sessionID = 'withdraw-tournament';
    seedGame(sessionID, GameMode.TOURNAMENT);
    seedWithdraw(sessionID, 'lnurlw-tournament', { claimedCount: 0, maxWithdrawals: 2 });

    const first = await post('/api/LNURL/withdrawn', {
      lnurlw: 'lnurlw-tournament',
      payment_hash: 'hash-tournament-1',
    });

    expect(first.status).toBe(200);
    expect(getLNURLWFromID(sessionID)?.claimedCount).toBe(1);
    expect(getGameInfoFromID(sessionID)?.mode).toBe(GameMode.TOURNAMENT);

    const last = await post('/api/LNURL/withdrawn', {
      lnurlw: 'lnurlw-tournament',
      payment_hash: 'hash-tournament-2',
    });

    expect(last.status).toBe(200);
    expect(getGameInfoFromID(sessionID)).toBeUndefined();
    expect(getLNURLWFromID(sessionID)).toBeUndefined();
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('counts a withdraw hash once when the webhook is retried', async () => {
    const sessionID = 'withdraw-replay';
    seedGame(sessionID, GameMode.TOURNAMENT);
    seedWithdraw(sessionID, 'lnurlw-replay', { claimedCount: 0, maxWithdrawals: 2 });
    const body = { lnurlw: 'lnurlw-replay', payment_hash: 'HASH-Replay' };

    const first = await post('/api/LNURL/withdrawn', body);
    const retry = await post('/api/LNURL/withdrawn', {
      ...body,
      payment_hash: ' hash-replay ',
    });

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.text).toBe('{"body":"Withdrawn"}');
    expect(getLNURLWFromID(sessionID)?.claimedCount).toBe(1);
    expect(getGameInfoFromID(sessionID)?.mode).toBe(GameMode.TOURNAMENT);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('prizeWithdrawn');
    expect(broadcastOnlineRoomLists).toHaveBeenCalledOnce();
  });

  it('refuses a withdraw that has no payment hash', async () => {
    const sessionID = 'withdraw-no-hash';
    seedGame(sessionID, GameMode.TOURNAMENT);
    seedWithdraw(sessionID, 'lnurlw-no-hash', { claimedCount: 0, maxWithdrawals: 2 });

    const res = await post('/api/LNURL/withdrawn', { lnurlw: 'lnurlw-no-hash' });

    expect(res.status).toBe(400);
    expect(res.text).toBe('payment_hash not sent.');
    expect(getLNURLWFromID(sessionID)?.claimedCount).toBe(0);
    expect(getGameInfoFromID(sessionID)?.mode).toBe(GameMode.TOURNAMENT);
    expect(emit).not.toHaveBeenCalled();
    expect(broadcastOnlineRoomLists).not.toHaveBeenCalled();
  });
});

function seedGame(sessionID: string, mode: GameMode) {
  setGameInfoByID(sessionID, {
    mode,
    numberOfPlayers: mode === GameMode.TOURNAMENT ? 2 : undefined,
    players: new Map([[PlayerRole.Player1, { name: 'Ada', value: 1000, payments: [] }]]),
  });
}

function seedWithdraw(
  sessionID: string,
  lnurlw: string,
  counts?: { claimedCount: number; maxWithdrawals: number }
) {
  setIDToLNURLW(sessionID, {
    id: lnurlw,
    lnurlw,
    claimedCount: counts?.claimedCount,
    maxWithdrawals: counts?.maxWithdrawals,
  });
  setLNURLWToID(lnurlw, sessionID);
}

function post(
  path: string,
  body: unknown,
  secret: string = WEBHOOK_SECRET
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (secret !== '') headers['x-webhook-secret'] = secret;
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
        .then(async (res) => {
          const text = await res.text();
          server.close(() => resolve({ status: res.status, text }));
        })
        .catch((error: unknown) => {
          server.close(() => reject(error));
        });
    });
    server.on('error', reject);
  });
}
