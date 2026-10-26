import { useCallback, useEffect, useState } from 'react';
import {
  checkAuth,
  fetchActivity,
  fetchAlerts,
  fetchChallenges,
  fetchCohorts,
  fetchHome,
  fetchLive,
  fetchLiveRecent,
  fetchFunnels,
  fetchModeFunnel,
  fetchMoney,
  fetchOnline,
  fetchP2p,
  fetchQuickMatch,
  fetchReplays,
  logout,
  type ActivityFilters,
  type DashboardAlert,
} from './lib/api';
import { usePolling } from './lib/hooks';
import { PLAY_MODES, type PlayMode } from './lib/labels';
import { LoginScreen } from './components/LoginScreen';
import { NowView } from './components/NowView';
import { PlayView } from './components/PlayView';
import { PeopleView } from './components/PeopleView';
import { MoneyTab } from './components/MoneyTab';
import { ActivityTab } from './components/ActivityTab';
import { ChainDuelHeader } from './components/ChainDuelHeader';
import { ErrorBanner, LoadingState } from './components/ui';

type Tab = 'now' | 'play' | 'people' | 'money' | 'log';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'now', label: 'Now' },
  { id: 'play', label: 'Play' },
  { id: 'people', label: 'People' },
  { id: 'money', label: 'Money' },
  { id: 'log', label: 'Log' },
];

const LEGACY_TAB_MAP: Record<string, Tab> = {
  home: 'now',
  overview: 'now',
  visitors: 'now',
  players: 'people',
  live: 'people',
  explorer: 'people',
  modes: 'play',
  funnels: 'play',
  challenge: 'play',
  quickmatch: 'play',
  p2p: 'play',
  online: 'play',
  debug: 'log',
  activity: 'log',
};

function parseTabFromUrl(): Tab {
  const raw = new URLSearchParams(window.location.search).get('tab');
  if (raw && TABS.some((t) => t.id === raw)) return raw as Tab;
  if (raw && LEGACY_TAB_MAP[raw]) return LEGACY_TAB_MAP[raw];
  return 'now';
}

function parseModeFromUrl(): PlayMode {
  const mode = new URLSearchParams(window.location.search).get('mode');
  if (mode && PLAY_MODES.includes(mode as PlayMode)) return mode as PlayMode;
  return 'quickmatch';
}

function parseWindowFromUrl(): '24h' | '7d' {
  return new URLSearchParams(window.location.search).get('window') === '7d' ? '7d' : '24h';
}

function parseActivityFiltersFromUrl(): ActivityFilters {
  const params = new URLSearchParams(window.location.search);
  const since = params.get('since');
  return {
    event: params.get('event') ?? undefined,
    outcome: params.get('outcome') ?? undefined,
    sessionID: params.get('sessionID') ?? undefined,
    pubkeyPrefix: params.get('pubkeyPrefix') ?? undefined,
    roomCode: params.get('roomCode') ?? undefined,
    since: since === '1h' || since === '24h' || since === '7d' ? since : undefined,
  };
}

