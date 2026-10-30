import { randomBytes } from 'node:crypto';
import { ONLINE_BUYIN_DEFAULT, ONLINE_BUYIN_MIN } from '../consts/values';
import { PlayerRole } from '../types/game';
import { dateNow } from '../utils/time';
import {
  JoinPinRecord,
  OnlineClaimClock,
  OnlineForfeitPause,
  OnlineRoom,
  OnlineMatchRoundSummary,
  OnlineRoomListItem,
  OnlineRoomMember,
  OnlineRoomNostrMeta,
  OnlineSeatState,
} from '../types/online';
import {
  createOnlineGameState,
  getOnlineHudState,
  startOnlineCountdown,
  stepOnlineGame,
} from '../game/onlineEngine';
import type { PlayerId } from '../game/onlineEngine';
import {
  applyInputIntent,
  applySessionSteering,
  clearSteeringOnRespawn,
  consumePendingTurn,
  mergeSessionInput,
  type OnlineRoomInputPayload,
  type OnlineSessionInput,
} from '../game/onlineInput';
import {
  appendOnlineMatchArchive,
  appendOnlineRoomArchive,
  archivedRowToOnlineRoomListItem,
  getOnlinePostGameFromArchive,
  listArchivedMatchRoundsForRoomSync,
  listArchivedOnlineRoomsSync,
  loadCompactReplayFromArchiveSync,
  readSessionMatchRoundFromArchiveSync,
} from './onlineRoomArchive';
import { packReplayForArchive, type OnlineReplayWirePayload } from './onlineReplayCompact';
import { trackOnlineOk } from '../telemetry/onlineTelemetry';
import { getAppNostrPubkeyForSession } from './nostrAppSessionState';
import { getSocketFromID } from './sessionState';
import { netPayoutSats } from '../utils/payout';

const PIN_TTL_MS = 2 * 60 * 1000;
/** Home / NIP-07 path: pubkey linked to session before zap (no PIN in comment). */
const NOSTR_LINK_TTL_MS = 15 * 60 * 1000;
/** Invoice issued via nostr_web prepare — survives lobby leave/rejoin until seated or TTL. */
const PENDING_SEAT_PAYMENT_TTL_MS = 2 * 60 * 60 * 1000;
const NOSTR_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const ROOM_IDLE_TTL_MS = 20 * 60 * 1000;
const ROOM_CLEANUP_MS = 15 * 1000;
/**
 * Cumulative time a paid seat may be disconnected or idle before forfeit.
 * Reconnects and steering pause the clock; they do not reset it.
 */
export const ONLINE_FORFEIT_DISCONNECT_MS = 5 * 60 * 1000;
/** After the match starts, or after a reconnect, before an idle segment opens. */
export const ONLINE_IDLE_GRACE_MS = 15 * 1000;
/** How long a connected winner may sit on the results screen before the prize is settled. */
export const ONLINE_CLAIM_PRESENCE_MS = 15 * 60 * 1000;
/** Fallback delete if immediate removal after payout failed (should be rare). */
const SETTLED_ROOM_DELETE_FALLBACK_MS = 30 * 1000;
const ONLINE_REPLAY_TICK_MS = 100;
const ONLINE_REPLAY_MAX_FRAMES = 3_600;

const roomById = new Map<string, OnlineRoom>();
/** Rooms whose sim has started, so idle is measured from lastSteerAt rather than lobby time. */
const simSteerAnchored = new WeakSet<OnlineRoom>();
const roomIdByCode = new Map<string, string>();
const roomIdBySession = new Map<string, string>();
const roomIdByKind1EventId = new Map<string, string>();
const pinByValue = new Map<string, JoinPinRecord>();

type PendingNostrChallenge = { roomId: string; challenge: string; expiresAt: number };
const pendingNostrChallengeBySession = new Map<string, PendingNostrChallenge>();

export type OnlineNostrLinkRecord = {
  roomId: string;
  sessionID: string;
  socketID: string;
  pubkey: string;
  expiresAt: number;
  /** `lightning` = ephemeral key from anonymous LN seat flow. */
  linkPayMethod?: 'lightning' | 'nostr_web';
};

const nostrLinkByRoomPubkey = new Map<string, OnlineNostrLinkRecord>();

type PendingSeatPaymentRecord = {
  roomId: string;
  sessionID: string;
  socketID: string;
  pubkey: string;
  kind1EventId: string;
  expiresAt: number;
};

const pendingSeatPaymentByRoomPubkey = new Map<string, PendingSeatPaymentRecord>();

function nostrLinkKey(roomId: string, pubkey: string) {
  return `${roomId}:${pubkey.toLowerCase()}`;
}

function logOnlineState(message: string) {
  console.log(`${dateNow()} [ONLINE_STATE] ${message}`);
}

type OnlineRoomChange = {
  roomId: string;
  prev: OnlineRoom['phase'] | null;
  next: OnlineRoom['phase'] | null;
  /** Clients still in the socket room should take the room-not-found path. */
  roomNotFound?: boolean;
};

let notifyOnlineRoomChange: (event: OnlineRoomChange) => void = () => {};

/** Socket layer registers this so phase changes broadcast without a state→socket import. */
export function setOnlineRoomChangeNotifier(fn: (event: OnlineRoomChange) => void) {
  notifyOnlineRoomChange = fn;
}

function noteActivity(room: OnlineRoom, now = Date.now()) {
  room.lastActivityAt = now;
  room.updatedAt = now;
}

function seatDisconnectTotalMs(seat: OnlineSeatState, now: number): number {
  const banked = seat.disconnectMs ?? 0;
  if (seat.disconnectedAt) {
    return banked + Math.max(0, now - seat.disconnectedAt);
  }
  if (seat.idleSince) {
    return banked + Math.max(0, now - seat.idleSince);
  }
  return banked;
}

function bankSeatDisconnect(seat: OnlineSeatState, now: number): OnlineSeatState {
  if (!seat.disconnectedAt && !seat.idleSince) {
    return seat;
  }
  return {
    ...seat,
    disconnectMs: seatDisconnectTotalMs(seat, now),
    disconnectedAt: undefined,
    idleSince: undefined,
  };
}

function markSeatDisconnected(seat: OnlineSeatState, now: number): OnlineSeatState {
  const bankedIdle = seat.idleSince && !seat.disconnectedAt ? bankSeatDisconnect(seat, now) : seat;
  if (bankedIdle.disconnectedAt) {
    return { ...bankedIdle, ready: false };
  }
  return { ...bankedIdle, disconnectedAt: now, ready: false, idleSince: undefined };
}

function bankWinnerClaimAway(
  room: OnlineRoom,
  role: PlayerRole.Player1 | PlayerRole.Player2,
  seat: OnlineSeatState,
  now: number
) {
  if (room.phase !== 'postgame' || room.postGame.winnerRole !== role || !seat.disconnectedAt) {
    return;
  }
  room.postGame.claimMs = (room.postGame.claimMs ?? 0) + Math.max(0, now - seat.disconnectedAt);
}

function reconnectPaidSeat(
  room: OnlineRoom,
  role: PlayerRole.Player1 | PlayerRole.Player2,
  seat: OnlineSeatState,
  socketID: string,
  now: number
): OnlineSeatState {
  bankWinnerClaimAway(room, role, seat, now);
  const next: OnlineSeatState = { ...bankSeatDisconnect(seat, now), socketID, ready: false };
  if (room.phase === 'playing') {
    next.lastSteerAt = now;
  }
  return next;
}

function randomToken(length: number): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let value = '';
  for (let i = 0; i < length; i += 1) {
    value += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return value;
}

function randomNumericPin(length: number): string {
  const digits = '0123456789';
  let value = '';
  for (let i = 0; i < length; i += 1) {
    value += digits[Math.floor(Math.random() * digits.length)];
  }
  return value;
}

function uniqueCode(): string {
  let code = randomToken(6);
  while (roomIdByCode.has(code)) {
    code = randomToken(6);
  }
  return code;
}

function uniqueRoomId(): string {
  return `${Date.now().toString(36)}-${randomToken(6)}`;
}

export function getRoomById(roomId: string) {
  return roomById.get(roomId);
}

/** Iterate live rooms in `playing` phase (for mempool block rewards, etc.). */
export function forEachPlayingOnlineRoom(fn: (room: OnlineRoom) => void): void {
  for (const room of roomById.values()) {
    if (room.phase === 'playing') {
      fn(room);
    }
  }
}

export function getRoomByCode(roomCode: string) {
  const roomId = roomIdByCode.get(roomCode.toUpperCase());
  if (!roomId) {
    return;
  }
  return roomById.get(roomId);
}

export function getRoomBySession(sessionID: string) {
  const roomId = roomIdBySession.get(sessionID);
  if (!roomId) {
    return;
  }
  return roomById.get(roomId);
}

export function getRoomByKind1EventId(kind1EventId: string) {
  const roomId = roomIdByKind1EventId.get(kind1EventId);
  if (!roomId) {
    return;
  }
  return roomById.get(roomId);
}

export function createOnlineRoom(params: {
  hostSessionID: string;
  hostSocketID: string;
  buyin?: number;
}): OnlineRoom {
  const roomId = uniqueRoomId();
  const roomCode = uniqueCode();
  const parsedBuyin = Math.floor(params.buyin ?? ONLINE_BUYIN_DEFAULT);
  const buyin =
    Number.isFinite(parsedBuyin) && parsedBuyin > 0
      ? Math.max(ONLINE_BUYIN_MIN, parsedBuyin)
      : ONLINE_BUYIN_DEFAULT;

  const p1: OnlineSeatState = { role: PlayerRole.Player1, status: 'open' };
  const p2: OnlineSeatState = { role: PlayerRole.Player2, status: 'open' };
  const now = Date.now();
  const room: OnlineRoom = {
    roomId,
    roomCode,
    hostSessionID: params.hostSessionID,
    hostSocketID: params.hostSocketID,
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    buyin,
    matchRound: 0,
    phase: 'lobby',
    members: new Map<string, OnlineRoomMember>(),
    spectators: new Set<string>(),
    seats: new Map([
      [PlayerRole.Player1, p1],
      [PlayerRole.Player2, p2],
    ]),
    inputBySession: new Map(),
    snapshot: {
      tick: 0,
      phase: 'lobby',
      state: createOnlineGameState({
        p1Name: 'Player 1',
        p2Name: 'Player 2',
        p1Points: buyin,
        p2Points: buyin,
      }),
      hud: {
        p1Points: buyin,
        p2Points: buyin,
        captureP1: '2%',
        captureP2: '2%',
        initialWidthP1: 50,
        initialWidthP2: 50,
        currentWidthP1: 50,
        currentWidthP2: 50,
      },
    },
    replay: {
      tickMs: ONLINE_REPLAY_TICK_MS,
      frames: [],
    },
    postGame: {
      p1Picture: undefined,
      p2Picture: undefined,
      winnerName: '',
      winnerPoints: 0,
      totalPrize: 0,
      doubleOrNothingVotes: new Set<string>(),
      rematchRequested: false,
    },
  };
  room.members.set(params.hostSessionID, {
    sessionID: params.hostSessionID,
    socketID: params.hostSocketID,
    joinedAt: now,
    lastSeen: now,
  });
  room.spectators.add(params.hostSessionID);

  roomById.set(roomId, room);
  roomIdByCode.set(roomCode, roomId);
  roomIdBySession.set(params.hostSessionID, roomId);
  logOnlineState(
    `created roomId=${roomId} code=${roomCode} host=${params.hostSessionID} buyin=${buyin}`
  );
  return room;
}

function winnerPointsFromSnapshot(room: OnlineRoom): number {
  const s = room.snapshot.state;
  const p1 = s.score?.[0] ?? 0;
  const p2 = s.score?.[1] ?? 0;
  const winningRole = s.winnerPlayer === 'P2' ? PlayerRole.Player2 : PlayerRole.Player1;
  return winningRole === PlayerRole.Player1 ? p1 : p2;
}

function roomToFinishedResult(room: OnlineRoom): NonNullable<OnlineRoomListItem['result']> {
  const p1Seat = room.seats.get(PlayerRole.Player1);
  const p2Seat = room.seats.get(PlayerRole.Player2);
  return {
    winnerName:
      room.postGame.outcome === 'abandoned'
        ? 'Abandoned'
        : room.postGame.winnerName ||
          room.snapshot.state.winnerName ||
          room.snapshot.state.p1Name ||
          'Winner',
    p1Name: p1Seat?.name ?? room.snapshot.state.p1Name ?? 'Player 1',
    p2Name: p2Seat?.name ?? room.snapshot.state.p2Name ?? 'Player 2',
    p1Score: room.snapshot.state.score?.[0] ?? 0,
    p2Score: room.snapshot.state.score?.[1] ?? 0,
    netPrize:
      room.postGame.outcome === 'abandoned' ? 0 : netPayoutSats(winnerPointsFromSnapshot(room)),
    p1Picture: p1Seat?.picture ?? room.postGame.p1Picture,
    p2Picture: p2Seat?.picture ?? room.postGame.p2Picture,
    winnerPicture: room.postGame.winnerPicture,
    winnerRole: room.postGame.outcome === 'abandoned' ? undefined : room.postGame.winnerRole,
    outcome: room.postGame.outcome,
    p1Paid: p1Seat?.paidAmount,
    p2Paid: p2Seat?.paidAmount,
    winnerSessionID: room.postGame.outcome === 'abandoned' ? undefined : room.postGame.winnerSessionID,
    winnerPubkey:
      room.postGame.outcome === 'abandoned'
        ? undefined
        : (room.postGame.winnerRole === PlayerRole.Player2 ? p2Seat : p1Seat)?.pubkey,
  };
}

