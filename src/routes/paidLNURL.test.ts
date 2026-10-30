import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameMode, PlayerRole } from '../types/game';
import { getGameInfoFromID, setGameInfoByID } from '../state/gameState';
import { appendLNURLPToID, setLNURLPToID } from '../state/lnurlpState';

const payInvoice = vi.fn(async () => ({}));
const getLNURLCallback = vi.fn(async () => 'https://cb.example/callback');
const getInvoiceFromCallback = vi.fn(async (_callback: string, sats: number) => `invoice-${sats}`);

vi.mock('../server', () => ({
  io: {
    to: vi.fn(() => ({ emit: vi.fn() })),
    sockets: { adapter: { rooms: new Map() } },
  },
}));

vi.mock('../calls/LNBits/payInvoice', () => ({
  default: (...args: unknown[]) => payInvoice(...args),
}));

vi.mock('../calls/LNAddress/getLNURLCallback', () => ({
  default: (...args: unknown[]) => getLNURLCallback(...args),
}));

vi.mock('../calls/LNAddress/getInvoiceFromCallback', () => ({
  default: (...args: unknown[]) => getInvoiceFromCallback(...args),
}));

vi.mock('../telemetry/trackEvent', () => ({
  trackEvent: vi.fn(),
}));

import { trackEvent } from '../telemetry/trackEvent';
import paidLNURL from './paidLNURL';

const LNBITS_IP = '203.0.113.5';

const app = express();
app.use(express.json());
app.use('/api/LNURL/paid', paidLNURL);

