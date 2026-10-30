import { Router, Request, Response } from 'express';
import path from 'path';
import express from 'express';
import { getAllIDtoSocket } from '../state/sessionState';
import { getAllIDtoLNURLW, getAllLNURLWtoID } from '../state/lnurlwState';
import { getAllIDtoLNURLPs, getAllLNURLPtoID } from '../state/lnurlpState';
import { getSerializedIDToGameInfo } from '../state/gameState';
import {
  getAllkind1IDtoSessionID,
  getAllsessionIDtoKind1s,
} from '../state/nostrState';
import { getChallengeTelemetrySnapshot } from '../state/challengeTelemetry';
import { getFunnelCountersSnapshot } from '../telemetry/funnelCounters';
import {
  tailChallengeClaims,
  tailOnlineArchiveIndex,
} from '../telemetry/dashboardData';
import { listOnlineRooms } from '../state/onlineRoomState';
import {
  buildActivitySnapshot,
  buildChallengesSnapshot,
  buildFunnelsSnapshotForWindow,
  buildLiveSessionDetail,
  buildLiveSnapshot,
  buildOnlineSnapshot,
  buildOverviewSnapshot,
  buildP2pSnapshot,
  buildQuickMatchSnapshot,
  buildRecentAttemptsSnapshot,
  buildReplaySnapshot,
  buildUserJourneySnapshot,
  buildVisitorSnapshot,
  type FunnelWindow,
} from '../telemetry/dashboardSnapshot';
import {
  buildAlertsSnapshot,
  buildCohortSnapshot,
  buildHomeSnapshot,
  buildModeFunnelSnapshot,
  buildMoneySnapshot,
  type AnalyticsWindow,
  type FunnelMode,
} from '../telemetry/dashboardAnalytics';
import { fetchNostrAppProfile } from '../calls/nostr/fetchNostrAppProfile';
import { resolvePlayerIdentity } from '../telemetry/playerIdentity';
import { rememberPubkeyPrefix } from '../telemetry/pubkeyPrefixLookup';
import {
  handleDashboardLogin,
  handleDashboardLogout,
  isDashboardAuthenticated,
  isDashboardDebugRawEnabled,
  requireDashboardAuth,
} from './dashboardAuth';

const router = Router();

const adminDir = path.join(__dirname, '../../public/admin');

function summarizeActiveOnlineRooms() {
  const now = Date.now();
  return listOnlineRooms().map((room) => ({
    roomId: room.roomId,
    roomCode: room.roomCode,
    phase: room.phase,
    buyin: room.buyin,
    seatsPaid: room.playersPaid ?? 0,
    seatsTotal: room.seatsTotal,
    ageMs: now - room.createdAt,
  }));
}

function buildLegacyRawDump() {
  const IDtoSocket = Object.fromEntries(getAllIDtoSocket());
  const IDToLNURLW = Object.fromEntries(getAllIDtoLNURLW());
  const LNURLWToID = Object.fromEntries(getAllLNURLWtoID());
  const LNURLPToID = Object.fromEntries(getAllLNURLPtoID());
  const IDToLNURLPs = Object.fromEntries(getAllIDtoLNURLPs());
  const kind1IDtoSessionID = Object.fromEntries(getAllkind1IDtoSessionID());
  const sessionIDtoKind1s = Object.fromEntries(getAllsessionIDtoKind1s());
  const IDtoGameInfo = getSerializedIDToGameInfo();
  return {
    IDtoSocket,
    IDToLNURLW,
    LNURLWToID,
    LNURLPToID,
    IDToLNURLPs,
    kind1IDtoSessionID,
    sessionIDtoKind1s,
    IDtoGameInfo,
    telemetry: {
      counters: getFunnelCountersSnapshot(),
      challenge: getChallengeTelemetrySnapshot(),
      recentClaims: tailChallengeClaims(20),
      recentOnline: tailOnlineArchiveIndex(20),
      activeOnlineRooms: summarizeActiveOnlineRooms(),
    },
  };
}

