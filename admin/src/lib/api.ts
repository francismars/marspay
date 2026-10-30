import { displayName } from './playerDisplay';

const API_BASE = '/dashboard/api';

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text();
    const message =
      res.status === 429
        ? 'Too many requests — try again in a minute or disable live refresh.'
        : text.startsWith('<')
          ? `HTTP ${res.status}`
          : text || `HTTP ${res.status}`;
    throw new ApiError(message, res.status);
  }
  return res.json() as Promise<T>;
}

export async function checkAuth(): Promise<boolean> {
  const data = await apiFetch<{ authenticated: boolean }>('/me');
  return data.authenticated;
}

export async function login(password: string): Promise<void> {
  await apiFetch('/login', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}

export async function logout(): Promise<void> {
  await apiFetch('/logout', { method: 'POST' });
}

export type OverviewData = {
  fetchedAt: string;
  connectedSessions: number;
  activeOnlineRooms: number;
  challengeRunsTotal: number;
  challengeRuns24h: number;
  metricsWindow: {
    challengeRuns: 'lifetime';
    challengeRuns24h: '24h';
    bounty: 'today';
  };
  bountyPaidTodaySats: number;
  bountyCapSats: number;
  bountyCapPct: number;
  bountyRemainingSats: number;
  pendingZapClaims: number;
  serverUptimeSec: number;
  eventLogBytes: number;
  sessionsWithGameActivity24h?: number;
  traffic: {
    uniqueSessions24h: number;
    uniqueVisitors24h: number;
    geoCoveragePct: number;
    geoWarning: boolean;
    connectedNowByCountry: Array<{ country: string; count: number }>;
    topCountries24h: Array<{ country: string; sessions: number; uniqueVisitors: number }>;
    countrySeries7d: Array<{ day: string; countries: Record<string, number> }>;
    rollupRetentionNote: string;
  };
};

export type FunnelStep = {
  ok: number;
  reject: number;
  error: number;
  total: number;
  passRate: number;
};

export type FunnelsData = {
  fetchedAt: string;
  window: 'lifetime' | '24h' | '7d';
  challenge: {
    steps: Record<string, FunnelStep>;
    topRejectReasons: Record<string, Array<{ reason: string; count: number }>>;
  };
  online: {
    steps: Record<string, FunnelStep>;
    topRejectReasons: Record<string, Array<{ reason: string; count: number }>>;
  };
  client: {
    steps: Record<string, FunnelStep>;
    uiErrors: Array<{ reason: string; count: number }>;
  };
  p2p?: {
    steps: Record<string, FunnelStep>;
  };
};

export type PlayerIdentity = {
  kind: 'nostr' | 'anon';
  pubkey?: string;
  npub?: string;
  name?: string;
  picture?: string | null;
  nip05?: string | null;
  lud16?: string | null;
  signerMode?: 'extension' | 'nip46' | 'nsec' | null;
  pubkeyPrefix?: string;
};

export type LiveSessionContext = {
  mode?: 'challenge' | 'online' | 'idle';
  roomCode?: string;
  roomId?: string;
  seatRole?: 'p1' | 'p2';
  seatStatus?: string;
  challengeId?: string;
  lastEvent?: string;
  lastOutcome?: string;
  lastEventTs?: string;
  currentRoute?: string;
};

export type LiveData = {
  fetchedAt: string;
  sessions: Array<{
    sessionID: string;
    lastSeenMs: number;
    nostrLinked: boolean;
    identity: PlayerIdentity;
    context: LiveSessionContext;
    kind1Count: number;
  }>;
  total: number;
  nostrLinked: number;
  inOnline: number;
  inChallenge: number;
};

export type LiveSessionDetail = {
  fetchedAt: string;
  sessionID: string;
  lastSeenMs: number;
  identity: PlayerIdentity;
  context: LiveSessionContext;
  recentEvents: Array<{
    ts: string;
    event: string;
    outcome: string;
    reason?: string;
    challengeId?: string;
    roomCode?: string;
  }>;
  lobbyUrl?: string;
};

export type RecentAttemptsData = {
  fetchedAt: string;
  hours: number;
  attempts: Array<{
    key: string;
    pubkeyPrefix?: string;
    sessionID?: string;
    identity?: PlayerIdentity;
    lastTs: string;
    lastEvent: string;
    lastOutcome: string;
    lastReason?: string;
    challengeRuns: number;
    onlineJoins: number;
    nostrLinks: number;
    quickmatchStarts?: number;
    p2pDeposits?: number;
    topRejectReason?: string;
    topRejectCount?: number;
  }>;
  total: number;
};

export type OnlineSeat = {
  role: 'p1' | 'p2';
  sessionID?: string;
  status: string;
  paidAmount?: number;
  payMethod?: string;
  name?: string;
  picture?: string;
  pubkeyPrefix?: string;
  npub?: string;
  ready?: boolean;
  pingMs?: number;
  forfeitRemainingMs?: number;
};

export type OnlineRoomLive = {
  roomId: string;
  roomCode: string;
  phase: string;
  buyin: number;
  matchRound: number;
  seatsPaid: number;
  seatsTotal: number;
  spectators: number;
  ageMs: number;
  result?: Record<string, unknown>;
  replay?: { available?: boolean };
  seats: OnlineSeat[];
  forfeit?: {
    paused: boolean;
    limitMs: number;
    p1RemainingMs?: number;
    p2RemainingMs?: number;
  };
  lobbyUrl: string;
  gameUrl?: string;
};

export type ChallengesData = {
  fetchedAt: string;
  browseFunnel?: Record<string, FunnelStep>;
  difficulty?: {
    fetchedAt: string;
    challenges: Array<{
      challengeId: string;
      views: number;
      clicks: number;
      runs: number;
      completions: number;
      claims: number;
      completionRate: number | null;
      claimRate: number | null;
    }>;
    minRunsThreshold: number;
  };
  stats: {
    byChallenge: Record<
      string,
      { wins: number; replayFailed: number; replayReasons: Record<string, number> }
    >;
    totalWins: number;
    totalReplayFailed: number;
  };
  bountyCapSats: number;
  bountySpentTodaySats: number;
  bountyRemainingSats: number;
  dailySpendSeries: Array<{ day: string; sats: number }>;
  pendingZaps: Array<{
    pubkey: string;
    npub: string;
    pubkeyPrefix?: string;
    identity?: PlayerIdentity;
    challengeId: string;
    runId: string;
    bountySats: number;
    publishedAt: number | null;
  }>;
  recentClaims: Array<{
    pubkey?: string;
    npub?: string;
    pubkeyPrefix?: string;
    identity?: PlayerIdentity;
    challengeId?: unknown;
    runId?: unknown;
    bountySats?: unknown;
    zapPaidAt?: unknown;
    publishedAt?: unknown;
  }>;
};

export type OnlineMatchResult = {
  winnerName: string;
  p1Name: string;
  p2Name: string;
  p1Score: number;
  p2Score: number;
  netPrize: number;
  outcome?: 'forfeit' | 'abandoned' | 'unclaimed';
  p1Paid?: number;
  p2Paid?: number;
};

export type OnlineHistoryRow = {
  roomCode: string;
  phase: string;
  buyin: number;
  matchRound?: number;
  finishedAt?: number;
  archiveKind?: 'match' | 'session';
  result?: OnlineMatchResult;
  replay?: { available?: boolean; durationMs?: number };
};

export type OnlineData = {
  fetchedAt: string;
  live: OnlineRoomLive[];
  history: OnlineHistoryRow[];
};

export type ActivityData = {
  fetchedAt: string;
  events: Array<{
    ts: string;
    event: string;
    outcome: string;
    reason?: string;
    sessionID?: string;
    pubkeyPrefix?: string;
    player?: PlayerIdentity;
    challengeId?: string;
    roomId?: string;
    roomCode?: string;
    source?: string;
    meta?: Record<string, string | number | boolean>;
  }>;
};

export type ActivityFilters = {
  limit?: number;
  event?: string;
  outcome?: string;
  since?: '1h' | '24h' | '7d';
  sessionID?: string;
  pubkeyPrefix?: string;
  roomCode?: string;
};

export type TrendValue = {
  value: number;
  prior: number;
  deltaPct: number | null;
  window: '24h' | '7d';
};

export type DashboardAlert = {
  id: string;
  severity: 'warn' | 'error' | 'info';
  message: string;
  drillDown?: { tab: string; mode?: string; event?: string };
};

export type StepConversionStep = {
  key: string;
  event: string;
  label: string;
  count: number;
  pctOfFirst: number;
  pctOfPrevious: number;
  dropFromPrevious: number;
};

export type ModeFunnelData = {
  mode: string;
  window: '24h' | '7d';
  steps: StepConversionStep[];
  biggestDropIndex: number;
  fetchedAt: string;
  rejectReasons?: Record<string, Array<{ reason: string; count: number }>>;
  derived?: {
    paymentAbandoned?: { requested: number; abandoned: number; abandonRate: number };
    lobbyAbandonRate?: number;
    midGameDisconnects?: { totalDisconnects: number; midGameDisconnects: number };
  };
};

export type HomeData = {
  fetchedAt: string;
  window: '24h' | '7d';
  activation: {
    rate: number;
    sessionsWithGame: number;
    uniqueSessions: number;
    trend: TrendValue | null;
  };
  modeMetrics: Array<{
    mode: string;
    label: string;
    rate: number;
    numerator: number;
    denominator: number;
    trend: TrendValue | null;
    topDropOff: { stepKey: string; stepLabel: string; dropPct: number } | null;
  }>;
  alerts: DashboardAlert[];
  acquisition: {
    menuChoices: Record<string, number>;
    topReferrers: Array<{ referrer: string; count: number }>;
    topPlatforms: Array<{ platform: string; count: number }>;
    sessionsWithContext: number;
  };
  system: {
    connectedSessions: number;
    activeOnlineRooms: number;
    serverUptimeSec: number;
    eventLogBytes: number;
    geoCoveragePct: number;
    geoWarning: boolean;
  };
  traffic: OverviewData['traffic'];
};

export type CohortData = {
  fetchedAt: string;
  window: string;
  tierBNote: string;
  newNostrPlayers: number;
  returnRate: number;
  returningPlayers: number;
  firstGameModeDistribution: Record<string, number>;
};

export type MoneyData = {
  fetchedAt: string;
  bountyCapSats: number;
  bountySpentTodaySats: number;
  bountyRemainingSats: number;
  bountyCapPct: number;
  dailySpendSeries: Array<{ day: string; sats: number }>;
  pendingZapClaims: number;
  p2pDeposits: number;
  p2pWithdrawals: number;
  onlinePayouts: number;
  challengeStats: { totalWins: number; totalReplayFailed: number };
};

export const fetchHome = (window: '24h' | '7d' = '24h') =>
  apiFetch<HomeData>(`/home?window=${window}`);

export const fetchAlerts = (window: '24h' | '7d' = '24h') =>
  apiFetch<{ fetchedAt: string; window: string; alerts: DashboardAlert[] }>(
    `/alerts?window=${window}`
  );

export const fetchModeFunnel = (mode: string, window: '24h' | '7d' = '24h') =>
  apiFetch<ModeFunnelData>(`/funnels/${mode}?window=${window}`);

export const fetchCohorts = (window: '7d' | '24h' = '7d') =>
  apiFetch<CohortData>(`/cohorts?window=${window}`);

export const fetchMoney = () => apiFetch<MoneyData>('/money');

export const fetchOverview = () => apiFetch<OverviewData>('/overview');

export const fetchFunnels = (window: 'lifetime' | '24h' | '7d' = 'lifetime') =>
  apiFetch<FunnelsData>(`/funnels?window=${window}`);

export const fetchChallenges = () => apiFetch<ChallengesData>('/challenges');
export const fetchOnline = () => apiFetch<OnlineData>('/online');

export const fetchActivity = (params?: ActivityFilters) => {
  const q = new URLSearchParams();
  if (params?.limit) q.set('limit', String(params.limit));
  if (params?.event) q.set('event', params.event);
  if (params?.outcome) q.set('outcome', params.outcome);
  if (params?.since) q.set('since', params.since);
  if (params?.sessionID) q.set('sessionID', params.sessionID);
  if (params?.pubkeyPrefix) q.set('pubkeyPrefix', params.pubkeyPrefix);
  if (params?.roomCode) q.set('roomCode', params.roomCode);
  const qs = q.toString();
  return apiFetch<ActivityData>(`/activity${qs ? `?${qs}` : ''}`);
};

export const fetchLive = () => apiFetch<LiveData>('/live');
export const fetchLiveRecent = (hours = 24) =>
  apiFetch<RecentAttemptsData>(`/live/recent?hours=${hours}`);
export const fetchLiveSession = (sessionID: string) =>
  apiFetch<LiveSessionDetail>(`/live/${encodeURIComponent(sessionID)}`);

export type VisitorsData = {
  fetchedAt: string;
  hours: number;
  traffic: OverviewData['traffic'];
  sessionsWithContext: number;
  sessionsWithGameActivity: number;
  topReferrers: Array<{ referrer: string; count: number }>;
  topPlatforms: Array<{ platform: string; count: number }>;
  menuChoices: Record<string, number>;
};

export type QuickMatchData = {
  fetchedAt: string;
  started: number;
  completed: number;
  completionRate: number;
  winRate: number;
  avgDurationMs: number;
  byMode: Record<string, number>;
  byOpponentType: Record<string, number>;
};

export type P2pData = {
  fetchedAt: string;
  configured: number;
  depositsPaid: number;
  gameStarted: number;
  gameFinished: number;
  gameCompletedClient: number;
  withdrawals: number;
  doubleOrNothing: number;
  byMode: Record<string, number>;
};

export type ReplayData = {
  fetchedAt: string;
  replayStarts: number;
  replayEnds: number;
  spectateStarts: number;
  avgWatchDurationMs: number;
  topRooms: Array<{ roomCode: string; count: number }>;
};

export type JourneyData = {
  fetchedAt: string;
  sessionIDs: string[];
  pubkeyPrefix?: string;
  identity?: PlayerIdentity;
  eventCount: number;
  timeline: Array<{
    ts: string;
    event: string;
    outcome: string;
    reason?: string;
    sessionID?: string;
    challengeId?: string;
    roomCode?: string;
    meta?: Record<string, string | number | boolean>;
  }>;
};

export const fetchVisitors = (hours = 24) =>
  apiFetch<VisitorsData>(`/visitors?hours=${hours}`);

export const fetchQuickMatch = () => apiFetch<QuickMatchData>('/quickmatch');

export const fetchP2p = () => apiFetch<P2pData>('/p2p');

export const fetchReplays = () => apiFetch<ReplayData>('/replays');

export const fetchJourney = (params: { sessionID?: string; pubkey?: string }) => {
  const q = new URLSearchParams();
  if (params.sessionID) q.set('sessionID', params.sessionID);
  if (params.pubkey) q.set('pubkey', params.pubkey);
  return apiFetch<JourneyData>(`/journey?${q.toString()}`);
};

export async function resolvePlayerIdentities(
  items: Array<{ pubkey?: string; pubkeyPrefix?: string }>
): Promise<{ identities: PlayerIdentity[] }> {
  return apiFetch('/players/resolve', {
    method: 'POST',
    body: JSON.stringify({ items: items.slice(0, 20) }),
  });
}

/** @deprecated Use fetchLive */
export const fetchSessions = fetchLive;

export function activityExportUrl(params: ActivityFilters, format: 'csv' | 'json'): string {
  const q = new URLSearchParams();
  q.set('limit', '200');
  if (params.event) q.set('event', params.event);
  if (params.outcome) q.set('outcome', params.outcome);
  if (params.since) q.set('since', params.since);
  if (params.sessionID) q.set('sessionID', params.sessionID);
  if (params.pubkeyPrefix) q.set('pubkeyPrefix', params.pubkeyPrefix);
  if (params.roomCode) q.set('roomCode', params.roomCode);
  return `${API_BASE}/activity?${q.toString()}&format=${format}`;
}

export async function exportActivity(params: ActivityFilters, format: 'csv' | 'json'): Promise<void> {
  const data = await fetchActivity({ ...params, limit: 200 });
  if (format === 'json') {
    const blob = new Blob([JSON.stringify(data.events, null, 2)], { type: 'application/json' });
    downloadBlob(blob, `activity-${Date.now()}.json`);
    return;
  }
  const headers = [
    'ts',
    'event',
    'outcome',
    'reason',
    'sessionID',
    'playerName',
    'pubkeyPrefix',
    'challengeId',
    'roomCode',
    'source',
  ];
  const lines = [
    headers.join(','),
    ...data.events.map((e) => {
      const row: Record<string, string> = {
        ts: e.ts,
        event: e.event,
        outcome: e.outcome,
        reason: e.reason ?? '',
        sessionID: e.sessionID ?? '',
        playerName: e.player ? displayName(e.player) : '',
        pubkeyPrefix: e.pubkeyPrefix ?? '',
        challengeId: e.challengeId ?? '',
        roomCode: e.roomCode ?? '',
        source: e.source ?? '',
      };
      return headers
        .map((h) => {
          const s = row[h] ?? '';
          return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(',');
    }),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  downloadBlob(blob, `activity-${Date.now()}.csv`);
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
