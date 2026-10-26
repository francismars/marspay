import { getAllIDtoSocket } from '../state/sessionState';
import {
  getDailyZapBudgetRemaining,
  listPendingZapClaims,
} from '../state/challengeState';
import { loadDailySpendSync } from '../state/challengeClaimStore';
import { getChallengeTelemetrySnapshot } from '../state/challengeTelemetry';
import { listOnlineRooms, getRoomBySession } from '../state/onlineRoomState';
import {
  getEventLogByteSize,
  scanEvents,
  type StoredTrackEvent,
} from './eventLog';
import { getTrafficSnapshot } from './trafficAnalytics';
import {
  FUNNEL_BY_MODE,
  type FunnelMode,
  type FunnelStepDef,
} from './funnelDefinitions';

export type { FunnelMode };

export type AnalyticsWindow = '24h' | '7d';

export type StepConversionStep = {
  key: string;
  event: string;
  label: string;
  count: number;
  pctOfFirst: number;
  pctOfPrevious: number;
  dropFromPrevious: number;
};

export type StepConversionFunnel = {
  mode: FunnelMode;
  window: AnalyticsWindow;
  steps: StepConversionStep[];
  biggestDropIndex: number;
  fetchedAt: string;
};

export type TrendValue = {
  value: number;
  prior: number;
  deltaPct: number | null;
  window: AnalyticsWindow;
};

export type HomeModeMetric = {
  mode: FunnelMode;
  label: string;
  rate: number;
  numerator: number;
  denominator: number;
  trend: TrendValue | null;
  topDropOff: {
    stepKey: string;
    stepLabel: string;
    dropPct: number;
  } | null;
};

export type DashboardAlert = {
  id: string;
  severity: 'warn' | 'error' | 'info';
  message: string;
  drillDown?: { tab: string; mode?: string; event?: string };
};

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function sinceHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function windowHours(window: AnalyticsWindow): number {
  return window === '24h' ? 24 : 168;
}

function priorWindowBounds(window: AnalyticsWindow): { since: string; until: string } {
  const hours = windowHours(window);
  const until = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const since = new Date(Date.now() - hours * 2 * 60 * 60 * 1000).toISOString();
  return { since, until };
}

function eventsInWindow(window: AnalyticsWindow, prior = false): StoredTrackEvent[] {
  const hours = windowHours(window);
  if (!prior) {
    return scanEvents(10_000, { sinceTs: sinceHoursAgo(hours) });
  }
  const { since, until } = priorWindowBounds(window);
  return scanEvents(10_000, { sinceTs: since }).filter((e) => e.ts < until);
}

function matchesStep(e: StoredTrackEvent, step: FunnelStepDef): boolean {
  if (e.event !== step.event) return false;
  const outcome = step.outcome ?? 'ok';
  if (e.outcome !== outcome) return false;
  if (step.meta) {
    for (const [k, v] of Object.entries(step.meta)) {
      if (String(e.meta?.[k] ?? '') !== v) return false;
    }
  }
  return true;
}

function countStep(events: StoredTrackEvent[], step: FunnelStepDef): number {
  return events.filter((e) => matchesStep(e, step)).length;
}

export function buildStepConversionFunnel(
  defs: FunnelStepDef[],
  mode: FunnelMode,
  window: AnalyticsWindow = '24h'
): StepConversionFunnel {
  const events = eventsInWindow(window);
  const counts = defs.map((d) => countStep(events, d));
  const first = counts[0] ?? 0;

  let biggestDropIndex = 0;
  let biggestDrop = 0;

  const steps: StepConversionStep[] = defs.map((def, i) => {
    const count = counts[i] ?? 0;
    const prev = i > 0 ? (counts[i - 1] ?? 0) : count;
    const pctOfFirst = first > 0 ? Math.round((count / first) * 1000) / 10 : 0;
    const pctOfPrevious = prev > 0 ? Math.round((count / prev) * 1000) / 10 : 0;
    const dropFromPrevious =
      i > 0 && prev > 0 ? Math.round(((prev - count) / prev) * 1000) / 10 : 0;
    if (i > 0 && dropFromPrevious > biggestDrop) {
      biggestDrop = dropFromPrevious;
      biggestDropIndex = i;
    }
    return {
      key: def.key,
      event: def.event,
      label: def.label,
      count,
      pctOfFirst,
      pctOfPrevious,
      dropFromPrevious,
    };
  });

  return {
    mode,
    window,
    steps,
    biggestDropIndex,
    fetchedAt: new Date().toISOString(),
  };
}