/**
 * When multiple archive index rows share a `roomId` (per-round match + session), pick the row
 * that represents the final session (payout) or the latest match round ? not the first round.
 */
function pickBetterHistoryForRoom(prev: OnlineRoomListItem, next: OnlineRoomListItem): OnlineRoomListItem {
  const prevSession = prev.archiveKind === 'session' ? 1 : 0;
  const nextSession = next.archiveKind === 'session' ? 1 : 0;
  if (prevSession !== nextSession) {
    return prevSession > nextSession ? prev : next;
  }
  const pr = prev.matchRound ?? 0;
  const nr = next.matchRound ?? 0;
  if (pr !== nr) {
    return nr > pr ? next : prev;
  }
  const pt = prev.finishedAt ?? prev.createdAt;
  const nt = next.finishedAt ?? next.createdAt;
  return nt >= pt ? next : prev;
}

function pickPrimaryHistoryRow(rows: OnlineRoomListItem[]): OnlineRoomListItem {
  if (rows.length === 0) {
    throw new Error('pickPrimaryHistoryRow: empty');
  }
  return rows.reduce((acc, row) => pickBetterHistoryForRoom(acc, row));
}

/**
 * Combine `result` blobs from multiple index rows for the same room so avatar URLs are kept:
 * session vs per-match rows sometimes only one has full `seats` / picture merge in `result`.
 */
function mergeHistoryResultPortraits(
  primary: NonNullable<OnlineRoomListItem['result']>,
  extras: (NonNullable<OnlineRoomListItem['result']> | undefined)[]
): NonNullable<OnlineRoomListItem['result']> {
  let out = { ...primary };
  for (const o of extras) {
    if (!o) {
      continue;
    }
    out = {
      ...out,
      p1Picture: out.p1Picture || o.p1Picture,
      p2Picture: out.p2Picture || o.p2Picture,
      winnerPicture: out.winnerPicture || o.winnerPicture,
      p1Name: out.p1Name || o.p1Name,
      p2Name: out.p2Name || o.p2Name,
    };
  }
  return out;
}

/**
 * Single source of truth for History: archived index rows + finished rooms still in RAM
 * (archived wins when both exist for the same `roomId`).
 */
export function listOnlineHistoryMerged(): OnlineRoomListItem[] {
  const archived = listArchivedOnlineRoomsSync().map(archivedRowToOnlineRoomListItem);
  const byRoomId = new Map<string, OnlineRoomListItem[]>();
  for (const a of archived) {
    const row = { ...a, archived: true as const };
    const list = byRoomId.get(row.roomId) ?? [];
    list.push(row);
    byRoomId.set(row.roomId, list);
  }

  const mergedArchived: OnlineRoomListItem[] = [];
  for (const rows of byRoomId.values()) {
    const primary = pickPrimaryHistoryRow(rows);
    /** Last game in session: max of per-match index rows and session file `serializedRoom.matchRound`. */
    const roomId = rows[0].roomId;
    const fromIndex = Math.max(0, ...rows.map((r) => r.matchRound ?? 0));
    const fromSessionFile = readSessionMatchRoundFromArchiveSync(roomId) ?? 0;
    const replayRound = Math.max(fromIndex, fromSessionFile);
    const allResults = rows
      .map((r) => r.result)
      .filter((r): r is NonNullable<OnlineRoomListItem['result']> => Boolean(r));
    const baseResult = primary.result ?? allResults[0];
    const mergedResult = baseResult
      ? mergeHistoryResultPortraits(
          baseResult,
          allResults.filter((r) => r !== baseResult)
        )
      : primary.result;
    mergedArchived.push({
      ...primary,
      result: mergedResult ?? primary.result,
      ...(replayRound > 0 ? { matchRound: replayRound } : {}),
    });
  }

  const byId = new Map<string, OnlineRoomListItem>();
  for (const m of mergedArchived) {
    byId.set(m.roomId, m);
  }

  const liveFinished = listOnlineRooms().filter((r) => r.phase === 'finished');
  for (const f of liveFinished) {
    const prev = byId.get(f.roomId);
    if (!prev) {
      byId.set(f.roomId, { ...f, archived: false });
      continue;
    }
    const mergedResult =
      prev.result && f.result
        ? mergeHistoryResultPortraits(f.result, [prev.result])
        : f.result ?? prev.result;
    const mergedRound = Math.max(prev.matchRound ?? 0, f.matchRound ?? 0);
    byId.set(f.roomId, {
      ...prev,
      ...f,
      archived: false,
      result: mergedResult,
      ...(mergedRound > 0 ? { matchRound: mergedRound } : {}),
    });
  }

  return [...byId.values()].sort(
    (a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt)
  );
}

export function listOnlineRooms(): OnlineRoomListItem[] {
  return [...roomById.values()].map((room) => ({
    roomId: room.roomId,
    roomCode: room.roomCode,
    buyin: room.buyin,
    /** Last completed lobby?playing cycle (for replay URL / history). */
    matchRound: room.matchRound,
    createdAt: room.createdAt,
    finishedAt:
      room.phase === 'finished'
        ? room.postGame.settledAt ?? room.updatedAt
        : undefined,
    phase: room.phase,
    rematchRequested: room.postGame.rematchRequested || undefined,
    playersPaid: [...room.seats.values()].filter((seat) => seat.status === 'paid').length,
    seatsTotal: 2,
    spectators: room.spectators.size,
    result:
      room.phase === 'postgame' || room.phase === 'finished'
        ? roomToFinishedResult(room)
        : undefined,
    replay:
      room.phase === 'postgame' || room.phase === 'finished'
        ? {
            available: room.replay.frames.length > 0,
            frameCount: room.replay.frames.length,
            tickMs: room.replay.tickMs,
            durationMs: room.replay.frames.length * room.replay.tickMs,
          }
        : undefined,
  }));
}

/** Re-bind a paid seat when the client reconnects with a new sessionID but the same Nostr pubkey. */
function tryReclaimPaidSeatOnJoin(
  room: OnlineRoom,
  roomId: string,
  sessionID: string,
  socketID: string
): boolean {
  const claimPubkeys = new Set<string>();
  const appPk = getAppNostrPubkeyForSession(sessionID);
  if (appPk) {
    claimPubkeys.add(appPk.toLowerCase());
  }
  if (claimPubkeys.size === 0) {
    return false;
  }

  for (const [role, seat] of room.seats.entries()) {
    if (seat.status !== 'paid' || seat.sessionID === sessionID) {
      continue;
    }
    const seatPk = seat.pubkey?.toLowerCase();
    if (!seatPk || !claimPubkeys.has(seatPk)) {
      continue;
    }
    const oldSessionID = seat.sessionID;
    if (oldSessionID && room.members.has(oldSessionID)) {
      continue;
    }
    if (oldSessionID) {
      roomIdBySession.delete(oldSessionID);
      room.spectators.delete(oldSessionID);
    }
    room.seats.set(role, reconnectPaidSeat(room, role, { ...seat, sessionID }, socketID, Date.now()));
    room.spectators.delete(sessionID);
    roomIdBySession.set(sessionID, roomId);
    logOnlineState(
      `reclaimed paid seat roomId=${roomId} role=${role} session=${sessionID} pubkey=${seatPk.slice(0, 8)}?`
    );
    return true;
  }
  return false;
}

export function joinRoom(
  roomId: string,
  sessionID: string,
  socketID: string
): { room: OnlineRoom; matchStarted: boolean } | undefined {
  const room = roomById.get(roomId);
  if (!room) {
    return;
  }
  const now = Date.now();
  room.members.set(sessionID, {
    sessionID,
    socketID,
    joinedAt: now,
    lastSeen: now,
  });
  room.spectators.add(sessionID);
  let seated = false;
  for (const [role, seat] of room.seats.entries()) {
    if (seat.sessionID === sessionID) {
      room.seats.set(role, reconnectPaidSeat(room, role, seat, socketID, now));
      room.spectators.delete(sessionID);
      seated = true;
    }
  }
  if (!seated) {
    tryReclaimPaidSeatOnJoin(room, roomId, sessionID, socketID);
  }
  noteActivity(room, now);
  roomIdBySession.set(sessionID, roomId);
  refreshNostrLinkSocket(roomId, sessionID, socketID);
  refreshPendingSeatPaymentSocket(roomId, sessionID, socketID);
  logOnlineState(`join roomId=${roomId} session=${sessionID} socket=${socketID}`);
  if (room.phase === 'postgame' || room.phase === 'finished') {
    ensurePostGameState(room);
  }
  const matchStarted = maybeStartPaidMatch(room);
  return { room, matchStarted };
}

export function touchMember(roomId: string, sessionID: string) {
  const room = roomById.get(roomId);
  if (!room) {
    return;
  }
  const member = room.members.get(sessionID);
  if (member) {
    member.lastSeen = Date.now();
  }
}

export function leaveRoom(sessionID: string, options?: { releaseSeat?: boolean }) {
  const releaseSeat = options?.releaseSeat ?? false;
  const roomId = roomIdBySession.get(sessionID);
  if (!roomId) {
    return;
  }
  const room = roomById.get(roomId);
  if (!room) {
    roomIdBySession.delete(sessionID);
    return;
  }
  let hasPaidSeat = false;
  for (const seat of room.seats.values()) {
    if (seat.sessionID === sessionID && seat.status === 'paid') {
      hasPaidSeat = true;
      break;
    }
  }
  // Keep mapping for paid seats during transient disconnects so reconnect can restore socket cleanly.
  if (releaseSeat || !hasPaidSeat) {
    roomIdBySession.delete(sessionID);
  }
  room.members.delete(sessionID);
  room.spectators.delete(sessionID);
  room.inputBySession.delete(sessionID);
  for (const [role, seat] of room.seats.entries()) {
    if (seat.sessionID === sessionID) {
      if (seat.status === 'paid' && room.phase !== 'cancelled') {
        // Paid seats stay reserved. The forfeit clock resumes; it does not reset.
        const wasGone = seat.disconnectedAt != null;
        room.seats.set(role, markSeatDisconnected(seat, Date.now()));
        if (!wasGone) {
          notifyOnlineRoomChange({ roomId, prev: room.phase, next: room.phase });
        }
      } else if (releaseSeat || seat.status !== 'paid') {
        room.seats.set(role, { role, status: 'open' });
      } else {
        room.seats.set(role, markSeatDisconnected(seat, Date.now()));
      }
    }
  }
  noteActivity(room);
  clearNostrSessionStateOnLeave(sessionID, roomId, { releaseSeat, hasPaidSeat });
  logOnlineState(
    `leave roomId=${roomId} session=${sessionID} releaseSeat=${releaseSeat} hadPaidSeat=${hasPaidSeat}`
  );
  if (sessionID === room.hostSessionID) {
    logOnlineState(`host disconnected roomId=${room.roomId}; preserving room for reconnect`);
  }
}

export function deleteRoom(roomId: string, options?: { roomNotFound?: boolean }) {
  const room = roomById.get(roomId);
  if (!room) {
    return;
  }
  if (room.phase === 'finished') {
    void appendOnlineRoomArchive({
      version: 1,
      kind: 'session',
      roomId: room.roomId,
      archiveId: `${room.roomId}-session`,
      finishedAt: room.postGame.settledAt ?? Date.now(),
      serializedRoom: serializeRoom(room) as Record<string, unknown>,
      replay: packReplayForArchive(room.replay.frames, room.replay.tickMs, room.replay.blockEvents),
    });
  }
  for (const sessionID of room.members.keys()) {
    roomIdBySession.delete(sessionID);
  }
  for (const seat of room.seats.values()) {
    if (seat.sessionID) {
      roomIdBySession.delete(seat.sessionID);
    }
  }
  roomById.delete(roomId);
  roomIdByCode.delete(room.roomCode);
  for (const [pin, record] of pinByValue.entries()) {
    if (record.roomId === roomId) {
      pinByValue.delete(pin);
    }
  }
  for (const key of [...nostrLinkByRoomPubkey.keys()]) {
    const rec = nostrLinkByRoomPubkey.get(key);
    if (rec?.roomId === roomId) {
      nostrLinkByRoomPubkey.delete(key);
    }
  }
  for (const key of [...pendingSeatPaymentByRoomPubkey.keys()]) {
    const rec = pendingSeatPaymentByRoomPubkey.get(key);
    if (rec?.roomId === roomId) {
      pendingSeatPaymentByRoomPubkey.delete(key);
    }
  }
  for (const sid of [...pendingNostrChallengeBySession.keys()]) {
    const p = pendingNostrChallengeBySession.get(sid);
    if (p?.roomId === roomId) {
      pendingNostrChallengeBySession.delete(sid);
    }
  }
  for (const [eventId, mappedRoomId] of roomIdByKind1EventId.entries()) {
    if (mappedRoomId === roomId) {
      roomIdByKind1EventId.delete(eventId);
    }
  }
  logOnlineState(`deleted roomId=${roomId} code=${room.roomCode}`);
  notifyOnlineRoomChange({
    roomId,
    prev: room.phase,
    next: null,
    roomNotFound: options?.roomNotFound,
  });
}

