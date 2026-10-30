import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { secretEqual } from '../utils/secretEqual';

const COOKIE_NAME = 'marspay_dashboard';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function getSecret(): string {
  return process.env.ADMIN_PASSWORD ?? '';
}

function signPayload(expiry: number): string {
  const secret = getSecret();
  return crypto.createHmac('sha256', secret).update(String(expiry)).digest('hex');
}

function parseCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE_NAME) {
      return decodeURIComponent(rest.join('='));
    }
  }
  return undefined;
}

export function isDashboardAuthenticated(req: Request): boolean {
  const secret = getSecret();
  if (!secret) return false;
  const raw = parseCookie(req);
  if (!raw) return false;
  const [expiryStr, sig] = raw.split('.');
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || Date.now() > expiry) return false;
  const expected = signPayload(expiry);
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

export function requireDashboardAuth(req: Request, res: Response, next: NextFunction): void {
  if (isDashboardAuthenticated(req)) {
    next();
    return;
  }
  res.status(401).json({ error: 'Unauthorized' });
}

export function isDashboardDebugRawEnabled(): boolean {
  const flag = process.env.DASHBOARD_DEBUG_RAW?.trim().toLowerCase();
  return flag === '1' || flag === 'true';
}

export function handleDashboardLogin(req: Request, res: Response): void {
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const secret = getSecret();
  if (!secretEqual(password, secret)) {
    res.status(401).json({ error: 'Incorrect password' });
    return;
  }
  const expiry = Date.now() + SESSION_TTL_MS;
  const sig = signPayload(expiry);
  const value = `${expiry}.${sig}`;
  const secure = process.env.NODE_ENV === 'production';
  res.cookie(COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    maxAge: SESSION_TTL_MS,
    path: '/dashboard',
  });
  res.json({ ok: true, expiresAt: new Date(expiry).toISOString() });
}

export function handleDashboardLogout(_req: Request, res: Response): void {
  res.clearCookie(COOKIE_NAME, { path: '/dashboard' });
  res.json({ ok: true });
}