router.post('/api/login', handleDashboardLogin);
router.post('/api/logout', handleDashboardLogout);

router.get('/api/me', (req, res) => {
  res.json({ authenticated: isDashboardAuthenticated(req) });
});

router.get('/api/overview', requireDashboardAuth, (_req, res) => {
  res.json(buildOverviewSnapshot());
});

router.get('/api/home', requireDashboardAuth, (req, res) => {
  const window =
    req.query.window === '7d' ? ('7d' as AnalyticsWindow) : ('24h' as AnalyticsWindow);
  res.json(buildHomeSnapshot(window));
});

router.get('/api/alerts', requireDashboardAuth, (req, res) => {
  const window =
    req.query.window === '7d' ? ('7d' as AnalyticsWindow) : ('24h' as AnalyticsWindow);
  res.json(buildAlertsSnapshot(window));
});

router.get('/api/money', requireDashboardAuth, (_req, res) => {
  res.json(buildMoneySnapshot());
});

router.get('/api/cohorts', requireDashboardAuth, (req, res) => {
  const window = req.query.window === '24h' ? '24h' : '7d';
  res.json(buildCohortSnapshot(window as '24h' | '7d'));
});

const FUNNEL_MODES: FunnelMode[] = ['quickmatch', 'challenge', 'p2p', 'online', 'nostr'];

router.get('/api/funnels/:mode', requireDashboardAuth, (req, res) => {
  const mode = req.params.mode as FunnelMode;
  if (!FUNNEL_MODES.includes(mode)) {
    res.status(400).json({ error: 'invalid_mode' });
    return;
  }
  const window =
    req.query.window === '7d' ? ('7d' as AnalyticsWindow) : ('24h' as AnalyticsWindow);
  res.json(buildModeFunnelSnapshot(mode, window));
});

router.get('/api/funnels', requireDashboardAuth, (req, res) => {
  const window =
    req.query.window === '24h' || req.query.window === '7d' || req.query.window === 'lifetime'
      ? (req.query.window as FunnelWindow)
      : 'lifetime';
  res.json(buildFunnelsSnapshotForWindow(window));
});

router.get('/api/challenges', requireDashboardAuth, (_req, res) => {
  res.json(buildChallengesSnapshot());
});

router.get('/api/online', requireDashboardAuth, (_req, res) => {
  res.json(buildOnlineSnapshot());
});

router.get('/api/activity', requireDashboardAuth, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 200);
  const eventPrefix =
    typeof req.query.event === 'string' ? req.query.event : undefined;
  const outcome =
    req.query.outcome === 'ok' || req.query.outcome === 'reject' || req.query.outcome === 'error'
      ? req.query.outcome
      : undefined;
  const sessionID =
    typeof req.query.sessionID === 'string' ? req.query.sessionID : undefined;
  const pubkeyPrefix =
    typeof req.query.pubkeyPrefix === 'string' ? req.query.pubkeyPrefix : undefined;
  const roomCode =
    typeof req.query.roomCode === 'string' ? req.query.roomCode : undefined;
  let sinceTs: string | undefined;
  if (req.query.since === '1h') {
    sinceTs = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  } else if (req.query.since === '24h') {
    sinceTs = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  } else if (req.query.since === '7d') {
    sinceTs = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  } else if (typeof req.query.sinceTs === 'string') {
    sinceTs = req.query.sinceTs;
  }
  res.json(
    buildActivitySnapshot({
      limit,
      eventPrefix,
      outcome,
      sinceTs,
      sessionID,
      pubkeyPrefix,
      roomCode,
    })
  );
});

router.get('/api/live', requireDashboardAuth, (_req, res) => {
  res.json(buildLiveSnapshot());
});

router.get('/api/live/recent', requireDashboardAuth, (req, res) => {
  const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 168);
  res.json(buildRecentAttemptsSnapshot(hours));
});

