import { nip19 } from 'nostr-tools';
import { getAllIDtoSocket } from '../state/sessionState';
import { getAllsessionIDtoKind1s } from '../state/nostrState';
import { getChallengeTelemetrySnapshot } from '../state/challengeTelemetry';
import {
  getDailyZapBudgetRemaining,
  listPendingZapClaims,
} from '../state/challengeState';
import { loadDailySpendSync } from '../state/challengeClaimStore';
import {
  getOnlineForfeitStatus,
  getRoomById,
  getRoomBySession,
  listOnlineRooms,
  listOnlineHistoryMerged,
  ONLINE_FORFEIT_DISCONNECT_MS,
} from '../state/onlineRoomState';
import { onlineRoomPublicUrl, onlineRoomPublicUrlFromRoomId } from '../consts/gamePublicUrl';
import {
  getFunnelCountersSnapshot,
  parseFunnelCounters,
  sumCounter,
  topErrorReasons,
  topRejectReasons,
} from './funnelCounters';
import { tailChallengeClaims } from './dashboardData';
import {
  countEventsSince,
  getEventLogByteSize,
  getEventsForSession,
  getLastEventForSession,
  getRecentEvents,
  scanEvents,
  type StoredTrackEvent,
} from './eventLog';
import { pubkeyPrefix as toPubkeyPrefix } from './trackEvent';
import { getTrafficSnapshot } from './trafficAnalytics';
import { getSessionsForPubkeyPrefix } from './sessionIdentity';
import { buildChallengeDifficultySnapshot } from './dashboardAnalytics';
import { resolvePlayerIdentity, type PlayerIdentity } from './playerIdentity';
import type { OnlineSeatState } from '../types/online';
import { PlayerRole } from '../types/game';

function funnelStep(
  rows: ReturnType<typeof parseFunnelCounters>,
  event: string
): { ok: number; reject: number; error: number; total: number; passRate: number } {
  const ok = sumCounter(rows, event, 'ok');
  const reject = sumCounter(rows, event, 'reject');
  const error = sumCounter(rows, event, 'error');
  const total = ok + reject + error;
  return {
    ok,
    reject,
    error,
    total,
    passRate: total > 0 ? Math.round((ok / total) * 1000) / 10 : 0,
  };
}

function funnelStepFromEvents(
  events: StoredTrackEvent[],
  event: string
): { ok: number; reject: number; error: number; total: number; passRate: number } {
  let ok = 0;
  let reject = 0;
  let error = 0;
  for (const e of events) {
    if (e.event !== event) continue;
    if (e.outcome === 'ok') ok++;
    else if (e.outcome === 'reject') reject++;
    else if (e.outcome === 'error') error++;
  }
  const total = ok + reject + error;
  return {
    ok,
    reject,
    error,
    total,
    passRate: total > 0 ? Math.round((ok / total) * 1000) / 10 : 0,
  };
}

