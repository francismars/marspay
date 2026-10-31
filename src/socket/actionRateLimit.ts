import type { Socket } from 'socket.io';
import { consumeFixedWindow, resetFixedWindowForTests } from '../state/fixedWindowRateLimit';
import { resolveClientIp } from '../telemetry/trafficAnalytics';
import { dateNow } from '../utils/time';

export type SocketRateAction = 'room_create' | 'seat_invoice' | 'lnurl_create';

const DEFAULTS: Record<SocketRateAction, { env: string; fallback: number }> = {
  room_create: { env: 'ROOM_CREATE_RATE_LIMIT_PER_MIN', fallback: 3 },
  seat_invoice: { env: 'SEAT_INVOICE_RATE_LIMIT_PER_MIN', fallback: 6 },
  lnurl_create: { env: 'LNURL_CREATE_RATE_LIMIT_PER_MIN', fallback: 6 },
};

const lastLogAt = new Map<string, number>();

function envLimit(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Public client address for abuse control.
 * Loopback is ignored: behind nginx without X-Real-IP every socket looks like 127.0.0.1,
 * and sharing one bucket would throttle the whole server. Production sets X-Real-IP.
 */
export function clientIpForRateLimit(socket: Socket): string | undefined {
  const ip = resolveClientIp(socket);
  if (!ip || ip === 'unknown' || ip === '127.0.0.1' || ip === '::1') {
    return undefined;
  }
  return ip;
}

function logOnce(sessionID: string, action: SocketRateAction, ip: string | undefined) {
  const key = `${action}:${sessionID}`;
  const now = Date.now();
  const prev = lastLogAt.get(key);
  if (prev != null && now - prev < 60_000) {
    return;
  }
  lastLogAt.set(key, now);
  if (lastLogAt.size > 2000) {
    for (const [logKey, at] of lastLogAt) {
      if (now - at >= 60_000) {
        lastLogAt.delete(logKey);
      }
    }
  }
  console.log(
    `${dateNow()} [${sessionID}] rate_limited action=${action}${ip ? ` ip=${ip}` : ''}`
  );
}

/**
 * Per session, then per IP. A fresh session does not reset the IP window.
 * A session that is already limited does not keep spending the shared IP budget.
 */
export function allowSocketAction(socket: Socket, action: SocketRateAction): boolean {
  const sessionID = socket.data?.sessionID as string | undefined;
  if (!sessionID) {
    return false;
  }
  const { env, fallback } = DEFAULTS[action];
  const limit = envLimit(env, fallback);
  if (!consumeFixedWindow(`${action}:session:${sessionID}`, limit)) {
    logOnce(sessionID, action, clientIpForRateLimit(socket));
    return false;
  }
  const ip = clientIpForRateLimit(socket);
  if (!ip) {
    return true;
  }
  if (!consumeFixedWindow(`${action}:ip:${ip}`, limit)) {
    logOnce(sessionID, action, ip);
    return false;
  }
  return true;
}

export function resetSocketActionRateLimitsForTests() {
  lastLogAt.clear();
  resetFixedWindowForTests();
}
