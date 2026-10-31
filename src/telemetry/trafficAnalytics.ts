import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Socket } from 'socket.io';
import { normalizeIP } from '../utils/ip';

type ConnectRow = {
  ts: number;
  sessionID: string;
  ipHash: string;
  country: string;
};

type DailyRollup = {
  day: string;
  uniqueSessions: number;
  uniqueVisitors: number;
  countries: Record<string, number>;
};

const BUFFER_MAX = 20_000;
const MS_24H = 24 * 60 * 60 * 1000;
const ROLLUP_FILE = 'traffic_daily.jsonl';

const connectBuffer: ConnectRow[] = [];
const liveCountryBySession = new Map<string, string>();
let lastFlushedDay: string | null = null;

function telemetryDir(): string {
  return path.join(process.cwd(), 'data', 'telemetry');
}

function rollupFilePath(): string {
  return path.join(telemetryDir(), ROLLUP_FILE);
}

function utcDayKey(ts = Date.now()): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function trafficSalt(): string {
  return process.env.TRAFFIC_SALT?.trim() || 'marspay-traffic';
}

function rollupRetentionDays(): number {
  const n = Number(process.env.TRAFFIC_ROLLUP_RETENTION_DAYS ?? 7);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 7;
}

function hashIp(ip: string, day: string): string {
  return createHash('sha256')
    .update(`${ip}:${day}:${trafficSalt()}`)
    .digest('hex')
    .slice(0, 16);
}

export function resolveClientIp(socket: Socket): string {
  const header = socket.handshake.headers['x-real-ip'];
  const raw =
    typeof header === 'string' && header.trim()
      ? header.trim()
      : socket.handshake.address ?? '';
  return normalizeIP(raw || 'unknown');
}

function resolveCountry(socket: Socket): string {
  const cf = socket.handshake.headers['cf-ipcountry'];
  if (typeof cf === 'string' && /^[A-Za-z]{2}$/.test(cf.trim())) {
    return cf.trim().toUpperCase();
  }
  return 'unknown';
}

export function resolveClientGeo(socket: Socket): { ip: string; country: string; ipHash: string } {
  const ip = resolveClientIp(socket);
  const country = resolveCountry(socket);
  const ipHash = ip === 'unknown' ? 'unknown' : hashIp(ip, utcDayKey());
  return { ip, country, ipHash };
}

function pruneBuffer(now = Date.now()): void {
  const cutoff = now - MS_24H;
  while (connectBuffer.length > 0 && connectBuffer[0].ts < cutoff) {
    connectBuffer.shift();
  }
  if (connectBuffer.length > BUFFER_MAX) {
    connectBuffer.splice(0, connectBuffer.length - BUFFER_MAX);
  }
}

function rowsIn24h(now = Date.now()): ConnectRow[] {
  const cutoff = now - MS_24H;
  return connectBuffer.filter((r) => r.ts >= cutoff);
}

function ensureTelemetryDir(): void {
  fs.mkdirSync(telemetryDir(), { recursive: true });
}

function loadRollups(): DailyRollup[] {
  const filePath = rollupFilePath();
  if (!fs.existsSync(filePath)) return [];
  const rows: DailyRollup[] = [];
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as DailyRollup;
      if (row.day && row.countries) rows.push(row);
    } catch {
      // skip malformed
    }
  }
  return rows;
}

function writeRollups(rows: DailyRollup[]): void {
  ensureTelemetryDir();
  const cutoffDay = utcDayKey(Date.now() - rollupRetentionDays() * MS_24H);
  const kept = rows.filter((r) => r.day >= cutoffDay).sort((a, b) => a.day.localeCompare(b.day));
  fs.writeFileSync(rollupFilePath(), kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''), 'utf8');
}

function aggregateDay(day: string, rows: ConnectRow[]): DailyRollup {
  const dayStart = new Date(`${day}T00:00:00.000Z`).getTime();
  const dayEnd = dayStart + MS_24H;
  const inDay = rows.filter((r) => r.ts >= dayStart && r.ts < dayEnd);

  const sessions = new Set<string>();
  const visitors = new Set<string>();
  const countrySessions = new Map<string, Set<string>>();

  for (const r of inDay) {
    sessions.add(r.sessionID);
    if (r.ipHash !== 'unknown') visitors.add(r.ipHash);
    let set = countrySessions.get(r.country);
    if (!set) {
      set = new Set();
      countrySessions.set(r.country, set);
    }
    set.add(r.sessionID);
  }

  const countries: Record<string, number> = {};
  for (const [country, set] of countrySessions) {
    countries[country] = set.size;
  }

  return {
    day,
    uniqueSessions: sessions.size,
    uniqueVisitors: visitors.size,
    countries,
  };
}

