import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('dotenv', () => ({
  default: { config: () => ({}) },
}));

import createLNURLP from './createLNURLP';
import createLNURLW from './createLNURLW';

const fetchMock = vi.fn();

beforeEach(() => {
  process.env.LNBITS_URL = 'https://lnbits.example';
  process.env.LNBITS_KEY = 'invoice-key';
  process.env.LNBITS_DEPOSITHOOK = 'https://game.example/api/LNURL/paid';
  process.env.LNBITS_WITHDRAWHOOK = 'https://game.example/api/LNURL/withdrawn';
  process.env.LNBITS_WEBHOOK_SECRET = 's3cret';
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    status: 201,
    json: async () => ({ id: 'link-1', lnurl: 'lnurl1', description: 'Player1', min: 1 }),
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LNURL link creation', () => {
  it('stores the webhook secret as a header on a pay link', async () => {
    const link = await createLNURLP('Player1', 1000, 1000, 0);

    expect(link?.id).toBe('link-1');
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.webhook_url).toBe('https://game.example/api/LNURL/paid');
    expect(body.webhook_headers).toBe(JSON.stringify({ 'X-Webhook-Secret': 's3cret' }));
  });

  it('stores the webhook secret as a header on a withdraw link', async () => {
    const link = await createLNURLW(1000, 1);

    expect(link?.id).toBe('link-1');
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.webhook_url).toBe('https://game.example/api/LNURL/withdrawn');
    expect(body.webhook_headers).toBe(JSON.stringify({ 'X-Webhook-Secret': 's3cret' }));
  });

  it('does not create a link when the webhook secret is missing', async () => {
    delete process.env.LNBITS_WEBHOOK_SECRET;

    await expect(createLNURLP('Player1', 1000, 1000)).resolves.toBeNull();
    await expect(createLNURLW(1000, 1)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
