/**
 * Persists ONLINE matches: one file per match (`roomId-rN.json`) when a sim ends,
 * and `roomId-session.json` when the room is deleted after the winner closes payout.
 */
import path from 'path';
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import { PlayerRole } from '../types/game';
import type { OnlineMatchRoundSummary, OnlineRoomListItem } from '../types/online';
import {
  COMPACT_REPLAY_FORMAT,
  replayFrameCount,
  type OnlineReplayWirePayload,
  type PackedReplay,
} from './onlineReplayCompact';

const INDEX_FILE = 'index.jsonl';

export type ArchiveKind = 'match' | 'session';

export interface OnlineRoomArchiveFile {
  version: 1;
  kind: ArchiveKind;
  roomId: string;
  /** Present for kind === 'match' */
  matchRound?: number;
  /** Unique key for index rows */
  archiveId: string;
  finishedAt: number;
  serializedRoom: Record<string, unknown>;
  /** compact-v2 gzip blob (see `onlineReplayCompact.ts`). */
  replay: PackedReplay;
}

export interface OnlineArchivedListItem {
  archiveId?: string;
  roomId: string;
  roomCode: string;
  buyin: number;
  createdAt: number;
  finishedAt: number;
  phase: 'postgame' | 'finished';
  archiveKind: ArchiveKind;
  matchRound?: number;
  playersPaid: number;
  seatsTotal: number;
  spectators: number;
  archived: true;
  replay?: {
    available: boolean;
    frameCount: number;
    tickMs: number;
    durationMs: number;
  };
  result?: {
    winnerName: string;
    p1Name: string;
    p2Name: string;
    p1Score: number;
    p2Score: number;
    netPrize: number;
    p1Picture?: string;
    p2Picture?: string;
    winnerPicture?: string;
    winnerRole?: PlayerRole.Player1 | PlayerRole.Player2;
    outcome?: 'forfeit' | 'abandoned';
    p1Paid?: number;
    p2Paid?: number;
  };
}

/**
 * History list reads `result` from index.jsonl only. Merge in avatars/names from the same
 * `serializedRoom` wire object used in lobby/game (`seats`, `postGame`) so URLs are not lost
 * when `result` was serialized without optional picture fields.
 */
function resultForArchiveIndex(serializedRoom: Record<string, unknown>): OnlineArchivedListItem['result'] | undefined {
  const base = serializedRoom.result as OnlineArchivedListItem['result'] | undefined;
  if (!base) {
    return undefined;
  }
  const seats = serializedRoom.seats as Record<string, { picture?: string; name?: string }> | undefined;
  const postGame = serializedRoom.postGame as
    | {
        p1Picture?: string;
        p2Picture?: string;
        winnerPicture?: string;
        winnerName?: string;
        winnerRole?: PlayerRole.Player1 | PlayerRole.Player2;
      }
    | undefined;

  const p1Seat = seats?.[PlayerRole.Player1];
  const p2Seat = seats?.[PlayerRole.Player2];

  return {
    ...base,
    p1Name: base.p1Name || p1Seat?.name || 'Player 1',
    p2Name: base.p2Name || p2Seat?.name || 'Player 2',
    p1Picture: base.p1Picture ?? p1Seat?.picture ?? postGame?.p1Picture,
    p2Picture: base.p2Picture ?? p2Seat?.picture ?? postGame?.p2Picture,
    winnerPicture: base.winnerPicture ?? postGame?.winnerPicture,
    winnerRole: base.winnerRole ?? postGame?.winnerRole,
    winnerName: base.winnerName || postGame?.winnerName || 'Winner',
  };
}

/** Map index row → list item (shared with merged history). */
export function archivedRowToOnlineRoomListItem(
  r: OnlineArchivedListItem
): OnlineRoomListItem {
  return {
    roomId: r.roomId,
    roomCode: r.roomCode,
    buyin: r.buyin,
    createdAt: r.createdAt,
    finishedAt: r.finishedAt,
    phase: r.phase ?? 'finished',
    playersPaid: r.playersPaid,
    seatsTotal: r.seatsTotal,
    spectators: r.spectators,
    archived: true,
    matchRound: r.matchRound,
    archiveKind: r.archiveKind ?? 'session',
    replay: r.replay,
    result: r.result,
  };
}

