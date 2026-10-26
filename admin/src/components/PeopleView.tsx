import { useEffect, useState } from 'react';
import type { CohortData, JourneyData, LiveData, RecentAttemptsData } from '../lib/api';
import { fetchJourney } from '../lib/api';
import { formatTs } from '../lib/hooks';
import { humanEvent } from '../lib/labels';
import { PlayerIdentityCell } from './PlayerIdentityCell';
import { Section } from './ui';

function trail(row: RecentAttemptsData['attempts'][0]): string {
  const parts: string[] = [];
  if (row.quickmatchStarts) {
    parts.push(`${row.quickmatchStarts} quick ${row.quickmatchStarts === 1 ? 'match' : 'matches'}`);
  }
  if (row.challengeRuns) {
    parts.push(`${row.challengeRuns} ${row.challengeRuns === 1 ? 'challenge' : 'challenges'}`);
  }
  if (row.onlineJoins) parts.push(`${row.onlineJoins} online`);
  if (row.p2pDeposits) {
    parts.push(`${row.p2pDeposits} ${row.p2pDeposits === 1 ? 'deposit' : 'deposits'}`);
  }
  if (parts.length === 0) return humanEvent(row.lastEvent);
  return parts.join(' · ');
}

export function PeopleView({
  live,
  recent,
  cohorts,
  initialQuery,
  initialKind,
}: {
  live: LiveData | null;
  recent: RecentAttemptsData | null;
  cohorts: CohortData | null;
  initialQuery?: string;
  initialKind?: 'sessionID' | 'pubkey';
}) {
  const [query, setQuery] = useState(initialQuery ?? '');
  const [kind, setKind] = useState<'sessionID' | 'pubkey'>(initialKind ?? 'sessionID');
  const [journey, setJourney] = useState<JourneyData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const connected = new Set((live?.sessions ?? []).map((s) => s.sessionID));

  const load = async (nextKind: 'sessionID' | 'pubkey', value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setKind(nextKind);
    setQuery(trimmed);
    setLoading(true);
    setError(null);
    try {
      const result = await fetchJourney(
        nextKind === 'sessionID' ? { sessionID: trimmed } : { pubkey: trimmed }
      );
      setJourney(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Search failed');
      setJourney(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (initialQuery) void load(initialKind ?? 'sessionID', initialQuery);
    // Only run when a parent navigates here with a query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuery, initialKind]);

  const returned = cohorts
    ? `${cohorts.returnRate}% of signed-in players this week showed up on a second day.`
    : null;

  return (
    <div className="space-y-8">
      <p className="max-w-2xl text-sm text-zinc-400">
        One row per person over the last day. Open a row to see the order of what they actually
        did. {returned}
      </p>

      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void load(kind, query);
        }}
      >
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Find by
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as 'sessionID' | 'pubkey')}
            className="rounded border border-surface-border bg-surface-raised px-2 py-1.5 text-sm text-zinc-200"
          >
            <option value="sessionID">This visit</option>
            <option value="pubkey">Nostr identity</option>
          </select>
        </label>
        <label className="flex min-w-[240px] flex-1 flex-col gap-1 text-xs text-zinc-400">
          {kind === 'sessionID' ? 'Session' : 'npub or pubkey prefix'}
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="rounded border border-surface-border bg-surface-raised px-2 py-1.5 text-sm text-zinc-200"
          />
        </label>
        <button
          type="submit"
          disabled={loading}
          className="rounded border border-surface-border px-3 py-2 text-sm text-zinc-200 hover:border-accent disabled:opacity-50"
        >
          {loading ? 'Looking…' : 'Show path'}
        </button>
      </form>
      {error ? <p className="text-sm text-red-400">{error}</p> : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Section title="Last 24 hours" description="Click a player to read their path.">
          {!recent || recent.attempts.length === 0 ? (
            <p className="text-sm text-zinc-500">No one has played in the last day.</p>
          ) : (
            <ul className="divide-y divide-surface-border rounded-lg border border-surface-border">
              {recent.attempts.map((row) => (
                <li key={row.key}>
                  <button
                    type="button"
                    className="flex w-full flex-col gap-1 px-3 py-2.5 text-left hover:bg-zinc-800/40"
                    onClick={() => {
                      if (row.sessionID) void load('sessionID', row.sessionID);
                      else if (row.pubkeyPrefix) void load('pubkey', row.pubkeyPrefix);
                    }}
                  >
                    <span className="flex items-center justify-between gap-3">
                      <PlayerIdentityCell
                        identity={row.identity ?? { kind: 'anon' }}
                        size="sm"
                      />
                      {row.sessionID && connected.has(row.sessionID) ? (
                        <span className="text-xs text-emerald-400">live</span>
                      ) : (
                        <span className="text-xs text-zinc-500">{formatTs(row.lastTs)}</span>
                      )}
                    </span>
                    <span className="text-sm text-zinc-400">{trail(row)}</span>
                    {row.topRejectReason ? (
                      <span className="text-xs text-amber-300">
                        Stopped by {row.topRejectReason.replace(/_/g, ' ')}
                        {row.topRejectCount ? ` ×${row.topRejectCount}` : ''}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section
          title="Path"
          description={
            journey?.identity
              ? undefined
              : 'The sequence of events for the player you pick, oldest first.'
          }
        >
          {journey?.identity ? (
            <div className="mb-3">
              <PlayerIdentityCell identity={journey.identity} />
            </div>
          ) : null}
          {!journey ? (
            <p className="text-sm text-zinc-500">Pick someone, or search a visit.</p>
          ) : journey.timeline.length === 0 ? (
            <p className="text-sm text-zinc-500">No events for that player.</p>
          ) : (
            <ol className="space-y-3 border-l border-surface-border pl-4">
              {journey.timeline.map((event, i) => (
                <li key={`${event.ts}-${i}`} className="relative">
                  <span className="absolute top-1.5 -left-[21px] h-2 w-2 rounded-full bg-accent" />
                  <p className="text-sm text-zinc-100">{humanEvent(event.event)}</p>
                  <p className="text-xs text-zinc-500">
                    {formatTs(event.ts)}
                    {event.outcome ? ` · ${event.outcome}` : ''}
                    {event.reason ? ` · ${event.reason.replace(/_/g, ' ')}` : ''}
                    {event.roomCode ? ` · room ${event.roomCode}` : ''}
                    {event.challengeId ? ` · ${event.challengeId.replace(/_/g, ' ')}` : ''}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </Section>
      </div>
    </div>
  );
}