function syncUrl(tab: Tab, extras?: Record<string, string | undefined>) {
  const params = new URLSearchParams();
  params.set('tab', tab);
  if (extras) {
    for (const [k, v] of Object.entries(extras)) {
      if (v) params.set(k, v);
    }
  }
  window.history.replaceState(null, '', `?${params.toString()}`);
}

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [tab, setTab] = useState<Tab>(() => parseTabFromUrl());
  const [mode, setMode] = useState<PlayMode>(() => parseModeFromUrl());
  const [playWindow, setPlayWindow] = useState<'24h' | '7d'>(() => parseWindowFromUrl());
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [activityFilters, setActivityFilters] = useState<ActivityFilters>(() =>
    parseActivityFiltersFromUrl()
  );
  const [selectedSession, setSelectedSession] = useState<string | null>(() => {
    return new URLSearchParams(window.location.search).get('session');
  });
  const [explorerQuery, setExplorerQuery] = useState<string | undefined>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('session') ?? params.get('pubkey') ?? undefined;
  });
  const [explorerKind, setExplorerKind] = useState<'sessionID' | 'pubkey'>(() =>
    new URLSearchParams(window.location.search).get('pubkey') ? 'pubkey' : 'sessionID'
  );

  useEffect(() => {
    void checkAuth().then(setAuthed);
  }, []);

  const poll = autoRefresh && authed === true;
  const onNow = authed === true && tab === 'now';
  const onPlay = authed === true && tab === 'play';
  const onPeople = authed === true && tab === 'people';
  const onMoney = authed === true && tab === 'money';
  const onLog = authed === true && tab === 'log';

  const alerts = usePolling(() => fetchAlerts('24h'), onNow, onNow && poll, 20000);
  const live = usePolling(fetchLive, onNow || onPeople, (onNow || onPeople) && poll, 20000);
  const needOnline = onNow || (onPlay && mode === 'online');
  const online = usePolling(fetchOnline, needOnline, needOnline && poll, 20000);
  const recent = usePolling(() => fetchLiveRecent(24), onPeople, onPeople && poll, 30000);
  const cohorts = usePolling(
    () => fetchCohorts('7d'),
    onPlay || onPeople,
    (onPlay || onPeople) && poll,
    60000
  );

  const homeFetcher = useCallback(() => fetchHome(playWindow), [playWindow]);
  const home = usePolling(homeFetcher, onPlay, onPlay && poll, 20000);
  const funnelFetcher = useCallback(
    () => fetchModeFunnel(mode, playWindow),
    [mode, playWindow]
  );
  const funnel = usePolling(funnelFetcher, onPlay, onPlay && poll, 20000);
  const funnelsFetcher = useCallback(() => fetchFunnels(playWindow), [playWindow]);
  const funnels = usePolling(funnelsFetcher, onPlay, onPlay && poll, 30000);
  const challenges = usePolling(
    fetchChallenges,
    (onPlay && mode === 'challenge') || onMoney,
    ((onPlay && mode === 'challenge') || onMoney) && poll,
    20000
  );
  const quickmatch = usePolling(
    fetchQuickMatch,
    onPlay && mode === 'quickmatch',
    onPlay && mode === 'quickmatch' && poll,
    20000
  );
  const p2p = usePolling(fetchP2p, onPlay && mode === 'p2p', onPlay && mode === 'p2p' && poll, 20000);
  const replays = usePolling(
    fetchReplays,
    onPlay && mode === 'online',
    onPlay && mode === 'online' && poll,
    30000
  );
  const money = usePolling(fetchMoney, onMoney, onMoney && poll, 20000);

  const activityFetcher = useCallback(
    () => fetchActivity({ limit: 100, ...activityFilters }),
    [activityFilters]
  );
  const activity = usePolling(activityFetcher, onLog, onLog && poll, 15000);

  useEffect(() => {
    if (onPlay) {
      void home.refresh();
      void funnels.refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playWindow, onPlay]);

  useEffect(() => {
    if (onPlay) void funnel.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, playWindow, onPlay]);

  useEffect(() => {
    if (onLog) void activity.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activityFilters, onLog]);

  const goToLog = useCallback((partial: Partial<ActivityFilters>) => {
    const filters: ActivityFilters = { since: '24h', ...partial };
    setActivityFilters(filters);
    setTab('log');
    syncUrl('log', {
      event: filters.event,
      outcome: filters.outcome,
      since: filters.since,
      sessionID: filters.sessionID,
      pubkeyPrefix: filters.pubkeyPrefix,
      roomCode: filters.roomCode,
    });
  }, []);

  const goToPlay = useCallback((nextMode: PlayMode) => {
    setMode(nextMode);
    setTab('play');
    syncUrl('play', { mode: nextMode, window: playWindow });
  }, [playWindow]);

  const goToPeople = useCallback((query?: string, kind: 'sessionID' | 'pubkey' = 'sessionID') => {
    if (query) {
      setExplorerQuery(query);
      setExplorerKind(kind);
    }
    setTab('people');
    syncUrl('people', query ? { [kind === 'sessionID' ? 'session' : 'pubkey']: query } : undefined);
  }, []);

  const handleAlertClick = useCallback(
    (alert: DashboardAlert) => {
      const d = alert.drillDown;
      if (!d) return;
      if (d.tab === 'money') {
        setTab('money');
        syncUrl('money');
      } else if ((d.tab === 'modes' || d.tab === 'play') && d.mode && PLAY_MODES.includes(d.mode as PlayMode)) {
        goToPlay(d.mode as PlayMode);
      } else if ((d.tab === 'debug' || d.tab === 'log') && d.event) {
        goToLog({ event: d.event, since: '24h' });
      }
    },
    [goToLog, goToPlay]
  );

  const activePoll =
    tab === 'now'
      ? live
      : tab === 'play'
        ? home
        : tab === 'people'
          ? recent
          : tab === 'money'
            ? money
            : activity;

  const handleLogout = async () => {
    await logout();
    setAuthed(false);
  };

  if (authed === null) {
    return (
      <div className="flex min-h-screen items-center justify-center text-white/50">
        <LoadingState />
      </div>
    );
  }

  if (!authed) {
    return <LoginScreen onSuccess={() => setAuthed(true)} />;
  }

  const showBody =
    (tab === 'now' && live.data) ||
    (tab === 'play' && home.data) ||
    (tab === 'people' && (recent.data || live.data)) ||
    (tab === 'money' && money.data) ||
    (tab === 'log' && activity.data);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-surface-border bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-3">
          <ChainDuelHeader subtitle="Ops" />
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-2 text-zinc-400">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                className="rounded border-surface-border"
              />
              Live
            </label>
            <span className="text-zinc-500">
              {activePoll.data?.fetchedAt
                ? new Date(activePoll.data.fetchedAt).toLocaleTimeString()
                : '—'}
            </span>
            <button
              type="button"
              onClick={() => void activePoll.refresh()}
              className="rounded border border-surface-border px-2 py-1 text-zinc-300 hover:border-accent hover:text-accent"
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={() => void handleLogout()}
              className="rounded border border-surface-border px-2 py-1 text-zinc-500 hover:text-zinc-300"
            >
              Log out
            </button>
          </div>
        </div>
        <nav className="mx-auto flex max-w-6xl gap-6 overflow-x-auto px-4">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                setTab(t.id);
                if (t.id === 'play') syncUrl('play', { mode, window: playWindow });
                else if (t.id === 'log') {
                  syncUrl('log', {
                    event: activityFilters.event,
                    since: activityFilters.since,
                    sessionID: activityFilters.sessionID,
                  });
                } else if (t.id === 'now') syncUrl('now', { session: selectedSession ?? undefined });
                else syncUrl(t.id);
              }}
              className={`whitespace-nowrap border-b-2 px-1 py-2.5 text-sm font-medium transition ${
                tab === t.id
                  ? 'border-accent text-accent'
                  : 'border-transparent text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">
        {activePoll.error ? <ErrorBanner message={activePoll.error} /> : null}
        {activePoll.loading && !activePoll.data ? (
          <LoadingState />
        ) : showBody ? (
          <>
            {tab === 'now' && live.data ? (
              <NowView
                live={live.data}
                online={online.data}
                alerts={alerts.data?.alerts ?? []}
                selectedSession={selectedSession}
                onSelectSession={(sessionID) => {
                  setSelectedSession(sessionID);
                  syncUrl('now', { session: sessionID ?? undefined });
                }}
                onAlertClick={handleAlertClick}
                onViewActivity={(sessionID) => goToLog({ sessionID, since: '24h' })}
              />
            ) : null}
            {tab === 'play' && home.data ? (
              <PlayView
                home={home.data}
                window={playWindow}
                onWindowChange={(next) => {
                  setPlayWindow(next);
                  syncUrl('play', { mode, window: next });
                }}
                mode={mode}
                onModeChange={(next) => {
                  setMode(next);
                  syncUrl('play', { mode: next, window: playWindow });
                }}
                funnel={funnel.data}
                challenges={challenges.data ?? undefined}
                quickmatch={quickmatch.data ?? undefined}
                p2p={p2p.data ?? undefined}
                replays={replays.data ?? undefined}
                online={online.data}
                funnels={funnels.data}
                cohorts={cohorts.data}
                onStepClick={(event) => goToLog({ event, since: playWindow === '7d' ? '7d' : '24h' })}
              />
            ) : null}
            {tab === 'people' ? (
              <PeopleView
                live={live.data}
                recent={recent.data}
                cohorts={cohorts.data}
                initialQuery={explorerQuery}
                initialKind={explorerKind}
              />
            ) : null}
            {tab === 'money' && money.data ? (
              <MoneyTab data={money.data} challenges={challenges.data ?? undefined} />
            ) : null}
            {tab === 'log' && activity.data ? (
              <div className="space-y-4">
                <p className="max-w-2xl text-sm text-zinc-400">
                  The raw sequence. Open it after a leak or a player path points at one event.
                </p>
                <ActivityTab
                  data={activity.data}
                  filters={activityFilters}
                  onFilterChange={(filters) => {
                    setActivityFilters(filters);
                    syncUrl('log', {
                      event: filters.event,
                      outcome: filters.outcome,
                      since: filters.since,
                      sessionID: filters.sessionID,
                      pubkeyPrefix: filters.pubkeyPrefix,
                      roomCode: filters.roomCode,
                    });
                  }}
                  onSessionClick={(sessionID) => goToPeople(sessionID, 'sessionID')}
                />
              </div>
            ) : null}
          </>
        ) : null}
      </main>
    </div>
  );
}