function archiveDir(): string {
  return path.join(process.cwd(), 'data', 'online_archive');
}

async function ensureDir(): Promise<void> {
  await fsPromises.mkdir(archiveDir(), { recursive: true });
}

function matchFileName(roomId: string, matchRound: number): string {
  return `${roomId}-r${matchRound}.json`;
}

function sessionFileName(roomId: string): string {
  return `${roomId}-session.json`;
}

/** Legacy single-file archive from older builds. */
function legacyRoomFileName(roomId: string): string {
  return `${roomId}.json`;
}

/** When a match sim ends (postgame): persist replay before DoN may reset buffers. */
export async function appendOnlineMatchArchive(payload: OnlineRoomArchiveFile): Promise<void> {
  if (payload.kind !== 'match' || payload.matchRound == null) {
    console.error('[online_archive] appendOnlineMatchArchive: expected kind=match + matchRound');
    return;
  }
  try {
    await ensureDir();
    const filePath = path.join(archiveDir(), matchFileName(payload.roomId, payload.matchRound));
    await fsPromises.writeFile(filePath, JSON.stringify(payload), 'utf8');

    const sr = payload.serializedRoom as {
      roomCode?: string;
      buyin?: number;
      createdAt?: number;
      replay?: { frameCount?: number; tickMs?: number; durationMs?: number };
    };
    const indexLine: OnlineArchivedListItem = {
      archiveId: payload.archiveId,
      roomId: payload.roomId,
      roomCode: sr.roomCode ?? payload.roomId,
      buyin: sr.buyin ?? 0,
      createdAt: sr.createdAt ?? payload.finishedAt,
      finishedAt: payload.finishedAt,
      /** Index row is a completed match for history UI; use `finished` (not live `postgame`). */
      phase: 'finished',
      archiveKind: 'match',
      matchRound: payload.matchRound,
      playersPaid: 2,
      seatsTotal: 2,
      spectators: 0,
      archived: true,
      replay: sr.replay
        ? {
            available: (sr.replay.frameCount ?? 0) > 0,
            frameCount: sr.replay.frameCount ?? replayFrameCount(payload.replay),
            tickMs: sr.replay.tickMs ?? payload.replay.tickMs,
            durationMs:
              sr.replay.durationMs ??
              replayFrameCount(payload.replay) * payload.replay.tickMs,
          }
        : undefined,
      result: resultForArchiveIndex(payload.serializedRoom as Record<string, unknown>),
    };
    const indexPath = path.join(archiveDir(), INDEX_FILE);
    await fsPromises.appendFile(indexPath, JSON.stringify(indexLine) + '\n', 'utf8');
    console.log(
      `[online_archive] match ${payload.archiveId} (${replayFrameCount(payload.replay)} frames)`
    );
  } catch (e) {
    console.error('[online_archive] append match failed', e);
  }
}

