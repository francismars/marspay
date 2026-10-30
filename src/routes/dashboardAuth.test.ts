import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../state/onlineRoomState', () => ({
  listOnlineRooms: () => [],
}));

import dashboard from './dashboard';

const ADMIN_PASSWORD = 'admin-secret';

const app = express();
app.use(express.json());
app.use('/dashboard', dashboard);

beforeEach(() => {
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  delete process.env.DASHBOARD_DEBUG_RAW;
});

describe('dashboard auth leftovers', () => {
  it('accepts the admin password and rejects a different length', async () => {
    const ok = await request('/dashboard/api/login', {
      method: 'POST',
      body: { password: ADMIN_PASSWORD },
    });
    const wrong = await request('/dashboard/api/login', {
      method: 'POST',
      body: { password: 'no' },
    });

    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ ok: true });
    expect(wrong.status).toBe(401);
    expect(wrong.json).toEqual({ error: 'Incorrect password' });
  });

  it('ignores a password in the dashboard URL', async () => {
    const res = await request(`/dashboard/?password=${encodeURIComponent(ADMIN_PASSWORD)}`);

    expect(res.status).not.toBe(401);
    expect(res.text.startsWith('{')).toBe(false);
    expect(res.text).not.toContain('connectedSessions');
  });

  it('hides the raw dump until DASHBOARD_DEBUG_RAW is enabled', async () => {
    const cookie = await login();
    const hidden = await request('/dashboard/api/debug/raw', { cookie });

    expect(hidden.status).toBe(404);

    process.env.DASHBOARD_DEBUG_RAW = 'true';
    const anonymous = await request('/dashboard/api/debug/raw');
    const opened = await request('/dashboard/api/debug/raw', { cookie });

    expect(anonymous.status).toBe(401);
    expect(opened.status).toBe(200);
    expect(opened.json).toHaveProperty('IDtoSocket');
  });
});

async function login(): Promise<string> {
  const res = await request('/dashboard/api/login', {
    method: 'POST',
    body: { password: ADMIN_PASSWORD },
  });
  expect(res.status).toBe(200);
  const cookie = res.setCookie.split(';')[0];
  expect(cookie.startsWith('marspay_dashboard=')).toBe(true);
  return cookie;
}

function request(
  path: string,
  options: { method?: string; body?: unknown; cookie?: string } = {}
): Promise<{ status: number; text: string; json: unknown; setCookie: string }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const headers: Record<string, string> = {};
      if (options.body !== undefined) headers['content-type'] = 'application/json';
      if (options.cookie) headers.cookie = options.cookie;
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: options.method ?? 'GET',
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      })
        .then(async (res) => {
          const text = await res.text();
          let json: unknown = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          server.close(() =>
            resolve({
              status: res.status,
              text,
              json,
              setCookie: res.headers.get('set-cookie') ?? '',
            })
          );
        })
        .catch((error: unknown) => {
          server.close(() => reject(error));
        });
    });
    server.on('error', reject);
  });
}