export function deleteRoomBySession(sessionID: string) {
  const roomId = roomIdBySession.get(sessionID);
  if (!roomId) {
    return;
  }
  deleteRoom(roomId);
}

export function setRoomNostrMeta(roomId: string, nostrMeta: OnlineRoomNostrMeta, kind1EventId: string) {
  const room = roomById.get(roomId);
  if (!room) {
    return;
  }
  if (room.kind1EventId && room.kind1EventId !== kind1EventId) {
    roomIdByKind1EventId.delete(room.kind1EventId);
  }
  room.nostrMeta = nostrMeta;
  room.kind1EventId = kind1EventId;
  room.nostrThreadTipEventId = kind1EventId;
  roomIdByKind1EventId.set(kind1EventId, roomId);
  noteActivity(room);
  logOnlineState(`set nostr meta roomId=${roomId} note=${nostrMeta.note1}`);
}

/** After a Kind1 is published in the room thread, parent the next reply on this event. */
export function advanceNostrThreadTip(roomId: string, eventId: string) {
  const room = roomById.get(roomId);
  if (!room || !eventId) {
    return;
  }
  room.nostrThreadTipEventId = eventId;
  noteActivity(room);
  logOnlineState(`nostr thread tip roomId=${roomId} event=${eventId.slice(0, 12)}?`);
}

export function issueJoinPin(roomId: string, sessionID: string, socketID: string) {
  const room = roomById.get(roomId);
  if (!room) {
    return;
  }
  if (room.phase === 'finished') {
    logOnlineState(`pin denied roomId=${roomId} session=${sessionID} reason=room_finished`);
    return;
  }
  if (room.phase === 'postgame' && !room.postGame.rematchRequested) {
    logOnlineState(`pin denied roomId=${roomId} session=${sessionID} reason=round_postgame`);
    return;
  }
  if (room.postGame.rematchRequested) {
    const isSeatedPlayer = [...room.seats.values()].some(
      (seat) => seat.status === 'paid' && seat.sessionID === sessionID
    );
    if (!isSeatedPlayer) {
      logOnlineState(`pin denied roomId=${roomId} session=${sessionID} reason=rematch_locked`);
      return;
    }
  }
  const now = Date.now();
  for (const record of pinByValue.values()) {
    if (record.roomId !== roomId || record.sessionID !== sessionID) {
      continue;
    }
    if (record.used) {
      continue;
    }
    const stillValid = record.expiresAt > now || shouldPinStayActive(record);
    if (!stillValid) {
      continue;
    }
    record.socketID = socketID;
    if (shouldPinStayActive(record)) {
      record.expiresAt = now + PIN_TTL_MS;
    }
    pinByValue.set(pinRecordKey(roomId, record.pin), record);
    logOnlineState(
      `reused pin roomId=${roomId} session=${sessionID} socket=${socketID} expiresAt=${record.expiresAt}`
    );
    return record;
  }
  let pin = randomNumericPin(4);
  while (pinByValue.has(pinRecordKey(roomId, pin))) {
    pin = randomNumericPin(4);
  }
  const record: JoinPinRecord = {
    pin,
    roomId,
    sessionID,
    socketID,
    expiresAt: now + PIN_TTL_MS,
    used: false,
  };
  pinByValue.set(pinRecordKey(roomId, pin), record);
  logOnlineState(
    `issued pin roomId=${roomId} session=${sessionID} socket=${socketID} expiresAt=${record.expiresAt}`
  );
  return record;
}

function canIssueNostrLinkChallenge(roomId: string, sessionID: string): boolean {
  const room = roomById.get(roomId);
  if (!room) {
    return false;
  }
  if (room.phase === 'finished') {
    return false;
  }
  if (room.phase === 'postgame' && !room.postGame.rematchRequested) {
    return false;
  }
  if (room.postGame.rematchRequested) {
    const isSeatedPlayer = [...room.seats.values()].some(
      (seat) => seat.status === 'paid' && seat.sessionID === sessionID
    );
    if (!isSeatedPlayer) {
      return false;
    }
  }
  return true;
}

export function issueNostrLinkChallenge(
  sessionID: string,
  roomId: string
): { challenge: string; expiresAt: number } | undefined {
  if (!canIssueNostrLinkChallenge(roomId, sessionID)) {
    logOnlineState(`nostr challenge denied roomId=${roomId} session=${sessionID}`);
    return undefined;
  }
  const challenge = randomBytes(32).toString('hex');
  const expiresAt = Date.now() + NOSTR_CHALLENGE_TTL_MS;
  pendingNostrChallengeBySession.set(sessionID, { roomId, challenge, expiresAt });
  logOnlineState(`issued nostr challenge roomId=${roomId} session=${sessionID} expiresAt=${expiresAt}`);
  return { challenge, expiresAt };
}

export function peekPendingNostrChallenge(
  sessionID: string,
  roomId: string
): { challenge: string } | undefined {
  const p = pendingNostrChallengeBySession.get(sessionID);
  if (!p || p.roomId !== roomId || p.expiresAt <= Date.now()) {
    return undefined;
  }
  return { challenge: p.challenge };
}

export function clearPendingNostrChallenge(sessionID: string) {
  pendingNostrChallengeBySession.delete(sessionID);
}

export function registerNostrLink(
  roomId: string,
  sessionID: string,
  socketID: string,
  pubkeyHex: string,
  opts?: { linkPayMethod?: 'lightning' | 'nostr_web' }
): { ok: true; expiresAt: number } | { ok: false; reason: string } {
  const room = roomById.get(roomId);
  if (!room) {
    return { ok: false, reason: 'room_not_found' };
  }
  if (!canIssueNostrLinkChallenge(roomId, sessionID)) {
    return { ok: false, reason: 'nostr_link_not_allowed' };
  }
  const pk = pubkeyHex.toLowerCase();
  const key = nostrLinkKey(roomId, pk);
  const existing = nostrLinkByRoomPubkey.get(key);
  if (existing && existing.sessionID !== sessionID && existing.expiresAt > Date.now()) {
    return { ok: false, reason: 'pubkey_already_linked' };
  }
  for (const seat of room.seats.values()) {
    if (
      seat.pubkey &&
      seat.pubkey.toLowerCase() === pk &&
      seat.status === 'paid' &&
      seat.sessionID !== sessionID
    ) {
      return { ok: false, reason: 'pubkey_already_seated' };
    }
  }
  const expiresAt = Date.now() + NOSTR_LINK_TTL_MS;
  nostrLinkByRoomPubkey.set(key, {
    roomId,
    sessionID,
    socketID,
    pubkey: pk,
    expiresAt,
    linkPayMethod: opts?.linkPayMethod ?? 'nostr_web',
  });
  logOnlineState(`registered nostr link roomId=${roomId} session=${sessionID} pubkey=${pk.slice(0, 8)}?`);
  return { ok: true, expiresAt };
}

export function getLightningNostrLinkPubkey(roomId: string, sessionID: string): string | undefined {
  const now = Date.now();
  for (const rec of nostrLinkByRoomPubkey.values()) {
    if (
      rec.roomId === roomId &&
      rec.sessionID === sessionID &&
      rec.linkPayMethod === 'lightning' &&
      rec.expiresAt > now
    ) {
      return rec.pubkey;
    }
  }
  return undefined;
}

/** Drop throwaway Lightning keys for this session. A newer invoice replaces the previous one. */
export function removeLightningNostrLinksForSession(roomId: string, sessionID: string): void {
  for (const [key, rec] of [...nostrLinkByRoomPubkey.entries()]) {
    if (rec.roomId === roomId && rec.sessionID === sessionID && rec.linkPayMethod === 'lightning') {
      nostrLinkByRoomPubkey.delete(key);
      logOnlineState(`removed lightning nostr link roomId=${roomId} session=${sessionID}`);
    }
  }
}

/** Keep a pre-registered pubkey until a host invoice can still settle, including receipt delay. */
export function extendNostrLinkExpiry(roomId: string, pubkeyHex: string, expiresAt: number): number | undefined {
  const rec = nostrLinkByRoomPubkey.get(nostrLinkKey(roomId, pubkeyHex));
  if (!rec || rec.roomId !== roomId) {
    return undefined;
  }
  if (expiresAt > rec.expiresAt) {
    rec.expiresAt = expiresAt;
  }
  return rec.expiresAt;
}

/** Remove a pre-registered pubkey binding (Nostr link or Lightning zap ephemeral key). */
export function removeNostrLinkRegistrationForPubkey(
  roomId: string,
  pubkeyHex: string,
  sessionID: string
): void {
  const pk = pubkeyHex.toLowerCase();
  const key = nostrLinkKey(roomId, pk);
  const rec = nostrLinkByRoomPubkey.get(key);
  if (rec && rec.sessionID === sessionID) {
    nostrLinkByRoomPubkey.delete(key);
    logOnlineState(`removed nostr link registration roomId=${roomId} session=${sessionID}`);
  }
}

export function consumeNostrLinkForZap(
  roomId: string,
  pubkeyHex: string
): { ok: true; record: { sessionID: string; socketID: string; linkPayMethod: 'lightning' | 'nostr_web' } } | { ok: false; reason: string } {
  const pk = pubkeyHex.toLowerCase();
  const key = nostrLinkKey(roomId, pk);
  const rec = nostrLinkByRoomPubkey.get(key);
  if (!rec || rec.roomId !== roomId) {
    return { ok: false, reason: 'nostr_link_not_found' };
  }
  if (rec.expiresAt <= Date.now()) {
    nostrLinkByRoomPubkey.delete(key);
    return { ok: false, reason: 'nostr_link_expired' };
  }
  const sessionID = rec.sessionID;
  const sid = rec.socketID;
  nostrLinkByRoomPubkey.delete(key);
  logOnlineState(`consumed nostr link roomId=${roomId} session=${sessionID}`);
  return {
    ok: true,
    record: {
      sessionID,
      socketID: sid,
      linkPayMethod: rec.linkPayMethod ?? 'nostr_web',
    },
  };
}

export function refreshNostrLinkSocket(roomId: string, sessionID: string, socketID: string) {
  for (const [key, rec] of nostrLinkByRoomPubkey.entries()) {
    if (rec.roomId === roomId && rec.sessionID === sessionID) {
      rec.socketID = socketID;
      nostrLinkByRoomPubkey.set(key, rec);
    }
  }
}

/** Active Nostr link pubkey for this session in this room (not consumed). */
export function getActiveNostrLinkPubkey(roomId: string, sessionID: string): string | undefined {
  const now = Date.now();
  for (const rec of nostrLinkByRoomPubkey.values()) {
    if (rec.roomId === roomId && rec.sessionID === sessionID && rec.expiresAt > now) {
      return rec.pubkey;
    }
  }
  return undefined;
}

export function clearNostrSessionStateOnLeave(
  sessionID: string,
  roomId: string,
  opts: { releaseSeat: boolean; hasPaidSeat: boolean }
) {
  pendingNostrChallengeBySession.delete(sessionID);
  const keepLinkForPendingPay = hasPendingSeatPaymentForSession(sessionID, roomId);
  if ((!opts.hasPaidSeat || opts.releaseSeat) && !keepLinkForPendingPay) {
    for (const key of [...nostrLinkByRoomPubkey.keys()]) {
      const rec = nostrLinkByRoomPubkey.get(key);
      if (rec && rec.roomId === roomId && rec.sessionID === sessionID) {
        nostrLinkByRoomPubkey.delete(key);
      }
    }
  }
}

export function registerPendingSeatPayment(
  roomId: string,
  sessionID: string,
  socketID: string,
  pubkeyHex: string,
  kind1EventId: string
): { ok: true; expiresAt: number } | { ok: false; reason: string } {
  const room = roomById.get(roomId);
  if (!room) {
    return { ok: false, reason: 'room_not_found' };
  }
  const pk = pubkeyHex.toLowerCase();
  const expiresAt = Date.now() + PENDING_SEAT_PAYMENT_TTL_MS;
  pendingSeatPaymentByRoomPubkey.set(nostrLinkKey(roomId, pk), {
    roomId,
    sessionID,
    socketID,
    pubkey: pk,
    kind1EventId,
    expiresAt,
  });
  logOnlineState(
    `registered pending seat payment roomId=${roomId} session=${sessionID} pubkey=${pk.slice(0, 8)}? kind1=${kind1EventId.slice(0, 8)}?`
  );
  return { ok: true, expiresAt };
}

