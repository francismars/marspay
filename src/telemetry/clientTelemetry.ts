import type { Socket } from 'socket.io';
import { trackEvent } from './trackEvent';
import { resolveTrackPubkeyPrefix } from './resolveTrackPubkeyPrefix';

const ALLOWED_CLIENT_EVENTS = new Set([
  'client.page.view',
  'client.funnel.abandon',
  'client.ui.error',
  'client.session.context',
  'client.menu.selected',
  'client.practice.tab',
  'client.quickmatch.configured',
  'client.quickmatch.started',
  'client.quickmatch.completed',
  'client.challenge.catalog_viewed',
  'client.challenge.card_clicked',
  'client.challenge.completed',
  'client.p2p.configured',
  'client.p2p.game_started',
  'client.p2p.game_completed',
  'client.p2p.withdrawal_created',
  'client.p2p.double_or_nothing',
  'client.online.replay_started',
  'client.online.replay_ended',
  'client.online.replay_speed_changed',
  'client.online.spectate_started',
]);

const MAX_EVENTS_PER_MINUTE = 60;
const clientEventBuckets = new Map<string, { count: number; resetAt: number }>();

export type ClientTelemetryPayload = {
  event?: string;
  route?: string;
  detail?: string;
  mode?: string;
  challengeId?: string;
  roomCode?: string;
  outcome?: string;
  durationMs?: number;
  opponentType?: string;
  payMethod?: string;
  replaySpeed?: number;
  signerMode?: string;
  platform?: string;
  referrer?: string;
  buyinSats?: number;
  bracketSize?: number;
  powerups?: boolean;
  convergence?: boolean;
};

function rateLimitOk(sessionID: string): boolean {
  const now = Date.now();
  const bucket = clientEventBuckets.get(sessionID);
  if (!bucket || now >= bucket.resetAt) {
    clientEventBuckets.set(sessionID, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (bucket.count >= MAX_EVENTS_PER_MINUTE) {
    return false;
  }
  bucket.count += 1;
  return true;
}

function sanitizeStr(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLen) : undefined;
}

function sanitizeNum(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

function sanitizeBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function resolveSessionPubkeyPrefix(sessionID: string): string | undefined {
  return resolveTrackPubkeyPrefix(sessionID);
}

function buildMeta(payload: ClientTelemetryPayload): Record<string, string | number | boolean> {
  const meta: Record<string, string | number | boolean> = {};
  const route = sanitizeStr(payload.route, 120);
  const detail = sanitizeStr(payload.detail, 200);
  const mode = sanitizeStr(payload.mode, 40);
  const challengeId = sanitizeStr(payload.challengeId, 40);
  const roomCode = sanitizeStr(payload.roomCode, 20);
  const outcome = sanitizeStr(payload.outcome, 20);
  const opponentType = sanitizeStr(payload.opponentType, 40);
  const payMethod = sanitizeStr(payload.payMethod, 40);
  const signerMode = sanitizeStr(payload.signerMode, 20);
  const platform = sanitizeStr(payload.platform, 80);
  const referrer = sanitizeStr(payload.referrer, 120);
  const durationMs = sanitizeNum(payload.durationMs);
  const replaySpeed = sanitizeNum(payload.replaySpeed);
  const buyinSats = sanitizeNum(payload.buyinSats);
  const bracketSize = sanitizeNum(payload.bracketSize);
  const powerups = sanitizeBool(payload.powerups);
  const convergence = sanitizeBool(payload.convergence);

  if (route) meta.route = route;
  if (detail) meta.detail = detail;
  if (mode) meta.mode = mode;
  if (challengeId) meta.challengeId = challengeId;
  if (roomCode) meta.roomCode = roomCode;
  if (outcome) meta.clientOutcome = outcome;
  if (opponentType) meta.opponentType = opponentType;
  if (payMethod) meta.payMethod = payMethod;
  if (signerMode) meta.signerMode = signerMode;
  if (platform) meta.platform = platform;
  if (referrer) meta.referrer = referrer;
  if (durationMs !== undefined) meta.durationMs = durationMs;
  if (replaySpeed !== undefined) meta.replaySpeed = replaySpeed;
  if (buyinSats !== undefined) meta.buyinSats = buyinSats;
  if (bracketSize !== undefined) meta.bracketSize = bracketSize;
  if (powerups !== undefined) meta.powerups = powerups;
  if (convergence !== undefined) meta.convergence = convergence;

  return meta;
}

export function reportClientEventHandler(
  socket: Socket,
  payload?: ClientTelemetryPayload
) {
  const sessionID = socket.data.sessionID as string | undefined;
  if (!sessionID) {
    return;
  }
  const event = typeof payload?.event === 'string' ? payload.event.trim() : '';
  if (!ALLOWED_CLIENT_EVENTS.has(event)) {
    return;
  }
  if (!rateLimitOk(sessionID)) {
    return;
  }

  const meta = buildMeta(payload ?? {});
  const isUiError = event === 'client.ui.error';
  const detailReason = sanitizeStr(payload?.detail, 200);
  const sessionPubkey = resolveSessionPubkeyPrefix(sessionID);

  trackEvent({
    event,
    outcome: isUiError ? 'error' : 'ok',
    reason: isUiError ? detailReason : undefined,
    sessionID,
    pubkeyPrefix: sessionPubkey,
    challengeId: sanitizeStr(payload?.challengeId, 40),
    roomCode: sanitizeStr(payload?.roomCode, 20),
    source: 'client',
    meta: Object.keys(meta).length > 0 ? meta : undefined,
  });
}
