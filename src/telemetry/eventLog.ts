import fs from 'fs';
import path from 'path';
import { promises as fsPromises } from 'fs';
import type { TrackOutcome } from './trackEvent';

export type StoredTrackEvent = {
  type: 'track';
  ts: string;
  event: string;
  outcome: TrackOutcome;
  reason?: string;
  sessionID?: string;
  pubkeyPrefix?: string;
  challengeId?: string;
  runId?: string;
  roomId?: string;
  roomCode?: string;
  buyin?: number;
  amountSats?: number;
  replayMs?: number;
  source?: 'server' | 'client';
  meta?: Record<string, string | number | boolean>;
};

const EVENTS_FILE = 'events.jsonl';
const ROTATE_BYTES = 50 * 1024 * 1024;
const PERSIST_DEBOUNCE_MS = 500;
const SCAN_CAP = 10_000;
const RECENT_CAP = 200;
const TAIL_CHUNK_BYTES = 256 * 1024;

/**
 * Newest events kept in memory. Dashboard reads use this instead of
 * `events.jsonl`, so a poll cannot stall the game loop on a full-file read.
 * Same window scanEvents already walked (the last SCAN_CAP lines).
 */
const tailBuffer: StoredTrackEvent[] = [];
const pendingLines: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let tailHydrated = false;
let tailHydration: Promise<void> | null = null;

function telemetryDir(): string {
  return path.join(process.cwd(), 'data', 'telemetry');
}

function eventsFilePath(): string {
  return path.join(telemetryDir(), EVENTS_FILE);
}

function ensureDirSync(): void {
  fs.mkdirSync(telemetryDir(), { recursive: true });
}

function maybeRotateEventsFile(): void {
  const filePath = eventsFilePath();
  if (!fs.existsSync(filePath)) return;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < ROTATE_BYTES) return;
    const rotated = `${filePath}.1`;
    if (fs.existsSync(rotated)) {
      fs.unlinkSync(rotated);
    }
    fs.renameSync(filePath, rotated);
  } catch (e) {
    console.error('[telemetry] events.jsonl rotate failed', e);
  }
}

async function flushPendingLines(): Promise<void> {
  flushTimer = null;
  if (pendingLines.length === 0) return;
  const batch = pendingLines.splice(0, pendingLines.length);
  try {
    ensureDirSync();
    maybeRotateEventsFile();
    await fsPromises.appendFile(eventsFilePath(), batch.join(''), 'utf8');
  } catch (e) {
    console.error('[telemetry] events.jsonl append failed', e);
  }
}

function eventKey(event: StoredTrackEvent): string {
  return event.ts + event.event + (event.sessionID ?? '');
}

function pushTail(event: StoredTrackEvent): void {
  tailBuffer.push(event);
  if (tailBuffer.length > SCAN_CAP) {
    tailBuffer.splice(0, tailBuffer.length - SCAN_CAP);
  }
}

export function recordTrackEvent(event: StoredTrackEvent): void {
  pushTail(event);
  pendingLines.push(JSON.stringify(event) + '\n');
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      void flushPendingLines();
    }, PERSIST_DEBOUNCE_MS);
  }
}

export function getEventLogByteSize(): number {
  const filePath = eventsFilePath();
  if (!fs.existsSync(filePath)) return 0;
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function parseEventLine(line: string): StoredTrackEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const row = JSON.parse(trimmed) as StoredTrackEvent;
    if (row.type !== 'track' || typeof row.event !== 'string' || typeof row.ts !== 'string') {
      return null;
    }
    return row;
  } catch {
    return null;
  }
}

function matchesFilter(
  event: StoredTrackEvent,
  filters?: {
    eventPrefix?: string;
    outcome?: TrackOutcome;
    sinceTs?: string;
    sessionID?: string;
    pubkeyPrefix?: string;
    roomCode?: string;
  }
): boolean {
  if (filters?.eventPrefix && !event.event.startsWith(filters.eventPrefix.replace(/\*$/, ''))) {
    return false;
  }
  if (filters?.outcome && event.outcome !== filters.outcome) {
    return false;
  }
  if (filters?.sinceTs && event.ts < filters.sinceTs) {
    return false;
  }
  return true;
}

export function getRecentEvents(
  limit: number,
  filters?: {
    eventPrefix?: string;
    outcome?: TrackOutcome;
    sinceTs?: string;
    sessionID?: string;
    pubkeyPrefix?: string;
    roomCode?: string;
  }
): StoredTrackEvent[] {
  ensureTailHydrating();
  const capped = Math.min(Math.max(limit, 1), RECENT_CAP);
  return tailBuffer.filter((e) => extendedMatchesFilter(e, filters)).slice(-capped);
}