function computeTrend(current: number, prior: number, window: AnalyticsWindow): TrendValue | null {
  if (prior < 5 && current < 5) return null;
  const deltaPct =
    prior > 0 ? Math.round(((current - prior) / prior) * 1000) / 10 : current > 0 ? 100 : 0;
  return { value: current, prior, deltaPct, window };
}

function modeOmtm(
  mode: FunnelMode,
  events: StoredTrackEvent[],
  priorEvents: StoredTrackEvent[]
): HomeModeMetric {
  const labels: Record<FunnelMode, string> = {
    quickmatch: 'Quick Match',
    challenge: 'Challenges',
    p2p: 'P2P',
    online: 'ONLINE',
    nostr: 'Nostr sign-in',
  };

  const funnel = buildStepConversionFunnel(FUNNEL_BY_MODE[mode], mode, '24h');
  const topDrop =
    funnel.biggestDropIndex > 0
      ? {
          stepKey: funnel.steps[funnel.biggestDropIndex]?.key ?? '',
          stepLabel: funnel.steps[funnel.biggestDropIndex]?.label ?? '',
          dropPct: funnel.steps[funnel.biggestDropIndex]?.dropFromPrevious ?? 0,
        }
      : null;

  let num = 0;
  let den = 0;
  let priorNum = 0;
  let priorDen = 0;

  switch (mode) {
    case 'quickmatch':
      den = countStep(events, FUNNEL_BY_MODE.quickmatch[3]!);
      num = countStep(events, FUNNEL_BY_MODE.quickmatch[4]!);
      priorDen = countStep(priorEvents, FUNNEL_BY_MODE.quickmatch[3]!);
      priorNum = countStep(priorEvents, FUNNEL_BY_MODE.quickmatch[4]!);
      break;
    case 'challenge':
      den = countStep(events, FUNNEL_BY_MODE.challenge[4]!);
      num = countStep(events, FUNNEL_BY_MODE.challenge[7]!);
      priorDen = countStep(priorEvents, FUNNEL_BY_MODE.challenge[4]!);
      priorNum = countStep(priorEvents, FUNNEL_BY_MODE.challenge[7]!);
      break;
    case 'p2p':
      den = countStep(events, FUNNEL_BY_MODE.p2p[2]!);
      num = countStep(events, FUNNEL_BY_MODE.p2p[4]!);
      priorDen = countStep(priorEvents, FUNNEL_BY_MODE.p2p[2]!);
      priorNum = countStep(priorEvents, FUNNEL_BY_MODE.p2p[4]!);
      break;
    case 'online':
      den = countStep(events, FUNNEL_BY_MODE.online[3]!);
      num = countStep(events, FUNNEL_BY_MODE.online[5]!);
      priorDen = countStep(priorEvents, FUNNEL_BY_MODE.online[3]!);
      priorNum = countStep(priorEvents, FUNNEL_BY_MODE.online[5]!);
      break;
    case 'nostr':
      den = countStep(events, FUNNEL_BY_MODE.nostr[2]!);
      num = countStep(events, FUNNEL_BY_MODE.nostr[4]!);
      priorDen = countStep(priorEvents, FUNNEL_BY_MODE.nostr[2]!);
      priorNum = countStep(priorEvents, FUNNEL_BY_MODE.nostr[4]!);
      break;
  }

  const rate = den > 0 ? Math.round((num / den) * 1000) / 10 : 0;
  const priorRate = priorDen > 0 ? Math.round((priorNum / priorDen) * 1000) / 10 : 0;

  return {
    mode,
    label: labels[mode],
    rate,
    numerator: num,
    denominator: den,
    trend: computeTrend(rate, priorRate, '24h'),
    topDropOff: topDrop,
  };
}

function countDistinctSessionsSince(sinceTs: string, eventList: string[]): number {
  const seen = new Set<string>();
  for (const e of scanEvents(10_000, { sinceTs, events: eventList })) {
    if (e.sessionID) seen.add(e.sessionID);
  }
  return seen.size;
}