/** When room is deleted after winner closed payout (phase finished). */
export async function appendOnlineRoomArchive(payload: {
  version: 1;
  kind: 'session';
  roomId: string;
  archiveId: string;
  finishedAt: number;
  serializedRoom: Record<string, unknown>;
  replay: PackedReplay;
}): Promise<void> {
  try {
    await ensureDir();
    const filePath = path.join(archiveDir(), sessionFileName(payload.roomId));
    const full: OnlineRoomArchiveFile = {
      version: 1,
      kind: 'session',
      roomId: payload.roomId,
      archiveId: payload.archiveId,
      finishedAt: payload.finishedAt,
      serializedRoom: payload.serializedRoom,
      replay: payload.replay,
    };
    await fsPromises.writeFile(filePath, JSON.stringify(full), 'utf8');

    const sr = payload.serializedRoom as {
      roomCode?: string;
      buyin?: number;
      createdAt?: number;
      replay?: { frameCount?: number; tickMs?: number; durationMs?: number };
    };
    const indexLine: OnlineArchivedListItem = {
      archiveId: payload.archiveId,
      roomId: payload.roomId,
      roomCode: sr.roomCode ?? payload.roomId,
      buyin: sr.buyin ?? 0,
      createdAt: sr.createdAt ?? payload.finishedAt,
      finishedAt: payload.finishedAt,
      phase: 'finished',
      archiveKind: 'session',
      playersPaid: 2,
      seatsTotal: 2,
      spectators: 0,
      archived: true,
      replay: sr.replay
        ? {
            available: (sr.replay.frameCount ?? 0) > 0,
            frameCount: sr.replay.frameCount ?? replayFrameCount(payload.replay),
            tickMs: sr.replay.tickMs ?? payload.replay.tickMs,
            durationMs:
              sr.replay.durationMs ??
              replayFrameCount(payload.replay) * payload.replay.tickMs,
          }
        : undefined,
      result: resultForArchiveIndex(payload.serializedRoom as Record<string, unknown>),
    };
    const indexPath = path.join(archiveDir(), INDEX_FILE);
    await fsPromises.appendFile(
      indexPath,
      JSON.stringify(indexLine) + '\n',
      'utf8'
    );
    console.log(
      `[online_archive] session ${payload.archiveId} (${replayFrameCount(payload.replay)} frames)`
    );
  } catch (e) {
    console.error('[online_archive] append session failed', e);
  }
}

function isValidCompactReplay(replay: unknown): replay is PackedReplay {
  if (!replay || typeof replay !== 'object') {
    return false;
  }
  const r = replay as Record<string, unknown>;
  if (r.format !== COMPACT_REPLAY_FORMAT) {
    return false;
  }
  if (typeof r.tickMs !== 'number') {
    return false;
  }
  if (typeof r.gzipBase64 !== 'string' || typeof r.frameCount !== 'number') {
    return false;
  }
  if (r.blockEvents !== undefined) {
    if (!Array.isArray(r.blockEvents)) {
      return false;
    }
    for (const ev of r.blockEvents) {
      if (
        !ev ||
        typeof ev !== 'object' ||
        typeof (ev as { frameIndex?: unknown }).frameIndex !== 'number' ||
        typeof (ev as { blockHeight?: unknown }).blockHeight !== 'number' ||
        typeof (ev as { medianFeeSatPerVb?: unknown }).medianFeeSatPerVb !== 'number'
      ) {
        return false;
      }
    }
  }
  return true;
}