function extendedMatchesFilter(
  event: StoredTrackEvent,
  filters?: {
    eventPrefix?: string;
    outcome?: TrackOutcome;
    sinceTs?: string;
    sessionID?: string;
    pubkeyPrefix?: string;
    roomCode?: string;
  }
): boolean {
  if (!matchesFilter(event, filters)) return false;
  if (filters?.sessionID && event.sessionID !== filters.sessionID) return false;
  if (filters?.pubkeyPrefix && event.pubkeyPrefix !== filters.pubkeyPrefix) return false;
  if (filters?.roomCode && event.roomCode !== filters.roomCode) return false;
  return true;
}

/** Newest matching events from the in-memory tail. Does not read the log file. */
export function scanEvents(
  limit: number,
  filters?: {
    eventPrefix?: string;
    outcome?: TrackOutcome;
    sinceTs?: string;
    sessionID?: string;
    pubkeyPrefix?: string;
    roomCode?: string;
    events?: string[];
  }
): StoredTrackEvent[] {
  ensureTailHydrating();
  const capped = Math.min(Math.max(limit, 1), SCAN_CAP);
  const eventSet = filters?.events ? new Set(filters.events) : undefined;
  return tailBuffer
    .filter((e) => {
      if (!extendedMatchesFilter(e, filters)) return false;
      if (eventSet && !eventSet.has(e.event)) return false;
      return true;
    })
    .slice(-capped);
}

export function countEventsSince(
  sinceTs: string,
  filters?: { event?: string; outcome?: TrackOutcome }
): number {
  return scanEvents(SCAN_CAP, {
    sinceTs,
    eventPrefix: filters?.event,
    outcome: filters?.outcome,
  }).length;
}

export function getLastEventForSession(sessionID: string): StoredTrackEvent | undefined {
  ensureTailHydrating();
  for (let i = tailBuffer.length - 1; i >= 0; i--) {
    if (tailBuffer[i]?.sessionID === sessionID) return tailBuffer[i];
  }
  return undefined;
}

export function getEventsForSession(sessionID: string, limit: number): StoredTrackEvent[] {
  ensureTailHydrating();
  const capped = Math.min(Math.max(limit, 1), RECENT_CAP);
  return tailBuffer.filter((e) => e.sessionID === sessionID).slice(-capped);
}

export function isEventLogReady(): boolean {
  return tailHydrated;
}

/** Load the log tail once. Resolves immediately when the tail is already in memory. */
export function warmEventLog(): Promise<void> {
  if (tailHydrated) return Promise.resolve();
  if (!tailHydration) {
    tailHydration = hydrateTailFromDisk()
      .catch((err) => {
        console.error('[telemetry] events.jsonl tail load failed', err);
      })
      .finally(() => {
        tailHydration = null;
      });
  }
  return tailHydration;
}

function ensureTailHydrating(): void {
  if (!tailHydrated) void warmEventLog();
}

/** Read the end of the file until `maxLines` newlines, without loading the rest. */
async function readLastLines(filePath: string, maxLines: number): Promise<string[]> {
  const fh = await fsPromises.open(filePath, 'r');
  try {
    const stat = await fh.stat();
    if (stat.size === 0) return [];
    let pos = stat.size;
    const parts: Buffer[] = [];
    let newlines = 0;
    while (pos > 0 && newlines <= maxLines) {
      const size = Math.min(TAIL_CHUNK_BYTES, pos);
      pos -= size;
      const buf = Buffer.allocUnsafe(size);
      const { bytesRead } = await fh.read(buf, 0, size, pos);
      const slice = bytesRead === size ? buf : buf.subarray(0, bytesRead);
      parts.unshift(slice);
      for (let i = 0; i < slice.length; i++) {
        if (slice[i] === 10) newlines++;
      }
    }
    const lines = Buffer.concat(parts)
      .toString('utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0);
    if (pos > 0 && lines.length > 0) lines.shift();
    return lines.slice(-maxLines);
  } finally {
    await fh.close();
  }
}

async function hydrateTailFromDisk(): Promise<void> {
  const filePath = eventsFilePath();
  let lines: string[] = [];
  try {
    lines = await readLastLines(filePath, SCAN_CAP);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err;
  }

  const parsed: StoredTrackEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    const row = parseEventLine(lines[i] ?? '');
    if (row) parsed.push(row);
    if ((i + 1) % 2000 === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  const loadedKeys = new Set(parsed.map(eventKey));
  const arrived = tailBuffer.filter((e) => !loadedKeys.has(eventKey(e)));
  tailBuffer.length = 0;
  for (const event of parsed) pushTail(event);
  for (const event of arrived) pushTail(event);
  tailHydrated = true;
}

void warmEventLog();