function buildAcquisitionSnapshot(hours: number) {
  const sinceTs = sinceHoursAgo(hours);
  const contextEvents = scanEvents(10_000, {
    sinceTs,
    events: ['client.session.context'],
  });
  const referrers: Record<string, number> = {};
  const platforms: Record<string, number> = {};
  const contextSessions = new Set<string>();
  for (const e of contextEvents) {
    if (e.sessionID) contextSessions.add(e.sessionID);
    const ref = e.meta?.referrer;
    if (typeof ref === 'string' && ref) referrers[ref] = (referrers[ref] ?? 0) + 1;
    const platform = e.meta?.platform;
    if (typeof platform === 'string' && platform) {
      platforms[platform] = (platforms[platform] ?? 0) + 1;
    }
  }
  const sessionsWithContext = contextSessions.size;

  const menuEvents = scanEvents(10_000, { sinceTs, events: ['client.menu.selected'] });
  const menuChoices: Record<string, number> = {};
  for (const e of menuEvents) {
    const mode = e.meta?.mode;
    if (typeof mode === 'string') menuChoices[mode] = (menuChoices[mode] ?? 0) + 1;
  }

  return {
    menuChoices,
    topReferrers: Object.entries(referrers)
      .map(([referrer, count]) => ({ referrer, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
    topPlatforms: Object.entries(platforms)
      .map(([platform, count]) => ({ platform, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
    sessionsWithContext,
  };
}

export function buildAlertsSnapshot(window: AnalyticsWindow = '24h'): {
  fetchedAt: string;
  window: AnalyticsWindow;
  alerts: DashboardAlert[];
} {
  const hours = windowHours(window);
  const sinceTs = sinceHoursAgo(hours);
  const events = eventsInWindow(window);
  const alerts: DashboardAlert[] = [];

  const dailySpend = loadDailySpendSync();
  const cap = Math.max(0, Number(process.env.CHALLENGE_BOUNTY_DAILY_CAP_SATS ?? 100_000));
  const spentToday = dailySpend[todayKey()] ?? 0;
  const bountyCapPct = cap > 0 ? Math.round((spentToday / cap) * 1000) / 10 : 0;

  if (bountyCapPct >= 80) {
    alerts.push({
      id: 'bounty_cap',
      severity: 'warn',
      message: `Bounty cap at ${bountyCapPct}% (${spentToday.toLocaleString()} / ${cap.toLocaleString()} sats)`,
      drillDown: { tab: 'money' },
    });
  }

  const traffic = getTrafficSnapshot();
  const contextCount = scanEvents(10_000, {
    sinceTs,
    events: ['client.session.context'],
  }).filter((e) => e.sessionID).length;

  if (traffic.uniqueSessions24h > 0 && contextCount === 0) {
    alerts.push({
      id: 'instrumentation_gap',
      severity: 'error',
      message: 'Sessions detected but no client.session.context — check client deploy',
      drillDown: { tab: 'debug', event: 'client.session' },
    });
  }

  const qmStarted = countStep(events, FUNNEL_BY_MODE.quickmatch[3]!);
  const qmCompleted = countStep(events, FUNNEL_BY_MODE.quickmatch[4]!);
  const qmRate = qmStarted > 0 ? (qmCompleted / qmStarted) * 100 : 100;
  if (qmStarted > 5 && qmRate < 20) {
    alerts.push({
      id: 'quickmatch_stall',
      severity: 'warn',
      message: `Quick match completion ${Math.round(qmRate)}% (${qmCompleted}/${qmStarted})`,
      drillDown: { tab: 'modes', mode: 'quickmatch' },
    });
  }

  const elig = events.filter((e) => e.event === 'challenge.eligibility');
  const eligReject = elig.filter((e) => e.outcome === 'reject').length;
  if (elig.length >= 5 && eligReject / elig.length > 0.3) {
    alerts.push({
      id: 'eligibility_wall',
      severity: 'warn',
      message: `Challenge eligibility reject rate ${Math.round((eligReject / elig.length) * 100)}%`,
      drillDown: { tab: 'modes', mode: 'challenge' },
    });
  }

  const uiErrors = events.filter((e) => e.event === 'client.ui.error').length;
  if (uiErrors >= 10) {
    alerts.push({
      id: 'ui_error_spike',
      severity: 'warn',
      message: `${uiErrors} client UI errors in last ${window}`,
      drillDown: { tab: 'debug', event: 'client.ui.error' },
    });
  }

  if (traffic.geoCoveragePct < 50 && traffic.uniqueSessions24h > 0) {
    alerts.push({
      id: 'geo_blind',
      severity: 'info',
      message: `Geo coverage ${traffic.geoCoveragePct}% — enable CF-IPCountry`,
    });
  }

  return {
    fetchedAt: new Date().toISOString(),
    window,
    alerts,
  };
}

export function buildHomeSnapshot(window: AnalyticsWindow = '24h') {
  const hours = windowHours(window);
  const sinceTs = sinceHoursAgo(hours);
  const events = eventsInWindow(window);
  const priorEvents = eventsInWindow(window, true);

  const traffic = getTrafficSnapshot();
  const gameSessions = countDistinctSessionsSince(sinceTs, [
    'client.quickmatch.started',
    'challenge.run',
    'deposit.paid',
    'online.seat.paid',
  ]);

  const uniqueSessions = traffic.uniqueSessions24h;
  const activationRate =
    uniqueSessions > 0 ? Math.round((gameSessions / uniqueSessions) * 1000) / 10 : 0;

  const priorSince = priorWindowBounds(window).since;
  const priorUntil = priorWindowBounds(window).until;
  const priorGameSessions = scanEvents(10_000, {
    sinceTs: priorSince,
    events: [
      'client.quickmatch.started',
      'challenge.run',
      'deposit.paid',
      'online.seat.paid',
    ],
  }).filter((e) => e.ts < priorUntil && e.sessionID).reduce((s, e) => {
    s.add(e.sessionID!);
    return s;
  }, new Set<string>()).size;

  const activationTrend = computeTrend(
    activationRate,
    uniqueSessions > 0
      ? Math.round((priorGameSessions / Math.max(uniqueSessions, 1)) * 1000) / 10
      : 0,
    window
  );

  const modeMetrics: HomeModeMetric[] = (
    ['quickmatch', 'challenge', 'p2p', 'online'] as FunnelMode[]
  ).map((m) => modeOmtm(m, events, priorEvents));

  const visitors = buildAcquisitionSnapshot(hours);
  const alerts = buildAlertsSnapshot(window);
  const sessions = getAllIDtoSocket();
  const activeRooms = listOnlineRooms().filter((r) => r.phase !== 'finished');

  return {
    fetchedAt: new Date().toISOString(),
    window,
    activation: {
      rate: activationRate,
      sessionsWithGame: gameSessions,
      uniqueSessions,
      trend: activationTrend,
    },
    modeMetrics,
    alerts: alerts.alerts,
    acquisition: {
      menuChoices: visitors.menuChoices,
      topReferrers: visitors.topReferrers,
      topPlatforms: visitors.topPlatforms,
      sessionsWithContext: visitors.sessionsWithContext,
    },
    system: {
      connectedSessions: sessions.size,
      activeOnlineRooms: activeRooms.length,
      serverUptimeSec: Math.floor(process.uptime()),
      eventLogBytes: getEventLogByteSize(),
      geoCoveragePct: traffic.geoCoveragePct,
      geoWarning: traffic.geoWarning,
    },
    traffic,
  };
}

export function buildModeFunnelSnapshot(mode: FunnelMode, window: AnalyticsWindow = '24h') {
  const defs = FUNNEL_BY_MODE[mode];
  const funnel = buildStepConversionFunnel(defs, mode, window);
  const hours = windowHours(window);
  const events = eventsInWindow(window);

  const rejectTables: Record<string, Array<{ reason: string; count: number }>> = {};
  const rejectEvents = [
    'challenge.eligibility',
    'challenge.run',
    'challenge.claim',
    'nostr.app.link',
    'online.seat.pay_rejected',
    'online.room.joined',
    'online.game.started',
  ];

  for (const ev of rejectEvents) {
    if (defs.some((d) => d.event === ev)) {
      const counts = new Map<string, number>();
      for (const e of events) {
        if (e.event !== ev || e.outcome !== 'reject' || !e.reason) continue;
        counts.set(e.reason, (counts.get(e.reason) ?? 0) + 1);
      }
      const rows = [...counts.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);
      if (rows.length > 0) rejectTables[ev] = rows;
    }
  }

  const derived =
    mode === 'online'
      ? {
          paymentAbandoned: buildPaymentAbandonSnapshot(window),
          lobbyAbandonRate: computeLobbyAbandonRate(events),
          midGameDisconnects: buildMidGameDisconnectSnapshot(window),
        }
      : undefined;

  return {
    ...funnel,
    rejectReasons: rejectTables,
    derived,
  };
}

function computeLobbyAbandonRate(events: StoredTrackEvent[]): number {
  const joined = events.filter((e) => e.event === 'online.room.joined' && e.outcome === 'ok').length;
  const abandoned = events.filter((e) => e.event === 'client.funnel.abandon').length;
  if (joined === 0) return 0;
  return Math.round((abandoned / joined) * 1000) / 10;
}

export function buildPaymentAbandonSnapshot(window: AnalyticsWindow = '24h') {
  const events = eventsInWindow(window);
  const requested = events.filter(
    (e) => e.event === 'online.seat.lightning.requested' && e.outcome === 'ok'
  );
  const paidSessions = new Set(
    events
      .filter((e) => e.event === 'online.seat.paid' && e.outcome === 'ok' && e.sessionID)
      .map((e) => e.sessionID!)
  );

  let abandoned = 0;
  const ABANDON_MS = 15 * 60 * 1000;
  for (const req of requested) {
    if (!req.sessionID) continue;
    if (paidSessions.has(req.sessionID)) continue;
    const reqTs = new Date(req.ts).getTime();
    const paidLater = events.some(
      (e) =>
        e.event === 'online.seat.paid' &&
        e.sessionID === req.sessionID &&
        new Date(e.ts).getTime() - reqTs <= ABANDON_MS
    );
    if (!paidLater) abandoned++;
  }

  return {
    requested: requested.length,
    abandoned,
    abandonRate:
      requested.length > 0 ? Math.round((abandoned / requested.length) * 1000) / 10 : 0,
  };
}

export function buildMidGameDisconnectSnapshot(window: AnalyticsWindow = '24h') {
  const events = eventsInWindow(window);
  const disconnects = events.filter(
    (e) => e.event === 'session.disconnected' && e.outcome === 'ok'
  );
  let midGame = 0;
  for (const d of disconnects) {
    if (!d.sessionID) continue;
    const room = getRoomBySession(d.sessionID);
    if (room && room.phase === 'playing') midGame++;
    else {
      const hadOnlineGame = events.some(
        (e) =>
          e.sessionID === d.sessionID &&
          (e.event === 'online.game.started' || e.event === 'online.seat.paid') &&
          e.outcome === 'ok' &&
          e.ts <= d.ts
      );
      const finished = events.some(
        (e) =>
          e.sessionID === d.sessionID &&
          e.event === 'online.game.finished' &&
          e.ts <= d.ts
      );
      if (hadOnlineGame && !finished) midGame++;
    }
  }
  return {
    totalDisconnects: disconnects.length,
    midGameDisconnects: midGame,
  };
}

export function buildCohortSnapshot(window: AnalyticsWindow = '7d') {
  const hours = windowHours(window === '7d' ? '7d' : '24h');
  const sinceTs = sinceHoursAgo(hours);
  const events = scanEvents(10_000, { sinceTs }).filter((e) => e.pubkeyPrefix);

  type PlayerBucket = {
    pubkeyPrefix: string;
    firstTs: string;
    firstMode?: string;
    days: Set<string>;
    gameEvents: number;
  };

  const players = new Map<string, PlayerBucket>();

  for (const e of events) {
    const pk = e.pubkeyPrefix!;
    let bucket = players.get(pk);
    if (!bucket) {
      bucket = {
        pubkeyPrefix: pk,
        firstTs: e.ts,
        days: new Set(),
        gameEvents: 0,
      };
      players.set(pk, bucket);
    }
    if (e.ts < bucket.firstTs) bucket.firstTs = e.ts;
    bucket.days.add(e.ts.slice(0, 10));

    const isGame =
      e.event === 'client.quickmatch.started' ||
      e.event === 'challenge.run' ||
      e.event === 'deposit.paid' ||
      e.event === 'online.seat.paid';
    if (isGame && e.outcome === 'ok') {
      bucket.gameEvents++;
      if (!bucket.firstMode) {
        if (e.event === 'client.quickmatch.started') bucket.firstMode = 'quickmatch';
        else if (e.event === 'challenge.run') bucket.firstMode = 'challenge';
        else if (e.event === 'deposit.paid') bucket.firstMode = 'p2p';
        else if (e.event === 'online.seat.paid') bucket.firstMode = 'online';
      }
    }
  }

  const all = [...players.values()];
  const returning = all.filter((p) => p.days.size >= 2 && p.gameEvents > 0).length;
  const firstModeDist: Record<string, number> = {};
  for (const p of all) {
    const m = p.firstMode ?? 'unknown';
    firstModeDist[m] = (firstModeDist[m] ?? 0) + 1;
  }

  return {
    fetchedAt: new Date().toISOString(),
    window,
    tierBNote: 'Cohorts are Nostr-linked players only (pubkeyPrefix). Anonymous visitors are aggregate-only.',
    newNostrPlayers: all.filter((p) => p.gameEvents > 0).length,
    returnRate:
      all.length > 0 ? Math.round((returning / all.length) * 1000) / 10 : 0,
    returningPlayers: returning,
    firstGameModeDistribution: firstModeDist,
  };
}

export function buildChallengeDifficultySnapshot() {
  const events = scanEvents(10_000, {
    events: [
      'client.challenge.catalog_viewed',
      'client.challenge.card_clicked',
      'challenge.run',
      'client.challenge.completed',
      'challenge.claim',
    ],
  });

  const byChallenge = new Map<
    string,
    { views: number; clicks: number; runs: number; completions: number; claims: number }
  >();

  function bump(
    id: string | undefined,
    field: 'views' | 'clicks' | 'runs' | 'completions' | 'claims'
  ) {
    if (!id) return;
    let row = byChallenge.get(id);
    if (!row) {
      row = { views: 0, clicks: 0, runs: 0, completions: 0, claims: 0 };
      byChallenge.set(id, row);
    }
    (row[field])++;
  }

  for (const e of events) {
    const id =
      e.challengeId ??
      (typeof e.meta?.challengeId === 'string' ? e.meta.challengeId : undefined);
    if (e.event === 'client.challenge.catalog_viewed') bump(id, 'views');
    if (e.event === 'client.challenge.card_clicked') bump(id, 'clicks');
    if (e.event === 'challenge.run' && e.outcome === 'ok') bump(id, 'runs');
    if (e.event === 'client.challenge.completed') bump(id, 'completions');
    if (e.event === 'challenge.claim' && e.outcome === 'ok') bump(id, 'claims');
  }

  const rows = [...byChallenge.entries()]
    .map(([challengeId, row]) => ({
      challengeId,
      ...row,
      completionRate:
        row.runs >= 3 && row.runs > 0
          ? Math.round((row.completions / row.runs) * 1000) / 10
          : null,
      claimRate:
        row.runs >= 3 && row.runs > 0
          ? Math.round((row.claims / row.runs) * 1000) / 10
          : null,
    }))
    .filter((r) => r.runs >= 3)
    .sort((a, b) => (a.completionRate ?? 100) - (b.completionRate ?? 100));

  return {
    fetchedAt: new Date().toISOString(),
    challenges: rows,
    minRunsThreshold: 3,
  };
}

export function buildMoneySnapshot() {
  const challenge = getChallengeTelemetrySnapshot();
  const dailySpend = loadDailySpendSync();
  const cap = Math.max(0, Number(process.env.CHALLENGE_BOUNTY_DAILY_CAP_SATS ?? 100_000));
  const spentToday = dailySpend[todayKey()] ?? 0;
  const pending = listPendingZapClaims();

  const events = scanEvents(10_000, {
    events: ['deposit.paid', 'client.p2p.withdrawal_created', 'online.payout.withdrawal'],
  });

  const dailySpendSeries = Object.entries(dailySpend)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-7)
    .map(([day, sats]) => ({ day, sats }));

  return {
    fetchedAt: new Date().toISOString(),
    bountyCapSats: cap,
    bountySpentTodaySats: spentToday,
    bountyRemainingSats: getDailyZapBudgetRemaining(),
    bountyCapPct: cap > 0 ? Math.round((spentToday / cap) * 1000) / 10 : 0,
    dailySpendSeries,
    pendingZapClaims: pending.length,
    p2pDeposits: events.filter((e) => e.event === 'deposit.paid' && e.outcome === 'ok').length,
    p2pWithdrawals: events.filter((e) => e.event === 'client.p2p.withdrawal_created').length,
    onlinePayouts: events.filter(
      (e) => e.event === 'online.payout.withdrawal' && e.outcome === 'ok'
    ).length,
    challengeStats: {
      totalWins: challenge.totalWins,
      totalReplayFailed: challenge.totalReplayFailed,
    },
  };
}