export function consumePendingSeatPayment(
  roomId: string,
  pubkeyHex: string,
  kind1EventId: string
):
  | { ok: true; record: { sessionID: string; socketID: string } }
  | { ok: false; reason: string } {
  const pk = pubkeyHex.toLowerCase();
  const key = nostrLinkKey(roomId, pk);
  const rec = pendingSeatPaymentByRoomPubkey.get(key);
  if (!rec || rec.roomId !== roomId) {
    return { ok: false, reason: 'nostr_link_not_found' };
  }
  if (rec.kind1EventId !== kind1EventId) {
    return { ok: false, reason: 'nostr_link_not_found' };
  }
  if (rec.expiresAt <= Date.now()) {
    pendingSeatPaymentByRoomPubkey.delete(key);
    return { ok: false, reason: 'nostr_link_expired' };
  }
  const sessionID = rec.sessionID;
  const sid = rec.socketID;
  pendingSeatPaymentByRoomPubkey.delete(key);
  logOnlineState(`consumed pending seat payment roomId=${roomId} session=${sessionID}`);
  return { ok: true, record: { sessionID, socketID: sid } };
}

export function refreshPendingSeatPaymentSocket(
  roomId: string,
  sessionID: string,
  socketID: string
) {
  for (const [key, rec] of pendingSeatPaymentByRoomPubkey.entries()) {
    if (rec.roomId === roomId && rec.sessionID === sessionID) {
      rec.socketID = socketID;
      pendingSeatPaymentByRoomPubkey.set(key, rec);
    }
  }
}

export function hasPendingSeatPaymentForSession(sessionID: string, roomId: string): boolean {
  const now = Date.now();
  for (const rec of pendingSeatPaymentByRoomPubkey.values()) {
    if (rec.roomId === roomId && rec.sessionID === sessionID && rec.expiresAt > now) {
      return true;
    }
  }
  return false;
}

export function consumePin(pinRaw: string, roomId: string) {
  const pin = pinRaw.trim();
  const key = pinRecordKey(roomId, pin);
  const record = pinByValue.get(key);
  if (!record) {
    logOnlineState(`consume pin failed roomId=${roomId} pin=${pin} reason=not_found`);
    return { ok: false as const, reason: 'not_found' };
  }
  if (record.roomId !== roomId) {
    logOnlineState(`consume pin failed roomId=${roomId} pin=${pin} reason=room_mismatch`);
    return { ok: false as const, reason: 'room_mismatch' };
  }
  if (record.used) {
    logOnlineState(`consume pin failed roomId=${roomId} pin=${pin} reason=already_used`);
    return { ok: false as const, reason: 'already_used' };
  }
  if (record.expiresAt <= Date.now() && !shouldPinStayActive(record)) {
    pinByValue.delete(key);
    logOnlineState(`consume pin failed roomId=${roomId} pin=${pin} reason=expired`);
    return { ok: false as const, reason: 'expired' };
  }
  // Keep the pin alive while user is still in room and seats are open.
  if (shouldPinStayActive(record)) {
    record.expiresAt = Date.now() + PIN_TTL_MS;
  }
  record.used = true;
  record.usedAt = Date.now();
  pinByValue.set(key, record);
  logOnlineState(`consumed pin roomId=${roomId} pin=${pin} session=${record.sessionID}`);
  return { ok: true as const, record };
}