function topRejectReasonsFromEvents(
  events: StoredTrackEvent[],
  event: string,
  limit = 10
): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>();
  for (const e of events) {
    if (e.event !== event || e.outcome !== 'reject' || !e.reason) continue;
    counts.set(e.reason, (counts.get(e.reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function topErrorReasonsFromEvents(
  events: StoredTrackEvent[],
  event: string,
  limit = 10
): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>();
  for (const e of events) {
    if (e.event !== event || e.outcome !== 'error' || !e.reason) continue;
    counts.set(e.reason, (counts.get(e.reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function sinceHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function countDistinctSessionsSince(
  sinceTs: string,
  events: string[]
): number {
  const seen = new Set<string>();
  for (const e of scanEvents(10_000, { sinceTs, events })) {
    if (e.sessionID) seen.add(e.sessionID);
  }
  return seen.size;
}

function seatRoleLabel(role: OnlineSeatState['role']): 'p1' | 'p2' {
  return role === PlayerRole.Player1 ? 'p1' : 'p2';
}

function resolveSessionOnlineContext(sessionID: string) {
  const room = getRoomBySession(sessionID);
  if (!room) return undefined;

  for (const seat of room.seats.values()) {
    if (seat.sessionID === sessionID) {
      return {
        mode: 'online' as const,
        roomCode: room.roomCode,
        roomId: room.roomId,
        seatRole: seatRoleLabel(seat.role),
        seatStatus: seat.status,
      };
    }
  }
  if (room.spectators.has(sessionID)) {
    return {
      mode: 'online' as const,
      roomCode: room.roomCode,
      roomId: room.roomId,
      seatRole: undefined,
      seatStatus: 'spectator',
    };
  }
  return {
    mode: 'online' as const,
    roomCode: room.roomCode,
    roomId: room.roomId,
  };
}

function buildIdentity(sessionID: string): PlayerIdentity {
  return resolvePlayerIdentity({ sessionID });
}

function inferModeFromLastEvent(last?: StoredTrackEvent): 'challenge' | 'online' | 'idle' | undefined {
  if (!last) return 'idle';
  if (last.event.startsWith('challenge.')) return 'challenge';
  if (last.event.startsWith('online.')) return 'online';
  return 'idle';
}

export function buildOverviewSnapshot() {
  const rows = parseFunnelCounters(getFunnelCountersSnapshot());
  const sessions = getAllIDtoSocket();
  const activeRooms = listOnlineRooms().filter((r) => r.phase !== 'finished');
  const dailySpend = loadDailySpendSync();
  const cap = Math.max(0, Number(process.env.CHALLENGE_BOUNTY_DAILY_CAP_SATS ?? 100_000));
  const spentToday = dailySpend[todayKey()] ?? 0;
  const pendingZaps = listPendingZapClaims();
  const since24h = sinceHoursAgo(24);
  const gameActivitySessions24h = countDistinctSessionsSince(since24h, [
    'client.quickmatch.started',
    'challenge.run',
    'deposit.paid',
    'p2p.game.finished',
    'online.seat.paid',
  ]);

  return {
    fetchedAt: new Date().toISOString(),
    connectedSessions: sessions.size,
    activeOnlineRooms: activeRooms.length,
    challengeRunsTotal: sumCounter(rows, 'challenge.run', 'ok'),
    challengeRuns24h: countEventsSince(since24h, { event: 'challenge.run', outcome: 'ok' }),
    sessionsWithGameActivity24h: gameActivitySessions24h,
    metricsWindow: {
      challengeRuns: 'lifetime' as const,
      challengeRuns24h: '24h' as const,
      bounty: 'today' as const,
    },
    bountyPaidTodaySats: spentToday,
    bountyCapSats: cap,
    bountyCapPct: cap > 0 ? Math.round((spentToday / cap) * 1000) / 10 : 0,
    bountyRemainingSats: getDailyZapBudgetRemaining(),
    pendingZapClaims: pendingZaps.length,
    serverUptimeSec: Math.floor(process.uptime()),
    eventLogBytes: getEventLogByteSize(),
    traffic: getTrafficSnapshot(),
  };
}

export function buildFunnelsSnapshot() {
  return buildFunnelsSnapshotForWindow('lifetime');
}

export type FunnelWindow = 'lifetime' | '24h' | '7d';

export function buildFunnelsSnapshotForWindow(window: FunnelWindow) {
  const challengeEvents = [
    'client.challenge.catalog_viewed',
    'client.challenge.card_clicked',
    'challenge.eligibility',
    'challenge.run',
    'client.challenge.completed',
    'challenge.win.submit',
    'challenge.win.replay',
    'challenge.win.token',
    'challenge.claim',
  ];
  const onlineEvents = [
    'online.room.created',
    'online.room.joined',
    'online.room.joined_code',
    'online.room.spectate',
    'online.room.cancelled',
    'online.seat.lightning.requested',
    'online.seat.paid',
    'online.seat.ready',
    'online.arena.confirm',
    'online.game.started',
    'online.game.finished',
    'online.payout.withdrawal',
    'online.payout.nostr',
    'online.rematch.vote',
    'online.nostr.link',
  ];
  const p2pEvents = [
    'client.p2p.configured',
    'deposit.paid',
    'client.p2p.game_started',
    'p2p.game.finished',
    'client.p2p.game_completed',
    'client.p2p.withdrawal_created',
  ];
  const clientEvents = [
    'client.session.context',
    'client.menu.selected',
    'client.page.view',
    'client.funnel.abandon',
    'client.ui.error',
  ];

  if (window === 'lifetime') {
    const rows = parseFunnelCounters(getFunnelCountersSnapshot());
    return {
      fetchedAt: new Date().toISOString(),
      window,
      challenge: {
        steps: Object.fromEntries(challengeEvents.map((e) => [e, funnelStep(rows, e)])),
        topRejectReasons: {
          eligibility: topRejectReasons(rows, 'challenge.eligibility'),
          run: topRejectReasons(rows, 'challenge.run'),
          winSubmit: topRejectReasons(rows, 'challenge.win.submit'),
          claim: topRejectReasons(rows, 'challenge.claim'),
        },
      },
      online: {
        steps: Object.fromEntries(onlineEvents.map((e) => [e, funnelStep(rows, e)])),
        topRejectReasons: {
          seatPaid: topRejectReasons(rows, 'online.seat.pay_rejected'),
          joined: topRejectReasons(rows, 'online.room.joined'),
          gameStarted: topRejectReasons(rows, 'online.game.started'),
        },
      },
      p2p: {
        steps: Object.fromEntries(p2pEvents.map((e) => [e, funnelStep(rows, e)])),
      },
      client: {
        steps: Object.fromEntries(clientEvents.map((e) => [e, funnelStep(rows, e)])),
        uiErrors: [
          ...topRejectReasons(rows, 'client.ui.error'),
          ...topErrorReasons(rows, 'client.ui.error'),
        ],
      },
    };
  }

  const hours = window === '24h' ? 24 : 168;
  const sinceTs = sinceHoursAgo(hours);
  const events = scanEvents(10_000, { sinceTs });

  return {
    fetchedAt: new Date().toISOString(),
    window,
    challenge: {
      steps: Object.fromEntries(
        challengeEvents.map((e) => [e, funnelStepFromEvents(events, e)])
      ),
      topRejectReasons: {
        eligibility: topRejectReasonsFromEvents(events, 'challenge.eligibility'),
        run: topRejectReasonsFromEvents(events, 'challenge.run'),
        winSubmit: topRejectReasonsFromEvents(events, 'challenge.win.submit'),
        claim: topRejectReasonsFromEvents(events, 'challenge.claim'),
      },
    },
    online: {
      steps: Object.fromEntries(onlineEvents.map((e) => [e, funnelStepFromEvents(events, e)])),
      topRejectReasons: {
        seatPaid: topRejectReasonsFromEvents(events, 'online.seat.pay_rejected'),
        joined: topRejectReasonsFromEvents(events, 'online.room.joined'),
        gameStarted: topRejectReasonsFromEvents(events, 'online.game.started'),
      },
    },
    p2p: {
      steps: Object.fromEntries(p2pEvents.map((e) => [e, funnelStepFromEvents(events, e)])),
    },
    client: {
      steps: Object.fromEntries(clientEvents.map((e) => [e, funnelStepFromEvents(events, e)])),
      uiErrors: [
        ...topRejectReasonsFromEvents(events, 'client.ui.error'),
        ...topErrorReasonsFromEvents(events, 'client.ui.error'),
      ],
    },
  };
}

export function buildChallengesSnapshot() {
  const challenge = getChallengeTelemetrySnapshot();
  const dailySpend = loadDailySpendSync();
  const cap = Math.max(0, Number(process.env.CHALLENGE_BOUNTY_DAILY_CAP_SATS ?? 100_000));
  const spentToday = dailySpend[todayKey()] ?? 0;
  const pending = listPendingZapClaims().map((c) => ({
    pubkey: c.pubkey,
    npub: nip19.npubEncode(c.pubkey),
    pubkeyPrefix: toPubkeyPrefix(c.pubkey),
    identity: resolvePlayerIdentity({ pubkey: c.pubkey }),
    challengeId: c.challengeId,
    runId: c.runId,
    bountySats: c.bountySats,
    publishedAt: c.publishedAt,
  }));

  const recentClaims = tailChallengeClaims(30).map((row) => {
    const r = row as Record<string, unknown>;
    const pubkeyHex = typeof r.pubkey === 'string' ? r.pubkey : '';
    return {
      pubkey: pubkeyHex,
      npub: pubkeyHex ? nip19.npubEncode(pubkeyHex) : undefined,
      pubkeyPrefix: pubkeyHex ? toPubkeyPrefix(pubkeyHex) : undefined,
      identity: pubkeyHex ? resolvePlayerIdentity({ pubkey: pubkeyHex }) : undefined,
      challengeId: r.challengeId,
      runId: r.runId,
      bountySats: r.bountySats,
      zapPaidAt: r.zapPaidAt,
      publishedAt: r.publishedAt,
    };
  });

  const dailySpendSeries = Object.entries(dailySpend)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-7)
    .map(([day, sats]) => ({ day, sats }));

  const browseFunnelEvents = [
    'client.challenge.catalog_viewed',
    'client.challenge.card_clicked',
    'challenge.eligibility',
    'challenge.run',
    'client.challenge.completed',
    'challenge.claim',
  ];
  const rows = parseFunnelCounters(getFunnelCountersSnapshot());
  const browseFunnel = Object.fromEntries(
    browseFunnelEvents.map((e) => [e, funnelStep(rows, e)])
  );

  const difficulty = buildChallengeDifficultySnapshot();

  return {
    fetchedAt: new Date().toISOString(),
    stats: challenge,
    browseFunnel,
    difficulty,
    bountyCapSats: cap,
    bountySpentTodaySats: spentToday,
    bountyRemainingSats: getDailyZapBudgetRemaining(),
    dailySpendSeries,
    pendingZaps: pending,
    recentClaims,
  };
}

function serializeSeat(seat: OnlineSeatState) {
  return {
    role: seatRoleLabel(seat.role),
    sessionID: seat.sessionID,
    status: seat.status,
    paidAmount: seat.paidAmount,
    payMethod: seat.payMethod,
    name: seat.name,
    picture: seat.picture,
    pubkeyPrefix: seat.pubkey ? toPubkeyPrefix(seat.pubkey) : undefined,
    npub: seat.pubkey ? nip19.npubEncode(seat.pubkey) : undefined,
    ready: seat.ready,
    pingMs: seat.pingMs,
    forfeitRemainingMs: seat.disconnectedAt
      ? Math.max(
          0,
          ONLINE_FORFEIT_DISCONNECT_MS -
            ((seat.disconnectMs ?? 0) + (Date.now() - seat.disconnectedAt))
        )
      : undefined,
  };
}

export function buildOnlineSnapshot() {
  const now = Date.now();
  const live = listOnlineRooms().map((room) => {
    const full = getRoomById(room.roomId);
    const seats = full
      ? [...full.seats.values()].map(serializeSeat)
      : [];
    return {
      roomId: room.roomId,
      roomCode: room.roomCode,
      phase: room.phase,
      buyin: room.buyin,
      matchRound: room.matchRound,
      seatsPaid: room.playersPaid,
      seatsTotal: room.seatsTotal,
      spectators: room.spectators,
      ageMs: now - room.createdAt,
      result: room.result,
      replay: room.replay,
      seats,
      forfeit: full ? getOnlineForfeitStatus(full) : undefined,
      roomUrl: onlineRoomPublicUrl(room.roomCode),
    };
  });

  const history = listOnlineHistoryMerged()
    .filter((r) => r.archived || r.phase === 'finished' || r.phase === 'postgame')
    .slice(0, 50)
    .map((room) => ({
      roomId: room.roomId,
      roomCode: room.roomCode,
      phase: room.phase,
      buyin: room.buyin,
      matchRound: room.matchRound,
      finishedAt: room.finishedAt,
      archiveKind: room.archiveKind,
      result: room.result,
      replay: room.replay,
      roomUrl: onlineRoomPublicUrl(room.roomCode),
    }));

  return {
    fetchedAt: new Date().toISOString(),
    live,
    history,
  };
}

export function buildActivitySnapshot(params?: {
  limit?: number;
  eventPrefix?: string;
  outcome?: 'ok' | 'reject' | 'error';
  sinceTs?: string;
  sessionID?: string;
  pubkeyPrefix?: string;
  roomCode?: string;
}) {
  const limit = params?.limit ?? 100;
  const events = getRecentEvents(limit, {
    eventPrefix: params?.eventPrefix,
    outcome: params?.outcome,
    sinceTs: params?.sinceTs,
    sessionID: params?.sessionID,
    pubkeyPrefix: params?.pubkeyPrefix,
    roomCode: params?.roomCode,
  });
  return {
    fetchedAt: new Date().toISOString(),
    events: events.map((e) => ({
      ts: e.ts,
      event: e.event,
      outcome: e.outcome,
      reason: e.reason,
      sessionID: e.sessionID,
      pubkeyPrefix: e.pubkeyPrefix,
      player: resolvePlayerIdentity({
        sessionID: e.sessionID,
        pubkeyPrefix: e.pubkeyPrefix,
      }),
      challengeId: e.challengeId,
      roomId: e.roomId,
      roomCode: e.roomCode,
      source: e.source,
      meta: e.meta,
    })),
  };
}

export function buildLiveSnapshot() {
  const now = Date.now();
  const sessions = getAllIDtoSocket();
  const kind1Map = getAllsessionIDtoKind1s();

  const rows = [...sessions.entries()].map(([sessionID, session]) => {
    const identity = buildIdentity(sessionID);
    const onlineCtx = resolveSessionOnlineContext(sessionID);
    const last = getLastEventForSession(sessionID);
    const mode = onlineCtx?.mode ?? inferModeFromLastEvent(last);

    let context: {
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

    const kind1s = kind1Map.get(sessionID);
    const pageViewEvents = getEventsForSession(sessionID, 50).filter(
      (e) => e.event === 'client.page.view'
    );
    const currentRoute =
      typeof pageViewEvents[0]?.meta?.route === 'string'
        ? pageViewEvents[0].meta.route
        : undefined;

    if (onlineCtx) {
      context = {
        ...onlineCtx,
        mode: 'online',
        challengeId: last?.challengeId,
        lastEvent: last?.event,
        lastOutcome: last?.outcome,
        lastEventTs: last?.ts,
        currentRoute,
      };
    } else {
      context = {
        mode,
        challengeId: last?.challengeId,
        roomCode: last?.roomCode,
        roomId: last?.roomId,
        lastEvent: last?.event,
        lastOutcome: last?.outcome,
        lastEventTs: last?.ts,
        currentRoute,
      };
    }

    const kind1sFinal = kind1s;
    return {
      sessionID,
      connectedAtMs: now - (now - session.lastSeen),
      lastSeenMs: now - session.lastSeen,
      nostrLinked: identity.kind === 'nostr',
      identity,
      context,
      kind1Count: kind1sFinal?.length ?? 0,
    };
  });

  const inOnline = rows.filter((r) => r.context.mode === 'online').length;
  const inChallenge = rows.filter((r) => r.context.mode === 'challenge').length;

  return {
    fetchedAt: new Date().toISOString(),
    sessions: rows.sort((a, b) => b.lastSeenMs - a.lastSeenMs),
    total: rows.length,
    nostrLinked: rows.filter((r) => r.nostrLinked).length,
    inOnline,
    inChallenge,
  };
}

/** Backward-compatible alias. */
export function buildSessionsSnapshot() {
  return buildLiveSnapshot();
}

export function buildLiveSessionDetail(sessionID: string) {
  const sessions = getAllIDtoSocket();
  const session = sessions.get(sessionID);
  if (!session) return null;

  const now = Date.now();
  const identity = buildIdentity(sessionID);
  const onlineCtx = resolveSessionOnlineContext(sessionID);
  const last = getLastEventForSession(sessionID);
  const recentEvents = getEventsForSession(sessionID, 20);

  return {
    fetchedAt: new Date().toISOString(),
    sessionID,
    lastSeenMs: now - session.lastSeen,
    identity,
    context: onlineCtx
      ? { ...onlineCtx, mode: 'online' as const }
      : {
          mode: inferModeFromLastEvent(last),
          challengeId: last?.challengeId,
          roomCode: last?.roomCode,
          roomId: last?.roomId,
        },
    recentEvents: recentEvents.map((e) => ({
      ts: e.ts,
      event: e.event,
      outcome: e.outcome,
      reason: e.reason,
      challengeId: e.challengeId,
      roomCode: e.roomCode,
    })),
    roomUrl: onlineCtx?.roomCode
      ? onlineRoomPublicUrl(onlineCtx.roomCode)
      : onlineCtx?.roomId
        ? (onlineRoomPublicUrlFromRoomId(onlineCtx.roomId) ?? undefined)
        : undefined,
  };
}

const ATTEMPT_EVENTS = [
  'challenge.eligibility',
  'challenge.run',
  'online.room.joined',
  'online.seat.paid',
  'nostr.app.link',
  'client.quickmatch.started',
  'deposit.paid',
  'p2p.game.finished',
];

export function buildRecentAttemptsSnapshot(hours = 24) {
  const sinceTs = sinceHoursAgo(hours);
  const events = scanEvents(10_000, { sinceTs, events: ATTEMPT_EVENTS });
  const sessions = getAllIDtoSocket();

  type Bucket = {
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
    quickmatchStarts: number;
    p2pDeposits: number;
    rejectReasons: Map<string, number>;
  };

  const buckets = new Map<string, Bucket>();

  for (const e of events) {
    const key = e.pubkeyPrefix ?? e.sessionID ?? 'unknown';
    let bucket = buckets.get(key);
    if (!bucket) {
      const liveSessionID = e.sessionID && sessions.has(e.sessionID) ? e.sessionID : undefined;
      bucket = {
        key,
        pubkeyPrefix: e.pubkeyPrefix,
        sessionID: liveSessionID ?? e.sessionID,
        identity: resolvePlayerIdentity({
          sessionID: liveSessionID ?? e.sessionID,
          pubkeyPrefix: e.pubkeyPrefix,
        }),
        lastTs: e.ts,
        lastEvent: e.event,
        lastOutcome: e.outcome,
        lastReason: e.reason,
        challengeRuns: 0,
        onlineJoins: 0,
        nostrLinks: 0,
        quickmatchStarts: 0,
        p2pDeposits: 0,
        rejectReasons: new Map(),
      };
      buckets.set(key, bucket);
    }

    if (e.ts >= bucket.lastTs) {
      bucket.lastTs = e.ts;
      bucket.lastEvent = e.event;
      bucket.lastOutcome = e.outcome;
      bucket.lastReason = e.reason;
    }

    if (e.event === 'challenge.run' && e.outcome === 'ok') bucket.challengeRuns++;
    if (e.event === 'online.room.joined') bucket.onlineJoins++;
    if (e.event === 'nostr.app.link' && e.outcome === 'ok') bucket.nostrLinks++;
    if (e.event === 'client.quickmatch.started') bucket.quickmatchStarts++;
    if (e.event === 'deposit.paid' && e.outcome === 'ok') bucket.p2pDeposits++;
    if (e.outcome === 'reject' && e.reason) {
      bucket.rejectReasons.set(e.reason, (bucket.rejectReasons.get(e.reason) ?? 0) + 1);
    }

    if (e.sessionID && sessions.has(e.sessionID)) {
      bucket.sessionID = e.sessionID;
      bucket.identity = resolvePlayerIdentity({
        sessionID: e.sessionID,
        pubkeyPrefix: e.pubkeyPrefix ?? bucket.pubkeyPrefix,
      });
    }
  }

  const attempts = [...buckets.values()]
    .map((b) => {
      const topReject = [...b.rejectReasons.entries()].sort((a, c) => c[1] - a[1])[0];
      return {
        key: b.key,
        pubkeyPrefix: b.pubkeyPrefix,
        sessionID: b.sessionID,
        identity: resolvePlayerIdentity({
          sessionID: b.sessionID,
          pubkeyPrefix: b.pubkeyPrefix,
        }),
        lastTs: b.lastTs,
        lastEvent: b.lastEvent,
        lastOutcome: b.lastOutcome,
        lastReason: b.lastReason,
        challengeRuns: b.challengeRuns,
        onlineJoins: b.onlineJoins,
        nostrLinks: b.nostrLinks,
        quickmatchStarts: b.quickmatchStarts,
        p2pDeposits: b.p2pDeposits,
        topRejectReason: topReject?.[0],
        topRejectCount: topReject?.[1],
      };
    })
    .sort((a, b) => b.lastTs.localeCompare(a.lastTs));

  return {
    fetchedAt: new Date().toISOString(),
    hours,
    attempts,
    total: attempts.length,
  };
}

const QUICKMATCH_EVENTS = [
  'client.quickmatch.configured',
  'client.quickmatch.started',
  'client.quickmatch.completed',
];

function countByMetaKey(
  events: StoredTrackEvent[],
  eventName: string,
  metaKey: string
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of events) {
    if (e.event !== eventName) continue;
    const raw = e.meta?.[metaKey];
    const key = raw == null ? 'unknown' : String(raw);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function buildQuickMatchSnapshot() {
  const events = scanEvents(10_000, { events: QUICKMATCH_EVENTS });
  const started = events.filter((e) => e.event === 'client.quickmatch.started').length;
  const completed = events.filter((e) => e.event === 'client.quickmatch.completed').length;
  const wins = events.filter(
    (e) => e.event === 'client.quickmatch.completed' && e.meta?.clientOutcome === 'win'
  ).length;
  const durations = events
    .filter((e) => e.event === 'client.quickmatch.completed')
    .map((e) => Number(e.meta?.durationMs ?? 0))
    .filter((n) => n > 0);
  const avgDurationMs =
    durations.length > 0
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : 0;

  return {
    fetchedAt: new Date().toISOString(),
    started,
    completed,
    completionRate: started > 0 ? Math.round((completed / started) * 1000) / 10 : 0,
    winRate: completed > 0 ? Math.round((wins / completed) * 1000) / 10 : 0,
    avgDurationMs,
    byMode: countByMetaKey(events, 'client.quickmatch.configured', 'mode'),
    byOpponentType: countByMetaKey(events, 'client.quickmatch.configured', 'opponentType'),
  };
}

export function buildVisitorSnapshot(hours = 24) {
  const sinceTs = sinceHoursAgo(hours);
  const contextEvents = scanEvents(10_000, {
    sinceTs,
    events: ['client.session.context'],
  });
  const referrers: Record<string, number> = {};
  const platforms: Record<string, number> = {};
  const sessionsWithContext = new Set<string>();
  for (const e of contextEvents) {
    if (e.sessionID) sessionsWithContext.add(e.sessionID);
    const ref = e.meta?.referrer;
    if (typeof ref === 'string' && ref) {
      referrers[ref] = (referrers[ref] ?? 0) + 1;
    }
    const platform = e.meta?.platform;
    if (typeof platform === 'string' && platform) {
      platforms[platform] = (platforms[platform] ?? 0) + 1;
    }
  }

  const menuEvents = scanEvents(10_000, {
    sinceTs,
    events: ['client.menu.selected'],
  });
  const menuChoices: Record<string, number> = {};
  for (const e of menuEvents) {
    const mode = e.meta?.mode;
    if (typeof mode === 'string') {
      menuChoices[mode] = (menuChoices[mode] ?? 0) + 1;
    }
  }

  const traffic = getTrafficSnapshot();
  const gameSessions = countDistinctSessionsSince(sinceTs, [
    'client.quickmatch.started',
    'challenge.run',
    'deposit.paid',
    'online.seat.paid',
  ]);

  return {
    fetchedAt: new Date().toISOString(),
    hours,
    traffic,
    sessionsWithContext: sessionsWithContext.size,
    sessionsWithGameActivity: gameSessions,
    topReferrers: Object.entries(referrers)
      .map(([referrer, count]) => ({ referrer, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
    topPlatforms: Object.entries(platforms)
      .map(([platform, count]) => ({ platform, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
    menuChoices,
  };
}

export function buildP2pSnapshot() {
  const events = scanEvents(10_000, {
    events: [
      'client.p2p.configured',
      'deposit.paid',
      'client.p2p.game_started',
      'p2p.game.finished',
      'client.p2p.game_completed',
      'client.p2p.withdrawal_created',
      'client.p2p.double_or_nothing',
    ],
  });
  const step = (name: string) => events.filter((e) => e.event === name).length;
  return {
    fetchedAt: new Date().toISOString(),
    configured: step('client.p2p.configured'),
    depositsPaid: events.filter((e) => e.event === 'deposit.paid' && e.outcome === 'ok').length,
    gameStarted: step('client.p2p.game_started'),
    gameFinished: step('p2p.game.finished'),
    gameCompletedClient: step('client.p2p.game_completed'),
    withdrawals: step('client.p2p.withdrawal_created'),
    doubleOrNothing: step('client.p2p.double_or_nothing'),
    byMode: countByMetaKey(events, 'client.p2p.configured', 'mode'),
  };
}

export function buildReplaySnapshot() {
  const events = scanEvents(10_000, {
    events: [
      'client.online.replay_started',
      'client.online.replay_ended',
      'client.online.spectate_started',
    ],
  });
  const started = events.filter((e) => e.event === 'client.online.replay_started');
  const ended = events.filter((e) => e.event === 'client.online.replay_ended');
  const durations = ended
    .map((e) => Number(e.meta?.durationMs ?? 0))
    .filter((n) => n > 0);
  const byRoom: Record<string, number> = {};
  for (const e of started) {
    const code = e.roomCode ?? (typeof e.meta?.roomCode === 'string' ? e.meta.roomCode : undefined);
    if (code) byRoom[code] = (byRoom[code] ?? 0) + 1;
  }
  return {
    fetchedAt: new Date().toISOString(),
    replayStarts: started.length,
    replayEnds: ended.length,
    spectateStarts: events.filter((e) => e.event === 'client.online.spectate_started').length,
    avgWatchDurationMs:
      durations.length > 0
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : 0,
    topRooms: Object.entries(byRoom)
      .map(([roomCode, count]) => ({ roomCode, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15),
  };
}

export function buildUserJourneySnapshot(params: {
  sessionID?: string;
  pubkey?: string;
}) {
  const limit = 500;
  let sessionIDs: string[] = [];
  let pubkeyPrefix: string | undefined;

  if (params.sessionID?.trim()) {
    sessionIDs = [params.sessionID.trim()];
  } else if (params.pubkey?.trim()) {
    const raw = params.pubkey.trim().toLowerCase();
    if (raw.startsWith('npub')) {
      try {
        const decoded = nip19.decode(raw);
        if (decoded.type === 'npub') {
          pubkeyPrefix = toPubkeyPrefix(decoded.data as string);
        }
      } catch {
        pubkeyPrefix = undefined;
      }
    } else if (/^[0-9a-f]{64}$/.test(raw)) {
      pubkeyPrefix = toPubkeyPrefix(raw);
    } else {
      pubkeyPrefix = raw.slice(0, 12);
    }
    if (pubkeyPrefix) {
      sessionIDs = getSessionsForPubkeyPrefix(pubkeyPrefix);
    }
  }

  const events: StoredTrackEvent[] = [];
  if (sessionIDs.length > 0) {
    for (const sid of sessionIDs) {
      events.push(...getEventsForSession(sid, 200));
    }
  } else if (pubkeyPrefix) {
    events.push(
      ...scanEvents(limit, { pubkeyPrefix }).filter(
        (e) => e.pubkeyPrefix === pubkeyPrefix
      )
    );
  }

  const timeline = [...events]
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .slice(-200)
    .map((e) => ({
      ts: e.ts,
      event: e.event,
      outcome: e.outcome,
      reason: e.reason,
      sessionID: e.sessionID,
      challengeId: e.challengeId,
      roomCode: e.roomCode,
      meta: e.meta,
    }));

  let identity: PlayerIdentity | undefined;
  if (sessionIDs.length > 0) {
    for (const sid of sessionIDs) {
      const resolved = resolvePlayerIdentity({ sessionID: sid });
      if (resolved.kind === 'nostr') {
        identity = resolved;
        break;
      }
    }
    if (!identity) {
      identity = resolvePlayerIdentity({ sessionID: sessionIDs[0] });
    }
  } else if (pubkeyPrefix) {
    identity = resolvePlayerIdentity({ pubkeyPrefix });
  }

  return {
    fetchedAt: new Date().toISOString(),
    sessionIDs,
    pubkeyPrefix,
    identity,
    eventCount: timeline.length,
    timeline,
  };
}