beforeEach(() => {
  process.env.LNBITS_IP = LNBITS_IP;
  process.env.DEVELOPER_LNADDRESS = 'dev@example.com';
  process.env.DESIGNER_LNADDRESS = 'designer@example.com';
  process.env.HOST_LNADDRESS = 'host@example.com';
  payInvoice.mockClear();
  getLNURLCallback.mockClear();
  getInvoiceFromCallback.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('paid LNURL webhook', () => {
  it('rejects a caller that is not LNbits and leaves the balance unchanged', async () => {
    const sessionID = 'paid-wrong-ip';
    seedPayLink(sessionID, 'lnurl-wrong-ip', 500);

    const res = await post('/api/LNURL/paid', { lnurlp: 'lnurl-wrong-ip', amount: 10_000_000 }, '198.51.100.1');

    expect(res.status).toBe(403);
    expect(res.text).toBe('Access denied');
    expect(getGameInfoFromID(sessionID)?.players.get(PlayerRole.Player1)?.value).toBe(500);
    expect(payInvoice).not.toHaveBeenCalled();
  });

  it('rejects a missing or unknown LNURL', async () => {
    const missing = await post('/api/LNURL/paid', { amount: 1000 }, LNBITS_IP);
    const unknown = await post('/api/LNURL/paid', { lnurlp: 'missing-link', amount: 1000 }, LNBITS_IP);

    expect(missing.status).toBe(404);
    expect(missing.text).toBe('LNURLp not sent.');
    expect(unknown.status).toBe(404);
    expect(unknown.text).toBe('Session ID not found.');
    expect(payInvoice).not.toHaveBeenCalled();
  });

  it('credits the player in sats and pays the three splits when no socket is connected', async () => {
    const sessionID = 'paid-credit';
    seedPayLink(sessionID, 'lnurl-credit', 0, 'host@getalby.com');

    const res = await post(
      '/api/LNURL/paid',
      {
        lnurlp: 'lnurl-credit',
        amount: 10_000_000,
        comment: 'Ada',
        payment_hash: 'hash-credit',
      },
      LNBITS_IP
    );

    expect(res.status).toBe(200);
    const player = getGameInfoFromID(sessionID)?.players.get(PlayerRole.Player1);
    expect(player?.value).toBe(10_000);
    expect(player?.name).toBe('Ada');
    await vi.waitFor(() => expect(payInvoice).toHaveBeenCalledTimes(3));
    expect(getLNURLCallback.mock.calls.map((call) => call[0])).toEqual([
      'https://example.com/.well-known/lnurlp/dev',
      'https://getalby.com/.well-known/lnurlp/host',
      'https://example.com/.well-known/lnurlp/designer',
    ]);
    expect(getInvoiceFromCallback.mock.calls.map((call) => call[1])).toEqual([195, 195, 95]);
    expect(payInvoice.mock.calls.map((call) => call[0])).toEqual([
      'invoice-195',
      'invoice-195',
      'invoice-95',
    ]);
  });

  it('does not pay a split that floors to zero', async () => {
    const sessionID = 'paid-dust';
    seedPayLink(sessionID, 'lnurl-dust', 0);

    const res = await post(
      '/api/LNURL/paid',
      { lnurlp: 'lnurl-dust', amount: 1000, payment_hash: 'hash-dust' },
      LNBITS_IP
    );

    expect(res.status).toBe(200);
    expect(getGameInfoFromID(sessionID)?.players.get(PlayerRole.Player1)?.value).toBe(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(getLNURLCallback).not.toHaveBeenCalled();
    expect(payInvoice).not.toHaveBeenCalled();
  });

  it('stores a cleaned payment note', async () => {
    const messy = await payNamed('paid-note-messy', 'lnurl-messy', '  Ada\u0000  Bee  ');
    const clipped = await payNamed('paid-note-long', 'lnurl-long', 'a'.repeat(80));
    const blank = await payNamed('paid-note-blank', 'lnurl-blank', ' \u0001 ', null);
    const joined = await payNamed('paid-note-array', 'lnurl-array', ['Ada', ' Bee']);

    expect(messy).toBe('Ada Bee');
    expect(clipped).toBe('a'.repeat(64));
    expect(blank).toBe(PlayerRole.Player1);
    expect(joined).toBe('Ada Bee');
  });

  it('answers when the session has no LNURL list', async () => {
    setLNURLPToID('lnurl-no-list', 'paid-no-list');

    const res = await post(
      '/api/LNURL/paid',
      { lnurlp: 'lnurl-no-list', amount: 10_000_000, payment_hash: 'hash-no-list' },
      LNBITS_IP
    );

    expect(res.status).toBe(404);
    expect(res.text).toBe('LNURLp not found for session.');
    expect(payInvoice).not.toHaveBeenCalled();
  });

  it('refuses to credit a payment that has no hash', async () => {
    const sessionID = 'paid-no-hash';
    seedPayLink(sessionID, 'lnurl-no-hash', 500);

    const res = await post(
      '/api/LNURL/paid',
      { lnurlp: 'lnurl-no-hash', amount: 10_000_000 },
      LNBITS_IP
    );

    expect(res.status).toBe(400);
    expect(res.text).toBe('payment_hash not sent.');
    expect(getGameInfoFromID(sessionID)?.players.get(PlayerRole.Player1)?.value).toBe(500);
    expect(payInvoice).not.toHaveBeenCalled();
  });

  it('credits a payment hash once and ignores the retry', async () => {
    const sessionID = 'paid-replay';
    seedPayLink(sessionID, 'lnurl-replay', 0);
    const body = {
      lnurlp: 'lnurl-replay',
      amount: 10_000_000,
      payment_hash: 'HASH-Replay',
    };

    const first = await post('/api/LNURL/paid', body, LNBITS_IP);
    const retry = await post('/api/LNURL/paid', { ...body, payment_hash: ' hash-replay ' }, LNBITS_IP);

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.text).toBe('OK');
    expect(getGameInfoFromID(sessionID)?.players.get(PlayerRole.Player1)?.value).toBe(10_000);
    await vi.waitFor(() => expect(payInvoice).toHaveBeenCalledTimes(3));
  });

  it('skips a split whose address is missing and still pays the others', async () => {
    delete process.env.DESIGNER_LNADDRESS;
    const sessionID = 'paid-missing-address';
    seedPayLink(sessionID, 'lnurl-missing-address', 0);

    const res = await post(
      '/api/LNURL/paid',
      { lnurlp: 'lnurl-missing-address', amount: 10_000_000, payment_hash: 'hash-missing-address' },
      LNBITS_IP
    );

    expect(res.status).toBe(200);
    expect(getGameInfoFromID(sessionID)?.players.get(PlayerRole.Player1)?.value).toBe(10_000);
    await vi.waitFor(() => expect(payInvoice).toHaveBeenCalledTimes(2));
    expect(getInvoiceFromCallback.mock.calls.map((call) => call[1])).toEqual([195, 195]);
    expect(trackEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'deposit.split',
        outcome: 'error',
        reason: 'missing_address',
        sessionID,
        amountSats: 95,
        meta: { role: 'designer' },
      })
    );
  });
});

function seedPayLink(
  sessionID: string,
  lnurlp: string,
  value: number,
  hostLNAddress?: string,
  name: string | null = 'Ada'
) {
  if (name !== null) {
    setGameInfoByID(sessionID, {
      mode: GameMode.P2P,
      players: new Map([[PlayerRole.Player1, { name, value, payments: [] }]]),
    });
  }
  setLNURLPToID(lnurlp, sessionID);
  appendLNURLPToID(sessionID, {
    id: lnurlp,
    lnurlp,
    description: PlayerRole.Player1,
    min: 1,
    mode: GameMode.P2P,
    hostLNAddress,
  });
}

async function payNamed(
  sessionID: string,
  lnurlp: string,
  comment: string | string[],
  name: string | null = 'Ada'
) {
  seedPayLink(sessionID, lnurlp, 0, undefined, name);
  const res = await post(
    '/api/LNURL/paid',
    { lnurlp, amount: 3000, comment, payment_hash: `hash-${lnurlp}` },
    LNBITS_IP
  );
  expect(res.status).toBe(200);
  return getGameInfoFromID(sessionID)?.players.get(PlayerRole.Player1)?.name;
}

function post(
  path: string,
  body: unknown,
  realIp: string
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-real-ip': realIp,
        },
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