/** First non-empty trimmed string, or undefined. */
export function firstNonEmptyLabel(...candidates: (string | null | undefined)[]): string | undefined {
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

/** Anonymous lobby label, e.g. `Anon9180bc` (first 6 hex chars of pubkey or zap id). */
export function formatAnonSeatLabel(hexSource: string): string {
  const hex = hexSource.replace(/[^a-f0-9]/gi, '').slice(0, 6).toLowerCase();
  return hex ? `Anon${hex}` : 'Anonymous';
}

/** Seat label for online lobby ? never returns blank (anonymous zaps often have empty comment). */
export function resolveOnlineSeatDisplayName(params: {
  name?: string | null;
  pubkey?: string;
  zapEventIdSuffix?: string;
}): string {
  const trimmed = firstNonEmptyLabel(params.name);
  if (trimmed) {
    return trimmed;
  }
  if (params.pubkey) {
    return formatAnonSeatLabel(params.pubkey);
  }
  if (params.zapEventIdSuffix) {
    return formatAnonSeatLabel(params.zapEventIdSuffix);
  }
  return 'Anonymous';
}

export function seatPaidPlayer(params: {
  roomId: string;
  sessionID: string;
  socketID: string;
  amount: number;
  name: string;
  picture?: string;
  pubkey?: string;
  lnAddress?: string;
  payMethod?: 'lightning' | 'nostr_web' | 'nostr_app';
}) {
  const displayName = resolveOnlineSeatDisplayName({
    name: params.name,
    pubkey: params.pubkey,
  });
  const room = roomById.get(params.roomId);
  if (!room) {
    return { ok: false as const, reason: 'room_not_found' };
  }
  for (const seat of room.seats.values()) {
    if (seat.sessionID === params.sessionID && seat.status === 'paid') {
      logOnlineState(
        `seat already paid roomId=${params.roomId} session=${params.sessionID} role=${seat.role}`
      );
      return { ok: true as const, role: seat.role, room };
    }
  }
  if (room.postGame.rematchRequested) {
    logOnlineState(
      `seat assignment blocked roomId=${params.roomId} session=${params.sessionID} reason=rematch_locked`
    );
    return { ok: false as const, reason: 'rematch_locked' };
  }
  const seatRoles: Array<PlayerRole.Player1 | PlayerRole.Player2> = [
    PlayerRole.Player1,
    PlayerRole.Player2,
  ];
  const openSeat = seatRoles.find((role) => {
    const seat = room.seats.get(role)!;
    return seat.status === 'open';
  });
  if (!openSeat) {
    logOnlineState(`seat assignment failed roomId=${params.roomId} session=${params.sessionID} reason=seats_full`);
    return { ok: false as const, reason: 'seats_full' };
  }
  const now = Date.now();
  room.seats.set(openSeat, {
    role: openSeat,
    sessionID: params.sessionID,
    socketID: params.socketID,
    status: 'paid',
    paidAmount: params.amount,
    paidAt: now,
    ready: false,
    startConfirmed: false,
    disconnectedAt: undefined,
    name: displayName,
    picture: params.picture,
    pubkey: params.pubkey,
    lnAddress: params.lnAddress,
    payMethod: params.payMethod,
  });
  room.spectators.delete(params.sessionID);
  roomIdBySession.set(params.sessionID, params.roomId);
  const member = room.members.get(params.sessionID);
  if (member) {
    member.socketID = params.socketID;
    member.lastSeen = now;
  } else {
    room.members.set(params.sessionID, {
      sessionID: params.sessionID,
      socketID: params.socketID,
      joinedAt: now,
      lastSeen: now,
    });
  }
  syncAuthoritativePlayers(room.roomId);
  noteActivity(room, now);
  logOnlineState(
    `seat assigned roomId=${params.roomId} session=${params.sessionID} role=${openSeat} amount=${params.amount}`
  );
  const matchStarted = maybeStartPaidMatch(room);
  return { ok: true as const, role: openSeat, room, matchStarted };
}

export function setRoomPhase(roomId: string, phase: OnlineRoom['phase']) {
  const room = roomById.get(roomId);
  if (!room) {
    return;
  }
  if (room.phase === phase) {
    return;
  }
  const prevPhase = room.phase;
  room.phase = phase;
  room.snapshot.phase = phase;
  if (phase === 'playing' && prevPhase === 'lobby') {
    room.matchRound += 1;
  }
  if (phase === 'playing') {
    room.postGame.doubleOrNothingVotes.clear();
    room.postGame.settledAt = undefined;
    room.postGame.outcome = undefined;
    for (const [role, seat] of room.seats.entries()) {
      if (seat.status === 'paid') {
        room.seats.set(role, {
          ...seat,
          ready: false,
          startConfirmed: false,
          idleSince: undefined,
          lastSteerAt: undefined,
        });
      }
    }
    simSteerAnchored.delete(room);
    resetReplay(room);
  }
  if (phase === 'postgame') {
    if (!room.postGame.claimStartedAt) {
      room.postGame.claimStartedAt = Date.now();
    }
    ensurePostGameState(room);
    room.replay.recordedAt = Date.now();
    void appendOnlineMatchArchive({
      version: 1,
      kind: 'match',
      roomId: room.roomId,
      matchRound: room.matchRound,
      archiveId: `${room.roomId}-r${room.matchRound}`,
      finishedAt: Date.now(),
      serializedRoom: serializeRoom(room) as Record<string, unknown>,
      replay: packReplayForArchive([...room.replay.frames], room.replay.tickMs, room.replay.blockEvents),
    });
    trackOnlineOk('online.game.finished', {
      roomId: room.roomId,
      roomCode: room.roomCode,
      buyin: room.buyin,
      meta: { matchRound: room.matchRound },
    });
  }
  noteActivity(room);
  logOnlineState(`phase changed roomId=${roomId} ${prevPhase} -> ${phase}`);
  notifyOnlineRoomChange({ roomId, prev: prevPhase, next: phase });
}

export function isPaidSeatSession(roomId: string, sessionID: string) {
  const room = roomById.get(roomId);
  if (!room) {
    return false;
  }
  return [...room.seats.values()].some(
    (seat) => seat.status === 'paid' && seat.sessionID === sessionID
  );
}

export function areSeatsFilled(roomId: string) {
  const room = roomById.get(roomId);
  if (!room) {
    return false;
  }
  return [...room.seats.values()].every((seat) => seat.status === 'paid');
}

export function hasAnyPaidSeat(roomId: string) {
  const room = roomById.get(roomId);
  if (!room) {
    return false;
  }
  return [...room.seats.values()].some((seat) => seat.status === 'paid');
}

export function setSeatReady(roomId: string, sessionID: string, ready: boolean) {
  const room = roomById.get(roomId);
  if (!room || room.phase !== 'lobby') {
    return { ok: false as const, reason: 'room_not_ready' };
  }
  if (room.postGame.settledAt) {
    return { ok: false as const, reason: 'postgame_settled' };
  }
  let seatRole: PlayerRole.Player1 | PlayerRole.Player2 | undefined;
  for (const [role, seat] of room.seats.entries()) {
    if (seat.status === 'paid' && seat.sessionID === sessionID) {
      seatRole = role;
      break;
    }
  }
  if (!seatRole) {
    return { ok: false as const, reason: 'not_paid_player' };
  }
  const seat = room.seats.get(seatRole)!;
  room.seats.set(seatRole, { ...seat, ready, disconnectedAt: undefined });
  noteActivity(room);
  return { ok: true as const, started: false };
}

export function markOnlineRoomSettledBySession(sessionID: string) {
  const room = [...roomById.values()].find((candidate) =>
    [...candidate.seats.values()].some(
      (seat) => seat.status === 'paid' && seat.sessionID === sessionID
    )
  );
  if (!room || room.phase !== 'finished') {
    return;
  }
  room.postGame.settledAt = Date.now();
  noteActivity(room);
  logOnlineState(`postgame settled roomId=${room.roomId} by session=${sessionID}`);
  const roomId = room.roomId;
  deleteRoom(roomId);
}

function playerIdForSession(room: OnlineRoom, sessionID: string): PlayerId | null {
  const p1 = room.seats.get(PlayerRole.Player1);
  const p2 = room.seats.get(PlayerRole.Player2);
  if (p1?.sessionID === sessionID) return 'P1';
  if (p2?.sessionID === sessionID) return 'P2';
  return null;
}

/** A key-down, or a direction that just became held. Key-up and lastAxis-only packets do not count. */
function inputCountsAsSteer(
  prev: OnlineSessionInput | undefined,
  payload: OnlineRoomInputPayload
): boolean {
  if (payload.intent) {
    return true;
  }
  const axes = ['up', 'down', 'left', 'right'] as const;
  return axes.some((axis) => payload[axis] === true && !prev?.[axis]);
}

export function updateRoomInput(roomId: string, sessionID: string, payload: OnlineRoomInputPayload) {
  const room = roomById.get(roomId);
  if (!room) {
    return;
  }
  const player = playerIdForSession(room, sessionID);
  if (!player) {
    return;
  }

  const prev = room.inputBySession.get(sessionID);
  const steered = inputCountsAsSteer(prev, payload);
  const input = mergeSessionInput(prev, payload);
  room.inputBySession.set(sessionID, input);
  if (steered) {
    const now = Date.now();
    for (const [role, seat] of room.seats.entries()) {
      if (seat.sessionID !== sessionID) {
        continue;
      }
      const banked = seat.idleSince ? bankSeatDisconnect(seat, now) : seat;
      room.seats.set(role, { ...banked, lastSteerAt: now });
    }
  }
  noteActivity(room);

  const state = room.snapshot.state;
  if (payload.intent) {
    applyInputIntent(state, player, input, payload.intent);
  }
  applyOnlineInputsToState(room);
}

export function confirmOnlineStart(roomId: string, sessionID: string) {
  const room = roomById.get(roomId);
  if (!room || room.phase !== 'playing') {
    return { ok: false as const, reason: 'room_not_playing' };
  }
  const state = room.snapshot.state;
  if (state.gameStarted || state.countdownStart) {
    return { ok: false as const, reason: 'already_started' };
  }
  let seatRole: PlayerRole.Player1 | PlayerRole.Player2 | undefined;
  for (const [role, seat] of room.seats.entries()) {
    if (seat.status === 'paid' && seat.sessionID === sessionID) {
      seatRole = role;
      break;
    }
  }
  if (!seatRole) {
    return { ok: false as const, reason: 'not_paid_player' };
  }
  const seat = room.seats.get(seatRole)!;
  if (seat.startConfirmed) {
    return { ok: true as const, countdownStarted: Boolean(state.countdownStart) };
  }
  const now = Date.now();
  const banked = bankSeatDisconnect(seat, now);
  room.seats.set(seatRole, {
    ...banked,
    startConfirmed: true,
    disconnectedAt: undefined,
    lastSteerAt: now,
  });
  noteActivity(room);
  const countdownStarted = maybeStartOnlineCountdown(room);
  logOnlineState(
    `arena start confirmed roomId=${roomId} session=${sessionID} countdownStarted=${countdownStarted}`
  );
  return { ok: true as const, countdownStarted };
}

/**
 * Held keys + latched direction + pending tap (see `onlineInput.ts`).
 * Called on every `roomInput` and each sim tick.
 */
export function applyOnlineInputsToState(room: OnlineRoom): void {
  if (room.phase !== 'playing') {
    return;
  }
  const p1 = room.seats.get(PlayerRole.Player1);
  const p2 = room.seats.get(PlayerRole.Player2);
  if (!p1?.sessionID || !p2?.sessionID) {
    return;
  }

  const state = room.snapshot.state;
  if (!state.gameStarted && !state.countdownStart) {
    // Pre-start: steering only (facing); countdown waits for mutual arena confirm.
  }

  const p1Input = room.inputBySession.get(p1.sessionID);
  const p2Input = room.inputBySession.get(p2.sessionID);
  if (p1Input) applySessionSteering(state, 'P1', p1Input);
  if (p2Input) applySessionSteering(state, 'P2', p2Input);
}

function consumePendingTurnsForRoom(room: OnlineRoom): void {
  const state = room.snapshot.state;
  const p1 = room.seats.get(PlayerRole.Player1);
  const p2 = room.seats.get(PlayerRole.Player2);
  if (p1?.sessionID) {
    const input = room.inputBySession.get(p1.sessionID);
    if (input) consumePendingTurn(state, 'P1', input);
  }
  if (p2?.sessionID) {
    const input = room.inputBySession.get(p2.sessionID);
    if (input) consumePendingTurn(state, 'P2', input);
  }
}

export function stepRoomSnapshot(roomId: string) {
  const room = roomById.get(roomId);
  if (!room || room.phase !== 'playing') {
    return;
  }
  resolveRoomDisconnects(room, Date.now());
  const live = roomById.get(roomId);
  if (!live || live.phase !== 'playing') {
    return;
  }
  if (isForfeitPaused(live)) {
    return;
  }
  const p1 = live.seats.get(PlayerRole.Player1);
  const p2 = live.seats.get(PlayerRole.Player2);
  if (!p1?.sessionID || !p2?.sessionID) {
    return;
  }

  const state = live.snapshot.state;
  const wasStarted = state.gameStarted;
  consumePendingTurnsForRoom(live);
  applyOnlineInputsToState(live);

  const respawned = stepOnlineGame(state);
  for (const player of respawned) {
    const sessionID =
      player === 'P1' ? p1.sessionID : player === 'P2' ? p2.sessionID : undefined;
    if (!sessionID) continue;
    const input = live.inputBySession.get(sessionID);
    if (input) clearSteeringOnRespawn(input);
  }
  live.snapshot.hud = getOnlineHudState(state);
  live.snapshot.tick += 1;
  if (!wasStarted && live.snapshot.state.gameStarted) {
    noteSimStartedSteer(live);
  }
  // Record from mutual arena confirm + countdown onward (skip idle pre-start arena).
  if (shouldRecordOnlineReplay(state)) {
    pushReplayFrame(live);
  }
  if (state.gameEnded) {
    setRoomPhase(roomId, 'postgame');
  }
}

/** Compact wire payload; client gunzips + decodes to full frames. */
export function getOnlineReplay(
  roomId: string,
  matchRound?: number
): OnlineReplayWirePayload | undefined {
  const room = roomById.get(roomId);
  if (room && room.replay.frames.length > 0) {
    if (matchRound == null || matchRound === room.matchRound) {
      const packed = packReplayForArchive(room.replay.frames, room.replay.tickMs, room.replay.blockEvents);
      return {
        roomId: room.roomId,
        matchRound: room.matchRound,
        ...packed,
      };
    }
  }
  return loadCompactReplayFromArchiveSync(roomId, matchRound);
}

export type OnlineRoomViewer = {
  sessionID?: string;
  socketID?: string;
};

/** True when the viewer is the match winner (recorded id, live seat session, or live seat socket). */
export function isOnlineRoomWinnerViewer(
  room: Pick<OnlineRoom, 'postGame' | 'seats'>,
  viewer?: OnlineRoomViewer
): boolean {
  if (!viewer?.sessionID && !viewer?.socketID) {
    return false;
  }
  if (
    viewer.sessionID &&
    room.postGame.winnerSessionID &&
    room.postGame.winnerSessionID === viewer.sessionID
  ) {
    return true;
  }
  const winnerRole = room.postGame.winnerRole;
  if (!winnerRole) {
    return false;
  }
  const winnerSeat = room.seats.get(winnerRole);
  if (!winnerSeat || winnerSeat.status !== 'paid') {
    return false;
  }
  if (viewer.socketID && winnerSeat.socketID === viewer.socketID) {
    return true;
  }
  return Boolean(viewer.sessionID && winnerSeat.sessionID === viewer.sessionID);
}

function postGameIncludesWithdrawLink(
  room: OnlineRoom,
  viewer?: OnlineRoomViewer
): boolean {
  return Boolean(room.postGame.lnurlw && isOnlineRoomWinnerViewer(room, viewer));
}

function buildPostGameWire(room: OnlineRoom, viewer?: OnlineRoomViewer) {
  return {
    p1Picture: room.postGame.p1Picture,
    p2Picture: room.postGame.p2Picture,
    winnerRole: room.postGame.winnerRole,
    winnerSessionID: room.postGame.winnerSessionID,
    winnerName: room.postGame.winnerName,
    winnerPicture: room.postGame.winnerPicture,
    winnerPoints: room.postGame.winnerPoints,
    totalPrize: room.postGame.totalPrize,
    ...(postGameIncludesWithdrawLink(room, viewer)
      ? { lnurlw: room.postGame.lnurlw }
      : {}),
    payoutMethod: room.postGame.payoutMethod,
    payoutTarget: room.postGame.payoutTarget,
    rematchRequested: room.postGame.rematchRequested,
    rematchRequiredAmount: room.postGame.rematchRequiredAmount,
    rematchEventId: room.postGame.rematchEventId,
    rematchNote1: room.postGame.rematchNote1,
    rematchWaitingForSessionID: room.postGame.rematchWaitingForSessionID,
    doubleOrNothingVotes: room.postGame.doubleOrNothingVotes.size,
  };
}

/** Strip LNURL-w from archived wire payloads unless the viewer is the recorded winner. */
export function redactSerializedRoomForViewer(
  serialized: Record<string, unknown>,
  viewer?: OnlineRoomViewer
): Record<string, unknown> {
  const postGame = serialized.postGame as
    | { lnurlw?: string; winnerSessionID?: string; winnerRole?: PlayerRole.Player1 | PlayerRole.Player2 }
    | undefined;
  if (!postGame?.lnurlw) {
    return serialized;
  }
  if (viewer?.sessionID && postGame.winnerSessionID === viewer.sessionID) {
    return serialized;
  }
  const seats = serialized.seats as
    | Record<string, { sessionID?: string; socketID?: string }>
    | undefined;
  const winnerRole = postGame.winnerRole;
  const winnerSeat = winnerRole && seats ? seats[winnerRole] : undefined;
  if (
    viewer?.sessionID &&
    viewer.socketID &&
    winnerSeat?.sessionID === viewer.sessionID &&
    winnerSeat.socketID === viewer.socketID
  ) {
    return serialized;
  }
  const { lnurlw: _removed, ...safePostGame } = postGame;
  return { ...serialized, postGame: safePostGame };
}

export function serializeRoom(room: OnlineRoom, viewer?: OnlineRoomViewer) {
  return {
    roomId: room.roomId,
    roomCode: room.roomCode,
    hostSessionID: room.hostSessionID,
    buyin: room.buyin,
    matchRound: room.matchRound,
    createdAt: room.createdAt,
    finishedAt:
      room.phase === 'finished'
        ? room.postGame.settledAt ?? room.updatedAt
        : undefined,
    phase: room.phase,
    kind1EventId: room.kind1EventId,
    nostrMeta: room.nostrMeta,
    seats: Object.fromEntries(room.seats),
    spectators: [...room.spectators],
    snapshot: room.snapshot,
    forfeit: getOnlineForfeitStatus(room),
    claim: getOnlineClaimStatus(room),
    result:
      room.phase === 'postgame' || room.phase === 'finished'
        ? roomToFinishedResult(room)
        : undefined,
    replay: {
      available: room.replay.frames.length > 0,
      frameCount: room.replay.frames.length,
      tickMs: room.replay.tickMs,
      durationMs: room.replay.frames.length * room.replay.tickMs,
    },
    postGame: buildPostGameWire(room, viewer),
  };
}

type OnlinePostGameInfo = NonNullable<ReturnType<typeof getOnlinePostGameInternal>>;

function getOnlinePostGameInternal(roomId: string) {
  const room = roomById.get(roomId);
  if (room && (room.phase === 'postgame' || room.phase === 'finished')) {
    ensurePostGameState(room);
    const p1Seat = room.seats.get(PlayerRole.Player1);
    const p2Seat = room.seats.get(PlayerRole.Player2);
    return {
      roomId: room.roomId,
      phase: room.phase,
      p1Name: p1Seat?.name ?? 'Player 1',
      p2Name: p2Seat?.name ?? 'Player 2',
      p1Picture: p1Seat?.picture ?? room.postGame.p1Picture,
      p2Picture: p2Seat?.picture ?? room.postGame.p2Picture,
      p1SessionID: p1Seat?.sessionID,
      p2SessionID: p2Seat?.sessionID,
      p1SocketID: p1Seat?.socketID,
      p2SocketID: p2Seat?.socketID,
      p1Points: room.snapshot.state.score[0],
      p2Points: room.snapshot.state.score[1],
      winnerRole: room.postGame.winnerRole,
      winnerSessionID: room.postGame.winnerSessionID,
      winnerName: room.postGame.winnerName,
      winnerPicture: room.postGame.winnerPicture,
      winnerPoints: room.postGame.winnerPoints,
      totalPrize: room.postGame.totalPrize,
      lnurlw: room.postGame.lnurlw,
      payoutMethod: room.postGame.payoutMethod,
      payoutTarget: room.postGame.payoutTarget,
      rematchRequested: room.postGame.rematchRequested,
      rematchRequiredAmount: room.postGame.rematchRequiredAmount,
      rematchEventId: room.postGame.rematchEventId,
      rematchNote1: room.postGame.rematchNote1,
      rematchWaitingForSessionID: room.postGame.rematchWaitingForSessionID,
      winnerLnAddress:
        room.postGame.winnerRole != null
          ? room.seats.get(room.postGame.winnerRole)?.lnAddress
          : undefined,
      doubleOrNothingVotes: room.postGame.doubleOrNothingVotes.size,
      claim: getOnlineClaimStatus(room),
      _room: room,
    };
  }
  const archived = getOnlinePostGameFromArchive(roomId);
  if (!archived) {
    return undefined;
  }
  return { ...archived, _room: undefined as OnlineRoom | undefined };
}

function redactPostGameInfoForViewer(
  info: OnlinePostGameInfo,
  viewer?: OnlineRoomViewer
): Omit<OnlinePostGameInfo, '_room' | 'lnurlw'> & { lnurlw?: string } {
  const includeWithdrawLink = info._room
    ? postGameIncludesWithdrawLink(info._room, viewer)
    : Boolean(viewer?.sessionID && info.winnerSessionID === viewer.sessionID && info.lnurlw);
  const { _room, lnurlw, ...rest } = info;
  return includeWithdrawLink && lnurlw ? { ...rest, lnurlw } : rest;
}

export function getOnlinePostGame(roomId: string, viewer?: OnlineRoomViewer) {
  const info = getOnlinePostGameInternal(roomId);
  if (!info) {
    return undefined;
  }
  return redactPostGameInfoForViewer(info, viewer);
}

/**
 * Per-round results for victory/history UI: index rows for each completed sim, plus the current
 * postgame round from RAM if the async match archive has not landed yet.
 */
export function getOnlineMatchRoundHistory(roomId: string): OnlineMatchRoundSummary[] {
  const fromArchive = listArchivedMatchRoundsForRoomSync(roomId);
  const room = roomById.get(roomId);
  if (!room || (room.phase !== 'postgame' && room.phase !== 'finished')) {
    return fromArchive;
  }
  const mr = room.matchRound;
  if (mr < 1) {
    return fromArchive;
  }
  if (fromArchive.some((r) => r.matchRound === mr)) {
    return fromArchive;
  }
  const res = roomToFinishedResult(room);
  const synthesized: OnlineMatchRoundSummary = {
    matchRound: mr,
    finishedAt: room.postGame.settledAt ?? room.updatedAt,
    winnerName: res.winnerName,
    p1Name: res.p1Name,
    p2Name: res.p2Name,
    p1Score: res.p1Score,
    p2Score: res.p2Score,
    netPrize: res.netPrize,
    winnerRole: res.winnerRole,
    replayAvailable: room.replay.frames.length > 0,
  };
  return [...fromArchive, synthesized].sort((a, b) => a.matchRound - b.matchRound);
}

export function setOnlinePostGameLnurlw(roomId: string, lnurlw: string) {
  const room = roomById.get(roomId);
  if (!room) {
    return;
  }
  if (room.postGame.rematchEventId) {
    roomIdByKind1EventId.delete(room.postGame.rematchEventId);
  }
  room.postGame.lnurlw = lnurlw;
  room.postGame.payoutMethod = 'withdraw_qr';
  room.postGame.payoutTarget = undefined;
  room.postGame.rematchRequested = false;
  room.postGame.rematchRequiredAmount = undefined;
  room.postGame.rematchEventId = undefined;
  room.postGame.rematchNote1 = undefined;
  room.postGame.rematchWaitingForSessionID = undefined;
  noteActivity(room);
  logOnlineState(`set postgame lnurlw roomId=${roomId}`);
  if (room.phase === 'postgame') {
    setRoomPhase(roomId, 'finished');
  }
}

export function setOnlinePostGameNostrPayout(roomId: string, lnAddress: string) {
  const room = roomById.get(roomId);
  if (!room) {
    return;
  }
  if (room.postGame.rematchEventId) {
    roomIdByKind1EventId.delete(room.postGame.rematchEventId);
  }
  room.postGame.payoutMethod = 'nostr_zap';
  room.postGame.payoutTarget = lnAddress;
  room.postGame.rematchRequested = false;
  room.postGame.rematchRequiredAmount = undefined;
  room.postGame.rematchEventId = undefined;
  room.postGame.rematchNote1 = undefined;
  room.postGame.rematchWaitingForSessionID = undefined;
  noteActivity(room);
  logOnlineState(`set postgame nostr payout roomId=${roomId} lnAddress=${lnAddress}`);
  if (room.phase === 'postgame') {
    setRoomPhase(roomId, 'finished');
  }
}

export function markOnlineRematchPending(params: {
  roomId: string;
  requiredAmount: number;
  waitingForSessionID?: string;
}): boolean {
  const room = roomById.get(params.roomId);
  if (!room || room.phase !== 'postgame') {
    return false;
  }
  room.postGame.rematchRequested = true;
  room.postGame.rematchRequiredAmount = params.requiredAmount;
  room.postGame.rematchWaitingForSessionID = params.waitingForSessionID;
  room.postGame.rematchEventId = undefined;
  room.postGame.rematchNote1 = undefined;
  room.postGame.lnurlw = undefined;
  room.postGame.payoutMethod = undefined;
  room.postGame.payoutTarget = undefined;
  noteActivity(room);
  logOnlineState(
    `rematch pending roomId=${params.roomId} amount=${params.requiredAmount} waiting=${params.waitingForSessionID ?? 'none'}`
  );
  return true;
}

export function setOnlineRematchRequested(params: {
  roomId: string;
  requiredAmount: number;
  rematchEventId: string;
  rematchNote1: string;
  waitingForSessionID?: string;
}) {
  const room = roomById.get(params.roomId);
  if (!room || room.phase !== 'postgame') {
    return;
  }
  room.postGame.rematchRequested = true;
  room.postGame.rematchRequiredAmount = params.requiredAmount;
  room.postGame.rematchEventId = params.rematchEventId;
  room.postGame.rematchNote1 = params.rematchNote1;
  room.postGame.rematchWaitingForSessionID = params.waitingForSessionID;
  roomIdByKind1EventId.set(params.rematchEventId, params.roomId);
  room.postGame.payoutMethod = undefined;
  room.postGame.payoutTarget = undefined;
  room.postGame.lnurlw = undefined;
  noteActivity(room);
  logOnlineState(
    `rematch requested roomId=${params.roomId} amount=${params.requiredAmount} event=${params.rematchEventId}`
  );
}

export function isNostrLinkPubkeyForSession(
  roomId: string,
  pubkeyHex: string,
  sessionID: string
): boolean {
  const key = nostrLinkKey(roomId, pubkeyHex);
  const rec = nostrLinkByRoomPubkey.get(key);
  if (!rec || rec.roomId !== roomId || rec.sessionID !== sessionID) {
    return false;
  }
  return rec.expiresAt > Date.now();
}

export function isRematchLoserSession(room: { phase: string; postGame: { rematchRequested?: boolean; rematchWaitingForSessionID?: string } }, sessionID: string): boolean {
  return (
    room.phase === 'postgame' &&
    Boolean(room.postGame.rematchRequested) &&
    room.postGame.rematchWaitingForSessionID === sessionID
  );
}

export function settleOnlineRematchPayment(params: {
  roomId: string;
  payerPubkey?: string;
  amount: number;
}) {
  const room = roomById.get(params.roomId);
  if (!room || room.phase !== 'postgame') {
    return { ok: false as const, reason: 'room_not_finished' };
  }
  if (!room.postGame.rematchRequested || !room.postGame.rematchRequiredAmount) {
    return { ok: false as const, reason: 'rematch_not_requested' };
  }
  const requiredAmount = room.postGame.rematchRequiredAmount;
  if (params.amount < requiredAmount) {
    return { ok: false as const, reason: 'amount_too_low' };
  }
  const winnerRole = room.postGame.winnerRole;
  if (!winnerRole) {
    return { ok: false as const, reason: 'winner_unknown' };
  }
  const loserRole = winnerRole === PlayerRole.Player1 ? PlayerRole.Player2 : PlayerRole.Player1;
  const winnerSeat = room.seats.get(winnerRole);
  const loserSeat = room.seats.get(loserRole);
  if (!winnerSeat || !loserSeat || !winnerSeat.sessionID || !loserSeat.sessionID) {
    return { ok: false as const, reason: 'seats_not_ready' };
  }
  if (winnerSeat.pubkey && params.payerPubkey && params.payerPubkey === winnerSeat.pubkey) {
    return { ok: false as const, reason: 'winner_cannot_match' };
  }
  const loserSessionId = loserSeat.sessionID;
  const waitingForLoser = room.postGame.rematchWaitingForSessionID === loserSessionId;
  const payerPk = params.payerPubkey?.toLowerCase();
  const payerOk = (() => {
    if (!payerPk) {
      return !loserSeat.pubkey && loserSeat.payMethod !== 'lightning';
    }
    if (loserSeat.payMethod === 'lightning') {
      // Lightning buy-in uses a fresh ephemeral key per payment ? match session link, not seat pubkey.
      return Boolean(
        waitingForLoser &&
          loserSessionId &&
          isNostrLinkPubkeyForSession(room.roomId, payerPk, loserSessionId)
      );
    }
    return (
      payerPk === loserSeat.pubkey?.toLowerCase() ||
      Boolean(
        waitingForLoser &&
          loserSessionId &&
          isNostrLinkPubkeyForSession(room.roomId, payerPk, loserSessionId)
      )
    );
  })();
  if (!payerOk) {
    return { ok: false as const, reason: 'not_loser' };
  }
  room.seats.set(winnerRole, {
    ...winnerSeat,
    paidAmount: requiredAmount,
    ready: false,
    startConfirmed: false,
    disconnectedAt: undefined,
    disconnectMs: 0,
    idleSince: undefined,
    lastSteerAt: undefined,
  });
  room.postGame.claimStartedAt = undefined;
  room.postGame.claimMs = undefined;
  room.postGame.payoutLock = undefined;
  room.postGame.claimPayoutPending = undefined;
  room.postGame.claimPayoutAttemptAt = undefined;
  room.seats.set(loserRole, {
    ...loserSeat,
    paidAmount: requiredAmount,
    ready: false,
    startConfirmed: false,
    disconnectedAt: undefined,
    disconnectMs: 0,
    idleSince: undefined,
    lastSteerAt: undefined,
  });
  resetRoomToLobby(room);
  noteActivity(room);
  logOnlineState(`rematch paid roomId=${params.roomId} amount=${requiredAmount}`);
  const matchStarted = maybeStartPaidMatch(room);
  return { ok: true as const, room, requiredAmount, matchStarted };
}

export function voteOnlineDoubleOrNothing(roomId: string, sessionID: string) {
  const room = roomById.get(roomId);
  if (!room || room.phase !== 'postgame') {
    return { ok: false as const, reason: 'room_not_postgame' };
  }
  // Once payout flow is started for this round, rematch is no longer allowed.
  if (room.postGame.lnurlw || room.postGame.payoutMethod === 'nostr_zap') {
    return { ok: false as const, reason: 'withdraw_started' };
  }
  if (room.postGame.rematchRequested) {
    return { ok: false as const, reason: 'rematch_pending' };
  }
  const p1 = room.seats.get(PlayerRole.Player1);
  const p2 = room.seats.get(PlayerRole.Player2);
  const isPlayer = p1?.sessionID === sessionID || p2?.sessionID === sessionID;
  if (!isPlayer) {
    return { ok: false as const, reason: 'not_player' };
  }
  room.postGame.doubleOrNothingVotes.add(sessionID);
  noteActivity(room);
  const agreed =
    p1?.sessionID != null &&
    p2?.sessionID != null &&
    room.postGame.doubleOrNothingVotes.has(p1.sessionID) &&
    room.postGame.doubleOrNothingVotes.has(p2.sessionID);
  logOnlineState(
    `double-or-nothing vote roomId=${roomId} session=${sessionID} votes=${room.postGame.doubleOrNothingVotes.size} agreed=${agreed}`
  );
  return {
    ok: true as const,
    votes: room.postGame.doubleOrNothingVotes.size,
    agreed,
  };
}

function syncAuthoritativePlayers(roomId: string) {
  const room = roomById.get(roomId);
  if (!room) return;
  const p1 = room.seats.get(PlayerRole.Player1);
  const p2 = room.seats.get(PlayerRole.Player2);
  const state = room.snapshot.state;
  state.p1Name = p1?.name ?? 'Player 1';
  state.p2Name = p2?.name ?? 'Player 2';
  const p1Amount = Math.floor(p1?.paidAmount ?? room.buyin);
  const p2Amount = Math.floor(p2?.paidAmount ?? room.buyin);
  state.initialScore = [p1Amount, p2Amount];
  state.score = [p1Amount, p2Amount];
  state.totalPoints = p1Amount + p2Amount;
  room.snapshot.hud = getOnlineHudState(state);
}

export function runOnlineRoomCleanup(now = Date.now()) {
  for (const [key, record] of pinByValue.entries()) {
    if (
      (record.expiresAt <= now && !shouldPinStayActive(record)) ||
      (record.used && (record.usedAt ?? 0) + PIN_TTL_MS < now)
    ) {
      logOnlineState(`cleanup pin roomId=${record.roomId} pin=${record.pin}`);
      pinByValue.delete(key);
    }
  }
  for (const [sid, p] of pendingNostrChallengeBySession.entries()) {
    if (p.expiresAt <= now) {
      pendingNostrChallengeBySession.delete(sid);
    }
  }
  for (const key of [...nostrLinkByRoomPubkey.keys()]) {
    const rec = nostrLinkByRoomPubkey.get(key);
    if (rec && rec.expiresAt <= now) {
      nostrLinkByRoomPubkey.delete(key);
    }
  }
  resolveOnlineDisconnects(now);
  for (const room of [...roomById.values()]) {
    if (room.postGame.settledAt && now - room.postGame.settledAt > SETTLED_ROOM_DELETE_FALLBACK_MS) {
      logOnlineState(
        `cleanup settled room fallback roomId=${room.roomId} settledMs=${now - room.postGame.settledAt}`
      );
      deleteRoom(room.roomId);
      continue;
    }

    if (shouldDeleteIdleRoom(room, now)) {
      logOnlineState(
        `cleanup idle room roomId=${room.roomId} inactiveMs=${now - (room.lastActivityAt ?? room.createdAt)}`
      );
      deleteRoom(room.roomId);
    }
  }
}

setInterval(() => {
  runOnlineRoomCleanup();
}, ROOM_CLEANUP_MS);

function shouldPinStayActive(record: JoinPinRecord) {
  const room = roomById.get(record.roomId);
  if (!room) {
    return false;
  }
  const hasOpenSeats = [...room.seats.values()].some((seat) => seat.status === 'open');
  const userStillInRoom = room.members.has(record.sessionID);
  return hasOpenSeats && userStillInRoom;
}

function pinRecordKey(roomId: string, pin: string) {
  return `${roomId}:${pin}`;
}

function shouldDeleteIdleRoom(room: OnlineRoom, now: number) {
  const inactiveFor = now - (room.lastActivityAt ?? room.createdAt);
  if (inactiveFor <= ROOM_IDLE_TTL_MS) {
    return false;
  }
  if (room.phase === 'playing' || room.phase === 'postgame') {
    return false;
  }
  const hasPaidSeat = [...room.seats.values()].some((seat) => seat.status === 'paid');
  if (hasPaidSeat) {
    return false;
  }
  if (blockingMemberCount(room) > 0) {
    return false;
  }
  return true;
}

function blockingMemberCount(room: OnlineRoom): number {
  let count = 0;
  for (const sessionID of room.members.keys()) {
    if (getSocketFromID(sessionID)) {
      count += 1;
    }
  }
  return count;
}

function isForfeitPaused(room: OnlineRoom): boolean {
  if (room.phase !== 'playing' && room.phase !== 'lobby') {
    return false;
  }
  const seats = [...room.seats.values()];
  const paid = seats.filter((seat) => seat.status === 'paid');
  if (paid.length < 2) {
    return false;
  }
  return paid.some((seat) => seat.disconnectedAt != null);
}

function forfeitSeatClock(
  seat: OnlineSeatState | undefined,
  now: number
): { remainingMs: number; reason: 'disconnect' | 'idle' } | undefined {
  if (!seat || seat.status !== 'paid') {
    return undefined;
  }
  if (!seat.disconnectedAt && !seat.idleSince) {
    return undefined;
  }
  return {
    remainingMs: Math.max(0, ONLINE_FORFEIT_DISCONNECT_MS - seatDisconnectTotalMs(seat, now)),
    reason: seat.disconnectedAt ? 'disconnect' : 'idle',
  };
}

export function getOnlineForfeitStatus(room: OnlineRoom, now = Date.now()): OnlineForfeitPause | undefined {
  if (room.phase === 'postgame' || room.phase === 'finished' || room.phase === 'cancelled') {
    return undefined;
  }
  const p1 = forfeitSeatClock(room.seats.get(PlayerRole.Player1), now);
  const p2 = forfeitSeatClock(room.seats.get(PlayerRole.Player2), now);
  if (!p1 && !p2) {
    return undefined;
  }
  return {
    paused: p1?.reason === 'disconnect' || p2?.reason === 'disconnect',
    limitMs: ONLINE_FORFEIT_DISCONNECT_MS,
    p1RemainingMs: p1?.remainingMs,
    p2RemainingMs: p2?.remainingMs,
    p1Reason: p1?.reason,
    p2Reason: p2?.reason,
  };
}

const CLAIM_PAYOUT_RETRY_MS = 15 * 1000;

function payoutChosen(room: OnlineRoom): boolean {
  return Boolean(room.postGame.lnurlw || room.postGame.payoutMethod);
}

function claimElapsedMs(room: OnlineRoom, now: number): number {
  const started = room.postGame.claimStartedAt;
  if (!started) {
    return 0;
  }
  return Math.max(0, now - started);
}

function claimWinnerSeat(room: OnlineRoom): OnlineSeatState | undefined {
  const role = room.postGame.winnerRole;
  return role ? room.seats.get(role) : undefined;
}

function claimAwayTotalMs(room: OnlineRoom, now: number): number {
  const banked = room.postGame.claimMs ?? 0;
  const winner = claimWinnerSeat(room);
  if (!winner?.disconnectedAt) {
    return banked;
  }
  return banked + Math.max(0, now - winner.disconnectedAt);
}

function claimClockDue(room: OnlineRoom, now: number): boolean {
  if (claimElapsedMs(room, now) >= ONLINE_CLAIM_PRESENCE_MS) {
    return true;
  }
  const winner = claimWinnerSeat(room);
  if (!winner?.disconnectedAt) {
    return false;
  }
  return claimAwayTotalMs(room, now) >= ONLINE_FORFEIT_DISCONNECT_MS;
}

/** Prize deadline until a payout or rematch locks. The sooner of presence and, while the winner is gone, the away bank. */
export function getOnlineClaimStatus(room: OnlineRoom, now = Date.now()): OnlineClaimClock | undefined {
  if (room.phase !== 'postgame' || room.postGame.rematchRequested || payoutChosen(room)) {
    return undefined;
  }
  if (room.postGame.payoutLock || !room.postGame.claimStartedAt) {
    return undefined;
  }
  const presenceMs = Math.max(0, ONLINE_CLAIM_PRESENCE_MS - claimElapsedMs(room, now));
  const winner = claimWinnerSeat(room);
  if (!winner?.disconnectedAt) {
    return { remainingMs: presenceMs, limitMs: ONLINE_CLAIM_PRESENCE_MS };
  }
  const awayMs = Math.max(0, ONLINE_FORFEIT_DISCONNECT_MS - claimAwayTotalMs(room, now));
  if (awayMs <= presenceMs) {
    return { remainingMs: awayMs, limitMs: ONLINE_FORFEIT_DISCONNECT_MS };
  }
  return { remainingMs: presenceMs, limitMs: ONLINE_CLAIM_PRESENCE_MS };
}

export type ClaimPayoutJob = {
  roomId: string;
  lnAddress: string;
  amountSats: number;
  winnerSessionID?: string;
};

const claimPayoutQueue: ClaimPayoutJob[] = [];

export function takeDueClaimPayouts(): ClaimPayoutJob[] {
  return claimPayoutQueue.splice(0, claimPayoutQueue.length);
}

export function completeOnlineClaimPayout(roomId: string, lnAddress: string) {
  const room = roomById.get(roomId);
  if (!room) {
    return;
  }
  room.postGame.claimPayoutPending = undefined;
  setOnlinePostGameNostrPayout(roomId, lnAddress);
}

export function failOnlineClaimPayout(roomId: string) {
  const room = roomById.get(roomId);
  if (!room) {
    return;
  }
  if (room.postGame.payoutLock === 'auto') {
    room.postGame.payoutLock = undefined;
  }
  room.postGame.claimPayoutPending = undefined;
  room.postGame.claimPayoutAttemptAt = Date.now();
  logOnlineState(`claim payout failed roomId=${roomId}`);
}

/** Set before any payout await. False when a payout is already locked, chosen, or a rematch is locked. */
export function tryLockOnlinePayout(roomId: string, kind: 'lnurlw' | 'nostr'): boolean {
  const room = roomById.get(roomId);
  if (!room || room.phase !== 'postgame') {
    return false;
  }
  if (room.postGame.payoutLock || room.postGame.rematchRequested || payoutChosen(room)) {
    return false;
  }
  room.postGame.payoutLock = kind;
  return true;
}

/** Drop the lock after a payout attempt fails. A successful payout leaves it set. */
export function unlockOnlinePayout(roomId: string) {
  const room = roomById.get(roomId);
  if (!room) {
    return;
  }
  room.postGame.payoutLock = undefined;
  room.postGame.claimPayoutPending = undefined;
}

/** Mark paid seats whose socket is gone, then apply the forfeit clock. */
export function syncOnlineSeatSockets(
  isConnected: (socketID: string) => boolean,
  now = Date.now()
) {
  for (const room of [...roomById.values()]) {
    if (room.phase === 'finished' || room.phase === 'cancelled') {
      continue;
    }
    let newlyGone = false;
    for (const [role, seat] of room.seats.entries()) {
      if (seat.status !== 'paid' || !seat.sessionID) {
        continue;
      }
      const connected = Boolean(seat.socketID && isConnected(seat.socketID));
      if (connected || seat.disconnectedAt) {
        continue;
      }
      room.seats.set(role, markSeatDisconnected(seat, now));
      room.members.delete(seat.sessionID);
      room.spectators.delete(seat.sessionID);
      room.inputBySession.delete(seat.sessionID);
      newlyGone = true;
      logOnlineState(
        `seat socket gone roomId=${room.roomId} role=${role} session=${seat.sessionID}`
      );
    }
    if (newlyGone) {
      notifyOnlineRoomChange({ roomId: room.roomId, prev: room.phase, next: room.phase });
    }
    if (room.phase === 'postgame') {
      resolveClaimClock(room, now);
    } else {
      resolveRoomDisconnects(room, now);
    }
  }
}

export function resolveOnlineDisconnects(now = Date.now()) {
  for (const room of [...roomById.values()]) {
    if (!roomById.has(room.roomId)) {
      continue;
    }
    if (room.phase === 'postgame') {
      resolveClaimClock(room, now);
    } else {
      resolveRoomDisconnects(room, now);
    }
  }
}

function seatForfeitDue(seat: OnlineSeatState | undefined, now: number): boolean {
  return Boolean(
    seat &&
      seat.status === 'paid' &&
      (seat.disconnectedAt || seat.idleSince) &&
      seatDisconnectTotalMs(seat, now) >= ONLINE_FORFEIT_DISCONNECT_MS
  );
}

function seatIsPresent(seat: OnlineSeatState): boolean {
  return !seat.disconnectedAt && !seat.idleSince;
}

/** A paid seat is idle once the sim is running and they have not steered for the grace period. */
function syncSeatIdle(room: OnlineRoom, now: number) {
  if (room.phase !== 'playing' || !room.snapshot.state.gameStarted) {
    return;
  }
  let changed = false;
  for (const [role, seat] of room.seats.entries()) {
    if (seat.status !== 'paid' || seat.disconnectedAt) {
      continue;
    }
    const steeredAt = seat.lastSteerAt;
    const recent = steeredAt != null && now - steeredAt <= ONLINE_IDLE_GRACE_MS;
    if (recent) {
      if (seat.idleSince) {
        room.seats.set(role, bankSeatDisconnect(seat, now));
        changed = true;
      }
      continue;
    }
    if (seat.idleSince) {
      continue;
    }
    room.seats.set(role, { ...seat, idleSince: now });
    changed = true;
  }
  if (changed) {
    notifyOnlineRoomChange({ roomId: room.roomId, prev: room.phase, next: room.phase });
  }
}

function noteSimStartedSteer(room: OnlineRoom, now = Date.now()) {
  if (simSteerAnchored.has(room)) {
    return;
  }
  simSteerAnchored.add(room);
  for (const [role, seat] of room.seats.entries()) {
    if (seat.status !== 'paid') {
      continue;
    }
    room.seats.set(role, { ...seat, lastSteerAt: now });
  }
}

function resolveRoomDisconnects(room: OnlineRoom, now: number) {
  if (room.phase === 'postgame' || room.phase === 'finished' || room.phase === 'cancelled') {
    return;
  }
  if (room.phase === 'playing') {
    syncSeatIdle(room, now);
  }
  const p1 = room.seats.get(PlayerRole.Player1);
  const p2 = room.seats.get(PlayerRole.Player2);
  if (!p1 || !p2) {
    return;
  }
  const bothPaid = p1.status === 'paid' && p2.status === 'paid';
  if (bothPaid) {
    const p1Due = seatForfeitDue(p1, now);
    const p2Due = seatForfeitDue(p2, now);
    if (!p1Due && !p2Due) {
      return;
    }
    const p1Here = seatIsPresent(p1);
    const p2Here = seatIsPresent(p2);
    if ((p1Due && p2Due) || (p1Due && !p2Here) || (p2Due && !p1Here)) {
      const idle = Boolean(p1.idleSince || p2.idleSince);
      abandonPaidMatch(room, idle ? 'idle' : 'both_disconnected');
      return;
    }
    if (p2Due && p1Here) {
      awardDisconnectForfeit(room, PlayerRole.Player1);
      return;
    }
    if (p1Due && p2Here) {
      awardDisconnectForfeit(room, PlayerRole.Player2);
    }
    return;
  }
  if (room.phase !== 'lobby') {
    return;
  }
  for (const [role, seat] of room.seats.entries()) {
    if (seatForfeitDue(seat, now)) {
      abandonLobbySeat(room, role, seat);
      return;
    }
  }
}

function awardDisconnectForfeit(room: OnlineRoom, winnerRole: PlayerRole.Player1 | PlayerRole.Player2) {
  const p1 = room.seats.get(PlayerRole.Player1);
  const p2 = room.seats.get(PlayerRole.Player2);
  const total = Math.floor((p1?.paidAmount ?? 0) + (p2?.paidAmount ?? 0));
  const state = room.snapshot.state;
  const pot = total > 0 ? total : state.totalPoints;
  state.totalPoints = pot;
  state.gameEnded = true;
  state.countdownStart = false;
  if (winnerRole === PlayerRole.Player2) {
    state.winnerPlayer = 'P2';
    state.winnerName = p2?.name ?? state.p2Name;
    state.score = [0, pot];
  } else {
    state.winnerPlayer = 'P1';
    state.winnerName = p1?.name ?? state.p1Name;
    state.score = [pot, 0];
  }
  room.snapshot.hud = getOnlineHudState(state);
  room.postGame.outcome = 'forfeit';
  if (room.matchRound < 1) {
    room.matchRound = 1;
  }
  logOnlineState(
    `forfeit roomId=${room.roomId} winner=${winnerRole === PlayerRole.Player2 ? 'P2' : 'P1'} pot=${pot}`
  );
  trackOnlineOk('online.match.forfeit', {
    roomId: room.roomId,
    roomCode: room.roomCode,
    buyin: room.buyin,
    amountSats: pot,
    meta: { winner: winnerRole === PlayerRole.Player2 ? 'P2' : 'P1' },
  });
  setRoomPhase(room.roomId, 'postgame');
}

function abandonPaidMatch(room: OnlineRoom, reason: string) {
  const p1Paid = Math.floor(room.seats.get(PlayerRole.Player1)?.paidAmount ?? 0);
  const p2Paid = Math.floor(room.seats.get(PlayerRole.Player2)?.paidAmount ?? 0);
  room.postGame.outcome = 'abandoned';
  room.postGame.winnerRole = undefined;
  room.postGame.winnerSessionID = undefined;
  room.postGame.winnerName = 'Abandoned';
  room.postGame.winnerPoints = 0;
  room.postGame.totalPrize = 0;
  room.postGame.settledAt = Date.now();
  room.snapshot.state.gameEnded = true;
  room.snapshot.state.countdownStart = false;
  room.snapshot.state.winnerPlayer = null;
  room.snapshot.state.winnerName = '';
  if (room.matchRound < 1) {
    room.matchRound = 1;
  }
  logOnlineState(
    `abandoned roomId=${room.roomId} reason=${reason} p1Paid=${p1Paid} p2Paid=${p2Paid}`
  );
  trackOnlineOk('online.room.abandoned', {
    roomId: room.roomId,
    roomCode: room.roomCode,
    buyin: room.buyin,
    amountSats: p1Paid + p2Paid,
    meta: { reason, p1Paid, p2Paid },
  });
  const prevPhase = room.phase;
  room.phase = 'finished';
  room.snapshot.phase = 'finished';
  logOnlineState(`phase changed roomId=${room.roomId} ${prevPhase} -> finished`);
  const matchRound = room.matchRound;
  void appendOnlineMatchArchive({
    version: 1,
    kind: 'match',
    roomId: room.roomId,
    matchRound,
    archiveId: `${room.roomId}-r${matchRound}`,
    finishedAt: Date.now(),
    serializedRoom: serializeRoom(room) as Record<string, unknown>,
    replay: packReplayForArchive([...room.replay.frames], room.replay.tickMs, room.replay.blockEvents),
  });
  deleteRoom(room.roomId, { roomNotFound: true });
}

function abandonLobbySeat(
  room: OnlineRoom,
  role: PlayerRole.Player1 | PlayerRole.Player2,
  seat: OnlineSeatState
) {
  const paid = Math.floor(seat.paidAmount ?? 0);
  logOnlineState(
    `abandoned lobby seat roomId=${room.roomId} role=${role} paid=${paid}`
  );
  trackOnlineOk('online.room.abandoned', {
    roomId: room.roomId,
    roomCode: room.roomCode,
    buyin: room.buyin,
    sessionID: seat.sessionID,
    amountSats: paid,
    meta: { reason: 'lobby_seat', role: role === PlayerRole.Player2 ? 'p2' : 'p1', paid },
  });
  deleteRoom(room.roomId, { roomNotFound: true });
}

function archiveUnclaimedPrize(room: OnlineRoom, amountSats: number) {
  const winner = claimWinnerSeat(room);
  const pubkey = winner?.pubkey;
  room.postGame.outcome = 'unclaimed';
  room.postGame.settledAt = Date.now();
  if (room.matchRound < 1) {
    room.matchRound = 1;
  }
  logOnlineState(
    `unclaimed prize roomId=${room.roomId} amount=${amountSats} session=${winner?.sessionID ?? 'none'}`
  );
  trackOnlineOk('online.prize.unclaimed', {
    roomId: room.roomId,
    roomCode: room.roomCode,
    buyin: room.buyin,
    sessionID: winner?.sessionID,
    pubkeyPrefix: pubkey ? pubkey.slice(0, 8) : undefined,
    amountSats,
    meta: {
      winnerSessionID: winner?.sessionID ?? '',
      winnerPubkey: pubkey ?? '',
    },
  });
  const prevPhase = room.phase;
  room.phase = 'finished';
  room.snapshot.phase = 'finished';
  logOnlineState(`phase changed roomId=${room.roomId} ${prevPhase} -> finished`);
  const matchRound = room.matchRound;
  void appendOnlineMatchArchive({
    version: 1,
    kind: 'match',
    roomId: room.roomId,
    matchRound,
    archiveId: `${room.roomId}-r${matchRound}`,
    finishedAt: Date.now(),
    serializedRoom: serializeRoom(room) as Record<string, unknown>,
    replay: packReplayForArchive([...room.replay.frames], room.replay.tickMs, room.replay.blockEvents),
  });
  deleteRoom(room.roomId, { roomNotFound: true });
}

function resolveClaimClock(room: OnlineRoom, now: number) {
  if (!roomById.has(room.roomId) || room.phase !== 'postgame') {
    return;
  }
  if (room.postGame.rematchRequested || payoutChosen(room) || room.postGame.payoutLock || room.postGame.claimPayoutPending) {
    return;
  }
  if (!claimClockDue(room, now)) {
    return;
  }
  const retryAt = room.postGame.claimPayoutAttemptAt ?? 0;
  if (retryAt && now - retryAt < CLAIM_PAYOUT_RETRY_MS) {
    return;
  }
  const winnerRole = room.postGame.winnerRole;
  const winner = winnerRole ? room.seats.get(winnerRole) : undefined;
  const lnAddress = winner?.lnAddress?.trim();
  const amountSats = netPayoutSats(room.postGame.winnerPoints);
  if (!lnAddress || amountSats <= 0) {
    archiveUnclaimedPrize(room, amountSats);
    return;
  }
  room.postGame.payoutLock = 'auto';
  room.postGame.claimPayoutPending = true;
  room.postGame.claimPayoutAttemptAt = now;
  claimPayoutQueue.push({
    roomId: room.roomId,
    lnAddress,
    amountSats,
    winnerSessionID: winner?.sessionID,
  });
  logOnlineState(`claim payout queued roomId=${room.roomId} amount=${amountSats} ln=${lnAddress}`);
}

function ensurePostGameState(room: OnlineRoom) {
  if (room.postGame.outcome === 'abandoned') {
    return;
  }
  const p1 = room.seats.get(PlayerRole.Player1);
  const p2 = room.seats.get(PlayerRole.Player2);
  const winnerRole =
    room.snapshot.state.winnerPlayer === 'P2' ? PlayerRole.Player2 : PlayerRole.Player1;
  const winnerSeat = winnerRole === PlayerRole.Player1 ? p1 : p2;
  const winnerPoints = winnerRole === PlayerRole.Player1 ? room.snapshot.state.score[0] : room.snapshot.state.score[1];
  room.postGame.p1Picture = p1?.picture;
  room.postGame.p2Picture = p2?.picture;
  room.postGame.winnerRole = winnerRole;
  room.postGame.winnerSessionID = winnerSeat?.sessionID;
  room.postGame.winnerName = winnerSeat?.name ?? room.snapshot.state.winnerName ?? 'Player 1';
  room.postGame.winnerPicture = winnerSeat?.picture;
  room.postGame.winnerPoints = winnerPoints;
  room.postGame.totalPrize = room.snapshot.state.totalPoints;
}

function resetRoomToLobby(room: OnlineRoom) {
  const p1 = room.seats.get(PlayerRole.Player1);
  const p2 = room.seats.get(PlayerRole.Player2);
  const p1Name = p1?.name ?? 'Player 1';
  const p2Name = p2?.name ?? 'Player 2';
  const p1Points = Math.max(1, Math.floor(p1?.paidAmount ?? room.buyin));
  const p2Points = Math.max(1, Math.floor(p2?.paidAmount ?? room.buyin));
  room.snapshot = {
    tick: 0,
    phase: 'lobby',
    state: createOnlineGameState({
      p1Name,
      p2Name,
      p1Points,
      p2Points,
    }),
    hud: {
      p1Points,
      p2Points,
      captureP1: '2%',
      captureP2: '2%',
      initialWidthP1: 50,
      initialWidthP2: 50,
      currentWidthP1: 50,
      currentWidthP2: 50,
    },
  };
  resetReplay(room);
  room.phase = 'lobby';
  room.inputBySession.clear();
  if (room.postGame.rematchEventId) {
    roomIdByKind1EventId.delete(room.postGame.rematchEventId);
  }
  room.postGame.doubleOrNothingVotes.clear();
  room.postGame.lnurlw = undefined;
  room.postGame.payoutMethod = undefined;
  room.postGame.payoutTarget = undefined;
  room.postGame.rematchRequested = false;
  room.postGame.rematchRequiredAmount = undefined;
  room.postGame.rematchEventId = undefined;
  room.postGame.rematchNote1 = undefined;
  room.postGame.rematchWaitingForSessionID = undefined;
  room.postGame.settledAt = undefined;
  room.postGame.winnerRole = undefined;
  room.postGame.winnerSessionID = undefined;
  room.postGame.p1Picture = undefined;
  room.postGame.p2Picture = undefined;
  room.postGame.winnerName = '';
  room.postGame.winnerPicture = undefined;
  room.postGame.winnerPoints = 0;
  room.postGame.totalPrize = 0;
  room.postGame.outcome = undefined;
  room.postGame.claimStartedAt = undefined;
  room.postGame.claimMs = undefined;
  room.postGame.payoutLock = undefined;
  room.postGame.claimPayoutPending = undefined;
  room.postGame.claimPayoutAttemptAt = undefined;
  simSteerAnchored.delete(room);
  for (const [role, seat] of room.seats.entries()) {
    if (seat.idleSince || seat.lastSteerAt) {
      room.seats.set(role, { ...seat, idleSince: undefined, lastSteerAt: undefined });
    }
  }
  noteActivity(room);
  logOnlineState(`double-or-nothing agreed; reset to lobby roomId=${room.roomId}`);
}

function maybeStartPaidMatch(room: OnlineRoom) {
  const p1 = room.seats.get(PlayerRole.Player1);
  const p2 = room.seats.get(PlayerRole.Player2);
  const bothPaid =
    p1?.status === 'paid' &&
    p2?.status === 'paid' &&
    !!p1.sessionID &&
    !!p2.sessionID &&
    room.members.has(p1.sessionID) &&
    room.members.has(p2.sessionID);
  if (!bothPaid) {
    const blockers: string[] = [];
    if (p1?.status !== 'paid' || p2?.status !== 'paid') {
      blockers.push('seats_not_paid');
    }
    if (!p1?.sessionID || !p2?.sessionID) {
      blockers.push('missing_session');
    }
    if (p1?.sessionID && !room.members.has(p1.sessionID)) {
      blockers.push('p1_not_in_room');
    }
    if (p2?.sessionID && !room.members.has(p2.sessionID)) {
      blockers.push('p2_not_in_room');
    }
    if (room.phase !== 'lobby') {
      blockers.push('not_lobby');
    }
    if (blockers.length > 0) {
      logOnlineState(
        `maybeStartPaidMatch blocked roomId=${room.roomId} reasons=${blockers.join(',')}`
      );
    }
    return false;
  }
  if (room.phase !== 'lobby') {
    return false;
  }
  setRoomPhase(room.roomId, 'playing');
  return true;
}

function maybeStartOnlineCountdown(room: OnlineRoom): boolean {
  const p1 = room.seats.get(PlayerRole.Player1);
  const p2 = room.seats.get(PlayerRole.Player2);
  const state = room.snapshot.state;
  if (state.gameStarted || state.countdownStart) {
    return Boolean(state.countdownStart || state.gameStarted);
  }
  if (
    p1?.status === 'paid' &&
    p2?.status === 'paid' &&
    p1.startConfirmed &&
    p2.startConfirmed
  ) {
    startOnlineCountdown(state);
    pushReplayFrame(room);
    return true;
  }
  return false;
}

function shouldRecordOnlineReplay(state: OnlineRoom['snapshot']['state']): boolean {
  return state.countdownStart || state.gameStarted;
}

function cloneSnapshot(snapshot: OnlineRoom['snapshot']): OnlineRoom['snapshot'] {
  return JSON.parse(JSON.stringify(snapshot)) as OnlineRoom['snapshot'];
}

function resetReplay(room: OnlineRoom) {
  room.replay.frames = [];
  room.replay.recordedAt = undefined;
  room.replay.blockEvents = undefined;
}

function pushReplayFrame(room: OnlineRoom) {
  room.replay.frames.push(cloneSnapshot(room.snapshot));
  if (room.replay.frames.length > ONLINE_REPLAY_MAX_FRAMES) {
    room.replay.frames.splice(0, room.replay.frames.length - ONLINE_REPLAY_MAX_FRAMES);
  }
}