function readArchiveJsonFile(filePath: string): OnlineRoomArchiveFile | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as OnlineRoomArchiveFile;
    if (parsed.version !== 1 || !parsed.replay || !isValidCompactReplay(parsed.replay)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function readArchiveFileAny(filePath: string): OnlineRoomArchiveFile | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as OnlineRoomArchiveFile;
    if (parsed.version !== 1 || !parsed.serializedRoom) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function loadCompactWireFromArchiveRecord(
  m: OnlineRoomArchiveFile | null
): OnlineReplayWirePayload | undefined {
  if (!m?.replay || !isValidCompactReplay(m.replay)) {
    return undefined;
  }
  const r = m.replay;
  return {
    roomId: m.roomId,
    tickMs: r.tickMs,
    format: r.format,
    gzipBase64: r.gzipBase64,
    frameCount: r.frameCount,
    matchRound: m.matchRound,
    ...(Array.isArray(r.blockEvents) && r.blockEvents.length > 0 ? { blockEvents: r.blockEvents } : {}),
  };
}

/** Compact replay blob from disk (same shape as `getOnlineReplay` when room is archived). */
export function loadCompactReplayFromArchiveSync(
  roomId: string,
  matchRound?: number
): OnlineReplayWirePayload | undefined {
  if (matchRound != null) {
    return loadCompactWireFromArchiveRecord(
      readArchiveJsonFile(path.join(archiveDir(), matchFileName(roomId, matchRound)))
    );
  }

  const tryRecord = (
    record: OnlineRoomArchiveFile | null
  ): OnlineReplayWirePayload | undefined => {
    const wire = loadCompactWireFromArchiveRecord(record);
    if (wire && wire.frameCount > 0) {
      return wire;
    }
    return undefined;
  };

  const fromSession = tryRecord(
    readArchiveJsonFile(path.join(archiveDir(), sessionFileName(roomId)))
  );
  if (fromSession) {
    return fromSession;
  }

  const fromLegacy = tryRecord(
    readArchiveJsonFile(path.join(archiveDir(), legacyRoomFileName(roomId)))
  );
  if (fromLegacy) {
    return fromLegacy;
  }

  /** Postgame per-match archives exist before withdrawal creates `session.json`. */
  const latestRound = findLatestArchivedMatchRoundSync(roomId);
  if (latestRound != null && latestRound >= 1) {
    return tryRecord(
      readArchiveJsonFile(path.join(archiveDir(), matchFileName(roomId, latestRound)))
    );
  }

  return undefined;
}

function tryLoadSerializedFromFile(filePath: string): Record<string, unknown> | undefined {
  const parsed = readArchiveFileAny(filePath);
  if (!parsed?.serializedRoom) {
    return undefined;
  }
  return parsed.serializedRoom as Record<string, unknown>;
}

/**
 * `matchRound` from `roomId-session.json` (set when the room was deleted after payout).
 * Use with index rows so replay targets the **last** game when the index is incomplete.
 */
export function readSessionMatchRoundFromArchiveSync(roomId: string): number | undefined {
  const sr = tryLoadSerializedFromFile(path.join(archiveDir(), sessionFileName(roomId)));
  if (!sr) {
    return undefined;
  }
  const mr = sr.matchRound;
  if (typeof mr === 'number' && Number.isFinite(mr) && mr >= 1) {
    return Math.floor(mr);
  }
  return undefined;
}

type SeatWire = { picture?: string; name?: string; [key: string]: unknown };

/** Fill missing seat name/picture on `primary` from `fallback` (e.g. session vs per-match archive). */
function mergeSerializedSeatPortraits(
  primary: Record<string, unknown>,
  fallback?: Record<string, unknown>
): Record<string, unknown> {
  if (!fallback) {
    return primary;
  }
  const pSeats = primary.seats as Record<string, SeatWire> | undefined;
  const fSeats = fallback.seats as Record<string, SeatWire> | undefined;
  if (!pSeats || !fSeats) {
    return primary;
  }
  const roles = [PlayerRole.Player1, PlayerRole.Player2] as const;
  const nextSeats: Record<string, SeatWire> = { ...pSeats };
  for (const role of roles) {
    const ps = pSeats[role];
    const fs = fSeats[role];
    if (!fs) {
      continue;
    }
    nextSeats[role] = {
      ...(ps ?? {}),
      picture: ps?.picture || fs.picture,
      name: ps?.name || fs.name,
    };
  }
  return { ...primary, seats: nextSeats };
}

/**
 * Load wire room for clients (lobby UI / replay header). Optional `matchRound` loads the per-match
 * archive (`roomId-rN.json`) so replay viewers get seats/avatars for that game, not only session.json.
 */
export function loadSerializedRoomFromArchiveSync(
  roomId: string,
  matchRound?: number
): Record<string, unknown> | undefined {
  const sessionPath = path.join(archiveDir(), sessionFileName(roomId));
  const legacyPath = path.join(archiveDir(), legacyRoomFileName(roomId));
  const session = tryLoadSerializedFromFile(sessionPath);
  const legacy = tryLoadSerializedFromFile(legacyPath);
  const sessionOrLegacy = session ?? legacy;

  if (matchRound != null && matchRound >= 1) {
    const fromMatch = tryLoadSerializedFromFile(path.join(archiveDir(), matchFileName(roomId, matchRound)));
    if (fromMatch) {
      return mergeSerializedSeatPortraits(fromMatch, sessionOrLegacy);
    }
  }

  if (session) {
    return session;
  }
  if (legacy) {
    return legacy;
  }

  const latestRound = findLatestArchivedMatchRoundSync(roomId);
  if (latestRound != null && latestRound >= 1) {
    const fromLatestMatch = tryLoadSerializedFromFile(
      path.join(archiveDir(), matchFileName(roomId, latestRound))
    );
    if (fromLatestMatch) {
      return fromLatestMatch;
    }
  }
  return undefined;
}

export function findLatestArchivedMatchRoundSync(roomId: string): number | undefined {
  const fromIndex = listArchivedMatchRoundsForRoomSync(roomId);
  const indexMax =
    fromIndex.length > 0 ? fromIndex[fromIndex.length - 1].matchRound : 0;

  const dir = archiveDir();
  let diskMax = 0;
  if (fs.existsSync(dir)) {
    const prefix = `${roomId}-r`;
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(prefix) || !name.endsWith('.json')) {
        continue;
      }
      const round = Number(name.slice(prefix.length, -'.json'.length));
      if (Number.isFinite(round) && round > diskMax) {
        diskMax = round;
      }
    }
  }

  const latest = Math.max(indexMax, diskMax);
  return latest >= 1 ? latest : undefined;
}