router.get('/api/live/:sessionID', requireDashboardAuth, (req, res) => {
  const sessionID = req.params.sessionID;
  if (typeof sessionID !== 'string') {
    res.status(400).json({ error: 'invalid_session' });
    return;
  }
  const detail = buildLiveSessionDetail(sessionID);
  if (!detail) {
    res.status(404).json({ error: 'session_not_connected' });
    return;
  }
  res.json(detail);
});

router.get('/api/visitors', requireDashboardAuth, (req, res) => {
  const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 168);
  res.json(buildVisitorSnapshot(hours));
});

router.get('/api/quickmatch', requireDashboardAuth, (_req, res) => {
  res.json(buildQuickMatchSnapshot());
});

router.get('/api/p2p', requireDashboardAuth, (_req, res) => {
  res.json(buildP2pSnapshot());
});

router.get('/api/replays', requireDashboardAuth, (_req, res) => {
  res.json(buildReplaySnapshot());
});

const resolveRateBuckets = new Map<string, { count: number; resetAt: number }>();

router.post('/api/players/resolve', requireDashboardAuth, async (req, res) => {
  const rlKey = req.ip ?? 'dashboard';
  const now = Date.now();
  let bucket = resolveRateBuckets.get(rlKey);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + 60_000 };
    resolveRateBuckets.set(rlKey, bucket);
  }
  if (bucket.count >= 30) {
    res.status(429).json({ error: 'rate_limited' });
    return;
  }
  bucket.count++;

  const items = req.body?.items;
  if (!Array.isArray(items) || items.length === 0 || items.length > 20) {
    res.status(400).json({ error: 'invalid_items' });
    return;
  }

  const identities = [];
  for (const item of items) {
    const pubkey =
      typeof item?.pubkey === 'string' ? item.pubkey.trim().toLowerCase() : undefined;
    const pubkeyPrefix =
      typeof item?.pubkeyPrefix === 'string' ? item.pubkeyPrefix.trim().toLowerCase() : undefined;
    const fullPk =
      pubkey && /^[0-9a-f]{64}$/.test(pubkey) ? pubkey : undefined;
    if (fullPk) {
      rememberPubkeyPrefix(fullPk);
      try {
        await fetchNostrAppProfile(fullPk);
      } catch {
        // keep cached / fallback identity
      }
      identities.push(resolvePlayerIdentity({ pubkey: fullPk, pubkeyPrefix }));
      continue;
    }
    if (pubkeyPrefix) {
      identities.push(resolvePlayerIdentity({ pubkeyPrefix }));
      continue;
    }
    identities.push({ kind: 'anon' as const });
  }

  res.json({ identities });
});

router.get('/api/journey', requireDashboardAuth, (req, res) => {
  const sessionID =
    typeof req.query.sessionID === 'string' ? req.query.sessionID : undefined;
  const pubkey =
    typeof req.query.pubkey === 'string' ? req.query.pubkey : undefined;
  if (!sessionID && !pubkey) {
    res.status(400).json({ error: 'sessionID_or_pubkey_required' });
    return;
  }
  res.json(buildUserJourneySnapshot({ sessionID, pubkey }));
});

router.get('/api/sessions', requireDashboardAuth, (_req, res) => {
  res.json(buildLiveSnapshot());
});

router.get('/api/debug/raw', (req, res, next) => {
  if (!isDashboardDebugRawEnabled()) {
    res.status(404).json({ error: { message: 'Not Found' } });
    return;
  }
  requireDashboardAuth(req, res, next);
}, (_req, res) => {
  res.json(buildLegacyRawDump());
});

router.get('/', (_req: Request, res: Response) => {
  res.sendFile(path.join(adminDir, 'index.html'), (err) => {
    if (err) {
      res.status(503).send(
        'Admin UI not built. Run: npm run build:admin'
      );
    }
  });
});

router.use(express.static(adminDir));

export default router;
