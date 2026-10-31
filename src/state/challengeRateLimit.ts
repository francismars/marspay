import { consumeFixedWindow } from './fixedWindowRateLimit';

function envLimit(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function checkChallengeRunRateLimit(sessionID: string): boolean {
  const limit = envLimit('CHALLENGE_RUN_RATE_LIMIT_PER_MIN', 12);
  return consumeFixedWindow(`challenge:run:${sessionID}`, limit);
}

export function checkChallengeSubmitRateLimit(sessionID: string): boolean {
  const limit = envLimit('CHALLENGE_SUBMIT_RATE_LIMIT_PER_MIN', 30);
  return consumeFixedWindow(`challenge:submit:${sessionID}`, limit);
}