/**
 * All completed match rows for a room from `index.jsonl` (per-round archives from DoN sessions).
 */
export function listArchivedMatchRoundsForRoomSync(roomId: string): OnlineMatchRoundSummary[] {
  const indexPath = path.join(archiveDir(), INDEX_FILE);
  if (!fs.existsSync(indexPath)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(indexPath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const byRound = new Map<number, OnlineArchivedListItem>();
    for (const line of lines) {
      try {
        const row = JSON.parse(line) as OnlineArchivedListItem;
        if (row.roomId !== roomId || row.archived !== true) {
          continue;
        }
        if (row.archiveKind === 'session') {
          continue;
        }
        const round = row.matchRound;
        if (round == null || round < 1) {
          continue;
        }
        const prev = byRound.get(round);
        if (!prev || row.finishedAt >= prev.finishedAt) {
          byRound.set(round, row);
        }
      } catch {
        /* skip line */
      }
    }
    const sorted = [...byRound.entries()].sort((a, b) => a[0] - b[0]);
    return sorted.map(([matchRound, item]) => ({
      matchRound,
      finishedAt: item.finishedAt,
      winnerName: item.result?.winnerName ?? '—',
      p1Name: item.result?.p1Name ?? 'Player 1',
      p2Name: item.result?.p2Name ?? 'Player 2',
      p1Score: item.result?.p1Score ?? 0,
      p2Score: item.result?.p2Score ?? 0,
      netPrize: item.result?.netPrize ?? 0,
      winnerRole: item.result?.winnerRole,
      replayAvailable: (item.replay?.frameCount ?? 0) > 0,
    }));
  } catch {
    return [];
  }
}

const MAX_LIST = 400;

export function listArchivedOnlineRoomsSync(): OnlineArchivedListItem[] {
  const indexPath = path.join(archiveDir(), INDEX_FILE);
  if (!fs.existsSync(indexPath)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(indexPath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const byKey = new Map<string, OnlineArchivedListItem>();
    for (const line of lines) {
      try {
        const row = JSON.parse(line) as OnlineArchivedListItem & { archiveId?: string };
        if (!row.roomId || !row.archived) {
          continue;
        }
        const key =
          row.archiveId ??
          `${row.roomId}-${row.archiveKind ?? 'legacy'}-${row.matchRound ?? ''}-${row.finishedAt}`;
        const prev = byKey.get(key);
        if (!prev || row.finishedAt >= prev.finishedAt) {
          byKey.set(key, {
            ...row,
            archiveId: row.archiveId ?? key,
            archiveKind: row.archiveKind ?? (row.matchRound != null ? 'match' : 'session'),
            phase: row.phase ?? 'finished',
          });
        }
      } catch {
        /* skip */
      }
    }
    const items = [...byKey.values()];
    items.sort((a, b) => b.finishedAt - a.finishedAt);
    return items.slice(0, MAX_LIST);
  } catch {
    return [];
  }
}

type ArchivedSeat = {
  name?: string;
  picture?: string;
  sessionID?: string;
  socketID?: string;
  lnAddress?: string;
};

function postGameInfoFromSerializedRoom(
  serialized: Record<string, unknown>
):
  | {
      roomId: string;
      phase: 'finished';
      p1Name: string;
      p2Name: string;
      p1Picture?: string;
      p2Picture?: string;
      p1SessionID?: string;
      p2SessionID?: string;
      p1SocketID?: string;
      p2SocketID?: string;
      p1Points: number;
      p2Points: number;
      winnerRole?: PlayerRole.Player1 | PlayerRole.Player2;
      winnerSessionID?: string;
      winnerName: string;
      winnerPicture?: string;
      winnerPoints: number;
      totalPrize: number;
      lnurlw?: string;
      payoutMethod?: 'withdraw_qr' | 'nostr_zap';
      payoutTarget?: string;
      rematchRequested?: boolean;
      rematchRequiredAmount?: number;
      rematchEventId?: string;
      rematchNote1?: string;
      rematchWaitingForSessionID?: string;
      winnerLnAddress?: string;
      doubleOrNothingVotes: number;
    }
  | undefined {
  const sr = serialized as {
    roomId: string;
    phase?: string;
    seats?: Record<string, ArchivedSeat>;
    snapshot?: { state?: { score?: number[] } };
    postGame?: {
      p1Picture?: string;
      p2Picture?: string;
      winnerRole?: PlayerRole.Player1 | PlayerRole.Player2;
      winnerSessionID?: string;
      winnerName: string;
      winnerPicture?: string;
      winnerPoints: number;
      totalPrize: number;
      lnurlw?: string;
      payoutMethod?: 'withdraw_qr' | 'nostr_zap';
      payoutTarget?: string;
      rematchRequested?: boolean;
      rematchRequiredAmount?: number;
      rematchEventId?: string;
      rematchNote1?: string;
      rematchWaitingForSessionID?: string;
      doubleOrNothingVotes?: number;
    };
    result?: {
      winnerName?: string;
      p1Name?: string;
      p2Name?: string;
      p1Score?: number;
      p2Score?: number;
      netPrize?: number;
      winnerRole?: PlayerRole.Player1 | PlayerRole.Player2;
      p1Picture?: string;
      p2Picture?: string;
      winnerPicture?: string;
    };
  };
  if (sr.phase !== 'finished' && sr.phase !== 'postgame') {
    return undefined;
  }

  const seats = sr.seats ?? {};
  const p1 = seats[PlayerRole.Player1];
  const p2 = seats[PlayerRole.Player2];
  const score = sr.snapshot?.state?.score;
  const pg = sr.postGame;
  const result = sr.result;

  if (!pg && !result) {
    return undefined;
  }

  const p1Points = score?.[0] ?? result?.p1Score ?? 0;
  const p2Points = score?.[1] ?? result?.p2Score ?? 0;
  const winnerName = pg?.winnerName ?? result?.winnerName ?? 'Winner';
  const winnerPoints =
    pg?.winnerPoints ??
    Math.max(p1Points, p2Points, result?.netPrize ?? 0);
  const totalPrize = pg?.totalPrize ?? p1Points + p2Points;

  return {
    roomId: sr.roomId,
    phase: 'finished',
    p1Name: p1?.name ?? result?.p1Name ?? 'Player 1',
    p2Name: p2?.name ?? result?.p2Name ?? 'Player 2',
    p1Picture: p1?.picture ?? pg?.p1Picture ?? result?.p1Picture,
    p2Picture: p2?.picture ?? pg?.p2Picture ?? result?.p2Picture,
    p1SessionID: p1?.sessionID,
    p2SessionID: p2?.sessionID,
    p1SocketID: p1?.socketID,
    p2SocketID: p2?.socketID,
    p1Points,
    p2Points,
    winnerRole: pg?.winnerRole ?? result?.winnerRole,
    winnerSessionID: pg?.winnerSessionID,
    winnerName,
    winnerPicture: pg?.winnerPicture ?? result?.winnerPicture,
    winnerPoints,
    totalPrize,
    lnurlw: pg?.lnurlw,
    payoutMethod: pg?.payoutMethod,
    payoutTarget: pg?.payoutTarget,
    rematchRequested: pg?.rematchRequested,
    rematchRequiredAmount: pg?.rematchRequiredAmount,
    rematchEventId: pg?.rematchEventId,
    rematchNote1: pg?.rematchNote1,
    rematchWaitingForSessionID: pg?.rematchWaitingForSessionID,
    winnerLnAddress:
      pg?.winnerRole != null ? seats[pg.winnerRole]?.lnAddress : undefined,
    doubleOrNothingVotes: pg?.doubleOrNothingVotes ?? 0,
  };
}

export function getOnlinePostGameFromArchive(roomId: string) {
  const serialized = loadSerializedRoomFromArchiveSync(roomId);
  if (!serialized) {
    return undefined;
  }
  return postGameInfoFromSerializedRoom(serialized);
}

/** Resolve a finished/archived room by human code (live rooms are not included). */
function archivedIndexRowsMatchingPublicCode(
  code: string
): OnlineArchivedListItem[] {
  const all = listArchivedOnlineRoomsSync();
  const direct = all.filter((row) => row.roomCode.trim().toUpperCase() === code);
  if (direct.length > 0) {
    return direct;
  }
  /** Index rows may use `roomId` as `roomCode` when older archives omitted `serializedRoom.roomCode`. */
  const seenRoomIds = new Set<string>();
  const matched: OnlineArchivedListItem[] = [];
  for (const row of all) {
    if (seenRoomIds.has(row.roomId)) {
      continue;
    }
    seenRoomIds.add(row.roomId);
    const serialized = loadSerializedRoomFromArchiveSync(row.roomId);
    const wire =
      typeof serialized?.roomCode === 'string'
        ? serialized.roomCode.trim().toUpperCase()
        : '';
    if (wire !== code) {
      continue;
    }
    const rowsForRoom = all.filter((r) => r.roomId === row.roomId);
    rowsForRoom.sort((a, b) => b.finishedAt - a.finishedAt);
    const best = rowsForRoom[0];
    if (best) {
      matched.push(best);
    }
  }
  return matched;
}

export function resolveArchivedRoomByCodeSync(roomCode: string):
  | {
      roomId: string;
      roomCode: string;
      serialized: Record<string, unknown>;
    }
  | undefined {
  const code = roomCode.trim().toUpperCase();
  if (!code) {
    return undefined;
  }
  const matches = archivedIndexRowsMatchingPublicCode(code);
  if (matches.length === 0) {
    return undefined;
  }
  matches.sort((a, b) => b.finishedAt - a.finishedAt);
  const best = matches[0];
  const roomId = best.roomId;
  let serialized =
    best.matchRound != null && best.matchRound >= 1
      ? loadSerializedRoomFromArchiveSync(roomId, best.matchRound)
      : undefined;
  if (!serialized) {
    serialized = loadSerializedRoomFromArchiveSync(roomId);
  }
  if (!serialized) {
    return undefined;
  }
  const wireCode =
    typeof serialized.roomCode === 'string'
      ? serialized.roomCode.trim().toUpperCase()
      : best.roomCode.trim().toUpperCase();
  const phase = serialized.phase;
  if (phase !== 'postgame' && phase !== 'finished') {
    return undefined;
  }
  return { roomId, roomCode: wireCode, serialized };
}

/** Resolve archived room by id (optional match round from history list). */
export function resolveArchivedRoomByIdSync(
  roomId: string,
  matchRound?: number
):
  | {
      roomId: string;
      roomCode: string;
      serialized: Record<string, unknown>;
    }
  | undefined {
  let serialized =
    matchRound != null && matchRound >= 1
      ? loadSerializedRoomFromArchiveSync(roomId, matchRound)
      : undefined;
  if (!serialized) {
    serialized = loadSerializedRoomFromArchiveSync(roomId);
  }
  if (!serialized) {
    return undefined;
  }
  const phase = serialized.phase;
  if (phase !== 'postgame' && phase !== 'finished') {
    return undefined;
  }
  const wireCode =
    typeof serialized.roomCode === 'string'
      ? serialized.roomCode.trim().toUpperCase()
      : roomId;
  return { roomId, roomCode: wireCode, serialized };
}
