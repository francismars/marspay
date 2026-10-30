import type {
  ChallengesData,
  CohortData,
  FunnelsData,
  HomeData,
  ModeFunnelData,
  OnlineData,
  OnlineHistoryRow,
  P2pData,
  QuickMatchData,
  ReplayData,
} from '../lib/api';
import { formatTs } from '../lib/hooks';
import { MODE_STORY, type PlayMode } from '../lib/labels';
import { CountBars, FunnelBars, RateBars } from './viz/Bars';
import { Section } from './ui';
import { SubNav } from './SubNav';

function finishedMatches(online: OnlineData | null | undefined): OnlineHistoryRow[] {
  const history = online?.history ?? [];
  const matches = history.filter((row) => row.archiveKind === 'match');
  return (matches.length > 0 ? matches : history).slice(0, 6);
}

function replayRejects(challenges: ChallengesData | undefined): Array<{ label: string; count: number }> {
  const totals = new Map<string, number>();
  for (const row of Object.values(challenges?.stats.byChallenge ?? {})) {
    for (const [reason, count] of Object.entries(row.replayReasons ?? {})) {
      totals.set(reason, (totals.get(reason) ?? 0) + count);
    }
  }
  return [...totals.entries()]
    .map(([label, count]) => ({ label: label.replace(/_/g, ' '), count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
}

function matchSummary(row: OnlineHistoryRow): string {
  const result = row.result;
  if (!result) return row.phase;
  const duration =
    row.replay?.durationMs && row.replay.durationMs > 0
      ? ` · ${Math.round(row.replay.durationMs / 1000)}s`
      : '';
  if (result.outcome === 'abandoned') {
    const kept = (result.p1Paid ?? 0) + (result.p2Paid ?? 0);
    return `Abandoned · ${kept.toLocaleString()} sats kept${duration}`;
  }
  if (result.outcome === 'unclaimed') {
    return `Unclaimed · ${result.winnerName} · ${result.netPrize.toLocaleString()} sats${duration}`;
  }
  const via = result.outcome === 'forfeit' ? ' by forfeit' : '';
  return `${result.winnerName} won${via} ${result.p1Score}–${result.p2Score} · ${result.netPrize.toLocaleString()} sats net${duration}`;
}

function sortedCounts(record: Record<string, number> | undefined): Array<{ label: string; count: number }> {
  if (!record) return [];
  return Object.entries(record)
    .map(([label, count]) => ({ label: label.replace(/_/g, ' '), count }))
    .sort((a, b) => b.count - a.count);
}

export function PlayView({
  home,
  window,
  onWindowChange,
  mode,
  onModeChange,
  funnel,
  challenges,
  quickmatch,
  p2p,
  replays,
  online,
  funnels,
  cohorts,
  onStepClick,
}: {
  home: HomeData;
  window: '24h' | '7d';
  onWindowChange: (w: '24h' | '7d') => void;
  mode: PlayMode;
  onModeChange: (m: PlayMode) => void;
  funnel: ModeFunnelData | null;
  challenges?: ChallengesData;
  quickmatch?: QuickMatchData;
  p2p?: P2pData;
  replays?: ReplayData;
  online?: OnlineData | null;
  funnels?: FunnelsData | null;
  cohorts?: CohortData | null;
  onStepClick?: (event: string) => void;
}) {
  const story = MODE_STORY[mode];
  const dropStep =
    funnel && funnel.biggestDropIndex > 0 ? funnel.steps[funnel.biggestDropIndex] : undefined;
  const reasons = dropStep ? (funnel?.rejectReasons?.[dropStep.event] ?? []).slice(0, 5) : [];

  const menu = Object.entries(home.acquisition.menuChoices)
    .map(([label, count]) => ({ label: label.replace(/_/g, ' '), count }))
    .sort((a, b) => b.count - a.count);

  const difficulty = (challenges?.difficulty?.challenges ?? []).filter(
    (c) => c.runs >= (challenges?.difficulty?.minRunsThreshold ?? 1)
  );

  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <p className="max-w-2xl text-sm text-zinc-400">
          A session counts as activated when someone starts a quick match, a challenge run, a P2P
          deposit, or an ONLINE seat. The bars below are the share who finish that mode, not raw
          traffic.
        </p>
        <SubNav
          items={[
            { id: '24h', label: 'Last 24 hours' },
            { id: '7d', label: 'Last 7 days' },
          ]}
          active={window}
          onChange={onWindowChange}
        />
      </div>

      <section className="panel rounded-lg p-5">
        <p className="text-xs font-medium tracking-wide text-zinc-500 uppercase">Played something</p>
        <p className="mt-2 font-display text-4xl text-zinc-100">{home.activation.rate}%</p>
        <p className="mt-2 text-sm text-zinc-400">
          {home.activation.sessionsWithGame.toLocaleString()} of{' '}
          {home.activation.uniqueSessions.toLocaleString()} sessions in this window actually entered
          a game.
          {home.activation.trend?.deltaPct != null
            ? ` ${home.activation.trend.deltaPct > 0 ? 'Up' : 'Down'} ${Math.abs(home.activation.trend.deltaPct)}% versus the previous window.`
            : ''}
        </p>
      </section>

      <Section
        title="Do they finish?"
        description="Click a mode to see the path. The number is the finish rate described under each name."
      >
        <RateBars
          active={mode}
          onSelect={(id) => onModeChange(id as PlayMode)}
          rows={home.modeMetrics.map((m) => ({
            id: m.mode,
            label: MODE_STORY[m.mode as PlayMode]?.name ?? m.label,
            rate: m.rate,
            detail: `${m.numerator}/${m.denominator}`,
          }))}
        />
        <button
          type="button"
          onClick={() => onModeChange('nostr')}
          className={`mt-3 text-sm ${mode === 'nostr' ? 'text-accent' : 'text-zinc-500 hover:text-zinc-300'}`}
        >
          Nostr sign-in path
        </button>
      </Section>

      <Section title={story.name} description={story.finishes}>
        {funnel ? (
          <FunnelBars
            steps={funnel.steps}
            biggestDropIndex={funnel.biggestDropIndex}
            onStepClick={onStepClick ? (step) => onStepClick(step.event) : undefined}
          />
        ) : (
          <p className="text-sm text-zinc-500">Loading this path…</p>
        )}
        {funnel?.derived?.paymentAbandoned && funnel.derived.paymentAbandoned.requested > 0 ? (
          <p className="text-sm text-zinc-400">
            {funnel.derived.paymentAbandoned.abandoned} of{' '}
            {funnel.derived.paymentAbandoned.requested} seat invoices were still unpaid after 15
            minutes ({funnel.derived.paymentAbandoned.abandonRate}%).
          </p>
        ) : null}
        {mode === 'online' && funnel?.derived?.lobbyAbandonRate ? (
          <p className="text-sm text-zinc-400">
            {funnel.derived.lobbyAbandonRate}% of people who joined a room left before the match
            started.
          </p>
        ) : null}
        {mode === 'online' &&
        funnel?.derived?.midGameDisconnects &&
        funnel.derived.midGameDisconnects.midGameDisconnects > 0 ? (
          <p className="text-sm text-zinc-400">
            {funnel.derived.midGameDisconnects.midGameDisconnects} of{' '}
            {funnel.derived.midGameDisconnects.totalDisconnects} disconnects happened after the match
            had started.
          </p>
        ) : null}
        {reasons.length > 0 ? (
          <div className="pt-2">
            <h3 className="mb-2 text-sm font-medium text-zinc-200">Why that step fails</h3>
            <CountBars
              rows={reasons.map((r) => ({ label: r.reason.replace(/_/g, ' '), count: r.count }))}
              empty="No reject reasons"
            />
          </div>
        ) : null}
      </Section>

      {(funnels?.client.uiErrors.length ?? 0) > 0 ? (
        <Section
          title="Errors the game showed"
          description="Client errors in this window, counted apart from the step that dropped people."
        >
          <CountBars
            rows={funnels!.client.uiErrors.slice(0, 5).map((row) => ({
              label: row.reason.replace(/_/g, ' '),
              count: row.count,
            }))}
            empty="No client errors."
          />
        </Section>
      ) : null}

      {mode === 'quickmatch' && quickmatch ? (
        <Section
          title="Who they play"
          description={
            quickmatch.avgDurationMs > 0
              ? `Finished matches last about ${Math.round(quickmatch.avgDurationMs / 1000)} seconds. These counts are lifetime, not only this window.`
              : 'Opponent mix for configured quick matches. These counts are lifetime, not only this window.'
          }
        >
          <CountBars rows={sortedCounts(quickmatch.byOpponentType)} empty="No opponent data yet." />
        </Section>
      ) : null}

      {mode === 'challenge' && difficulty.length > 0 ? (
        <Section
          title="Which challenges people clear"
          description="Share of runs that finish, for challenges with enough attempts to read. Lifetime, not only this window."
        >
          <RateBars
            rows={difficulty.map((c) => ({
              id: c.challengeId,
              label: c.challengeId.replace(/_/g, ' '),
              rate: c.completionRate ?? 0,
              detail: `${c.runs} runs`,
            }))}
          />
        </Section>
      ) : null}

      {mode === 'challenge' && (challenges?.stats.totalReplayFailed ?? 0) > 0 ? (
        <Section
          title="Wins the server rejected"
          description="Replay checks that failed. Lifetime, across every challenge."
        >
          <CountBars rows={replayRejects(challenges)} empty="No reject reasons recorded." />
        </Section>
      ) : null}

      {mode === 'p2p' && p2p ? (
        <Section
          title="After the game"
          description="What paid P2P players do once a match exists. Lifetime counts."
        >
          <CountBars
            rows={[
              { label: 'Games finished', count: p2p.gameFinished },
              { label: 'Withdrawals opened', count: p2p.withdrawals },
              { label: 'Double or nothing', count: p2p.doubleOrNothing },
            ].filter((r) => r.count > 0)}
            empty="No finished P2P games in the recorded counters yet."
          />
        </Section>
      ) : null}

      {mode === 'online' && online ? (
        <Section
          title="How matches ended"
          description="Latest finished ONLINE games. A rematch room can produce more than one row."
        >
          {finishedMatches(online).length === 0 ? (
            <p className="text-sm text-zinc-500">No finished matches in the archive yet.</p>
          ) : (
            <ul className="divide-y divide-surface-border">
              {finishedMatches(online).map((row) => (
                <li
                  key={`${row.roomCode}-${row.matchRound ?? 'session'}-${row.finishedAt ?? ''}`}
                  className="flex flex-wrap items-baseline justify-between gap-2 py-2 text-sm"
                >
                  <span className="text-zinc-200">
                    <span className="font-medium text-zinc-100">{row.roomCode}</span>
                    {row.matchRound != null ? ` · round ${row.matchRound}` : ''} ·{' '}
                    {row.buyin.toLocaleString()} sats
                  </span>
                  <span className="text-zinc-400">
                    {matchSummary(row)}
                    {row.finishedAt ? ` · ${formatTs(row.finishedAt)}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      ) : null}

      {mode === 'online' && replays ? (
        <Section
          title="Watching, not playing"
          description="Spectators and replay viewers. Lifetime counts, separate from seats that were paid."
        >
          <CountBars
            rows={[
              { label: 'Started spectating', count: replays.spectateStarts },
              { label: 'Started a replay', count: replays.replayStarts },
            ].filter((r) => r.count > 0)}
            empty="No spectators or replays recorded yet."
          />
        </Section>
      ) : null}

      <div className="grid gap-8 lg:grid-cols-2">
        <Section
          title="What they open"
          description="Main-menu choices. This is intent, before anyone pays or finishes."
        >
          <CountBars rows={menu} empty="No menu selections in this window." />
        </Section>
        <Section
          title="Where new Nostr players start"
          description={
            cohorts
              ? `${cohorts.returnRate}% of signed-in players were seen on a second day this week (${cohorts.returningPlayers}). Anonymous visits are not in this count.`
              : 'First mode after a Nostr sign-in, this week.'
          }
        >
          <CountBars
            rows={sortedCounts(cohorts?.firstGameModeDistribution).map((row) => ({
              ...row,
              label: row.label === 'unknown' ? 'Signed in, no game yet' : row.label,
            }))}
            empty="No signed-in players this week."
          />
        </Section>
      </div>

      {home.acquisition.topReferrers.length > 0 ||
      home.acquisition.topPlatforms.length > 0 ||
      home.traffic.topCountries24h.length > 0 ||
      home.system.geoWarning ||
      home.traffic.geoWarning ? (
      <Section
        title="Where sessions come from"
        description="Referrer and platform follow this window. Country is the last 24 hours."
      >
        <div className="grid gap-6 lg:grid-cols-3">
          <div>
            <h3 className="mb-2 text-sm font-medium text-zinc-200">Referrer</h3>
            <CountBars
              rows={home.acquisition.topReferrers.map((r) => ({
                label: r.referrer,
                count: r.count,
              }))}
              empty="No referrer reported."
            />
          </div>
          <div>
            <h3 className="mb-2 text-sm font-medium text-zinc-200">Platform</h3>
            <CountBars
              rows={home.acquisition.topPlatforms.map((r) => ({
                label: r.platform,
                count: r.count,
              }))}
              empty="No platform reported."
            />
          </div>
          <div>
            <h3 className="mb-2 text-sm font-medium text-zinc-200">Country</h3>
            <CountBars
              rows={home.traffic.topCountries24h.map((r) => ({
                label: r.country,
                count: r.sessions,
              }))}
              empty="No country reported."
            />
          </div>
        </div>
        <p className="text-xs text-zinc-500">
          {home.acquisition.sessionsWithContext.toLocaleString()} sessions sent referrer or platform.
          {home.system.geoWarning || home.traffic.geoWarning
            ? ' Country stays unknown until CF-IPCountry is forwarded.'
            : ''}
        </p>
      </Section>
      ) : null}

      <p className="text-xs text-zinc-500">Click a step to open the log for that event.</p>
    </div>
  );
}
