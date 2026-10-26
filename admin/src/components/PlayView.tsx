import type {
  ChallengesData,
  CohortData,
  HomeData,
  ModeFunnelData,
  P2pData,
  QuickMatchData,
  ReplayData,
} from '../lib/api';
import { MODE_STORY, type PlayMode } from '../lib/labels';
import { CountBars, FunnelBars, RateBars } from './viz/Bars';
import { Section } from './ui';
import { SubNav } from './SubNav';

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

      {home.acquisition.topReferrers.length > 0 ? (
        <Section title="Where sessions come from" description="Referrer host, when the client reported one.">
          <CountBars
            rows={home.acquisition.topReferrers.map((r) => ({
              label: r.referrer,
              count: r.count,
            }))}
            empty="No referrers."
          />
          <p className="text-xs text-zinc-500">
            {home.acquisition.sessionsWithContext.toLocaleString()} sessions sent that context.
            {home.system.geoWarning
              ? ' Country is mostly unknown until CF-IPCountry is forwarded.'
              : ''}
          </p>
        </Section>
      ) : null}

        <p className="text-xs text-zinc-500">Click a step to open the log for that event.</p>
    </div>
  );
}