function maybeFlushPreviousDay(now = Date.now()): void {
  const today = utcDayKey(now);
  if (lastFlushedDay === today) return;

  const rollups = loadRollups();
  const existingDays = new Set(rollups.map((r) => r.day));

  // Flush any complete UTC days in buffer that aren't today
  const daysInBuffer = new Set(connectBuffer.map((r) => utcDayKey(r.ts)));
  for (const day of daysInBuffer) {
    if (day >= today || existingDays.has(day)) continue;
    const rollup = aggregateDay(day, connectBuffer);
    rollups.push(rollup);
    existingDays.add(day);
  }

  if (rollups.length > loadRollups().length) {
    writeRollups(rollups);
  }
  lastFlushedDay = today;
}

export function recordSessionConnect(sessionID: string, socket: Socket): void {
  const { country, ipHash } = resolveClientGeo(socket);
  const ts = Date.now();

  connectBuffer.push({ ts, sessionID, ipHash, country });
  liveCountryBySession.set(sessionID, country);
  pruneBuffer(ts);
  maybeFlushPreviousDay(ts);
}

export function recordSessionDisconnect(sessionID: string): void {
  liveCountryBySession.delete(sessionID);
}

function topCountries24h(rows: ConnectRow[]): Array<{
  country: string;
  sessions: number;
  uniqueVisitors: number;
}> {
  const byCountry = new Map<string, { sessions: Set<string>; visitors: Set<string> }>();

  for (const r of rows) {
    let bucket = byCountry.get(r.country);
    if (!bucket) {
      bucket = { sessions: new Set(), visitors: new Set() };
      byCountry.set(r.country, bucket);
    }
    bucket.sessions.add(r.sessionID);
    if (r.ipHash !== 'unknown') bucket.visitors.add(r.ipHash);
  }

  return [...byCountry.entries()]
    .map(([country, b]) => ({
      country,
      sessions: b.sessions.size,
      uniqueVisitors: b.visitors.size,
    }))
    .sort((a, b) => b.sessions - a.sessions);
}

function connectedNowByCountry(): Array<{ country: string; count: number }> {
  const counts = new Map<string, number>();
  for (const country of liveCountryBySession.values()) {
    counts.set(country, (counts.get(country) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([country, count]) => ({ country, count }))
    .sort((a, b) => b.count - a.count);
}

export function getTrafficSnapshot() {
  maybeFlushPreviousDay();
  const now = Date.now();
  const rows = rowsIn24h(now);

  const sessionSet = new Set<string>();
  const visitorSet = new Set<string>();
  let knownGeoConnects = 0;

  for (const r of rows) {
    sessionSet.add(r.sessionID);
    if (r.ipHash !== 'unknown') visitorSet.add(r.ipHash);
    if (r.country !== 'unknown') knownGeoConnects++;
  }

  const connectCount = rows.length;
  const uniqueSessions24h = sessionSet.size;
  const uniqueVisitors24h = visitorSet.size;
  const geoCoveragePct =
    connectCount > 0 ? Math.round((knownGeoConnects / connectCount) * 1000) / 10 : 0;
  const geoWarning = uniqueSessions24h >= 5 && geoCoveragePct < 20;

  const rollups = loadRollups()
    .sort((a, b) => a.day.localeCompare(b.day))
    .slice(-rollupRetentionDays());

  return {
    uniqueSessions24h,
    uniqueVisitors24h,
    geoCoveragePct,
    geoWarning,
    connectedNowByCountry: connectedNowByCountry(),
    topCountries24h: topCountries24h(rows),
    countrySeries7d: rollups.map((r) => ({
      day: r.day,
      countries: r.countries,
    })),
    rollupRetentionNote:
      '24h stats reset on server restart; 7d country trends persist on disk',
  };
}
