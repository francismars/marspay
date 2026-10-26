import type { ChallengesData, MoneyData, PlayerIdentity } from '../lib/api';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { CHART_TOOLTIP_STYLE, CHART_COLORS } from '../lib/chartTheme';
import { formatTs } from '../lib/hooks';
import { DataTable, KpiCard, ProgressBar, Section } from './ui';
import { PlayerIdentityCell } from './PlayerIdentityCell';

function claimSats(value: unknown): string {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n.toLocaleString() : '—';
}

function claimWhen(paid: unknown, published: unknown): string {
  if (typeof paid === 'number' || typeof paid === 'string') return formatTs(paid);
  if (typeof published === 'number' || typeof published === 'string') return formatTs(published);
  return '—';
}

export function MoneyTab({ data, challenges }: { data: MoneyData; challenges?: ChallengesData }) {
  const capWarn = data.bountyCapPct >= 80;

  return (
    <div className="space-y-8">
      <p className="max-w-2xl text-sm text-zinc-400">
        Challenge bounties are the daily budget. Deposits and payouts below are lifetime counters,
        so they are not comparable to today’s spend.
      </p>

      <Section
        title="Bounty budget today"
        description={
          data.pendingZapClaims > 0
            ? `${data.pendingZapClaims} claim${data.pendingZapClaims === 1 ? '' : 's'} still waiting to be paid.`
            : 'No claims are waiting.'
        }
      >
        <div className="panel space-y-2 rounded-lg p-4">
          <div className="flex justify-between text-sm text-zinc-500">
            <span>
              {data.bountySpentTodaySats.toLocaleString()} / {data.bountyCapSats.toLocaleString()}{' '}
              sats
            </span>
            <span className={capWarn ? 'text-amber-400' : 'text-zinc-300'}>
              {data.bountyCapPct}%
            </span>
          </div>
          <ProgressBar pct={data.bountyCapPct} />
        </div>
      </Section>

      {data.dailySpendSeries.length > 0 ? (
        <Section title="Bounty spend (7 days)">
          <div className="panel h-48 rounded-lg p-2">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.dailySpendSeries}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} />
                <XAxis dataKey="day" tick={{ fill: CHART_COLORS.muted, fontSize: 11 }} />
                <YAxis tick={{ fill: CHART_COLORS.muted, fontSize: 11 }} />
                <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
                <Bar dataKey="sats" fill={CHART_COLORS.primary} name="sats" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>
      ) : null}

      <Section title="Stake movement" description="How many paid games moved sats. Lifetime, not today.">
        <div className="grid gap-4 sm:grid-cols-3">
          <KpiCard label="P2P deposits" value={data.p2pDeposits} />
          <KpiCard label="P2P withdrawals" value={data.p2pWithdrawals} />
          <KpiCard label="ONLINE payouts" value={data.onlinePayouts} />
        </div>
      </Section>

      {challenges?.pendingZaps && challenges.pendingZaps.length > 0 ? (
        <Section title="Pending zap claims">
          <DataTable
            columns={[
              {
                key: 'identity',
                label: 'Player',
                sortable: false,
                render: (r) =>
                  r.identity ? (
                    <PlayerIdentityCell identity={r.identity as PlayerIdentity} />
                  ) : (
                    '—'
                  ),
              },
              { key: 'challengeId', label: 'Challenge' },
              { key: 'bountySats', label: 'Sats' },
            ]}
            rows={challenges.pendingZaps as unknown as Array<Record<string, unknown>>}
            rowKey={(r) => `${r.challengeId}-${r.runId}`}
          />
        </Section>
      ) : null}

      {challenges && challenges.recentClaims.length > 0 ? (
        <Section
          title="Who was paid"
          description="Recent bounty zaps. Pending claims stay in the list above."
        >
          <DataTable
            columns={[
              {
                key: 'identity',
                label: 'Player',
                sortable: false,
                render: (r) =>
                  r.identity ? (
                    <PlayerIdentityCell identity={r.identity as PlayerIdentity} />
                  ) : (
                    String(r.pubkeyPrefix ?? '—')
                  ),
              },
              {
                key: 'challengeId',
                label: 'Challenge',
                render: (r) => String(r.challengeId ?? '—').replace(/_/g, ' '),
              },
              {
                key: 'bountySats',
                label: 'Sats',
                render: (r) => claimSats(r.bountySats),
              },
              {
                key: 'zapPaidAt',
                label: 'Paid',
                render: (r) => claimWhen(r.zapPaidAt, r.publishedAt),
              },
            ]}
            rows={[...challenges.recentClaims].reverse().slice(0, 8) as unknown as Array<
              Record<string, unknown>
            >}
            rowKey={(r, i) => `${r.runId ?? r.challengeId}-${i}`}
          />
        </Section>
      ) : null}
    </div>
  );
}
