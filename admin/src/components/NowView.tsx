import { useEffect, useState } from 'react';
import type { DashboardAlert, LiveData, LiveSessionDetail, OnlineData, OnlineRoomLive } from '../lib/api';
import { fetchLiveSession } from '../lib/api';
import { formatAge } from '../lib/hooks';
import { ROOM_PHASE, humanEvent } from '../lib/labels';
import { AlertsStrip } from './AlertsStrip';
import { PlayerDetailDrawer } from './PlayerDetailDrawer';
import { PlayerIdentityCell } from './PlayerIdentityCell';
import { Section } from './ui';

function doing(ctx: LiveData['sessions'][0]['context']): string {
  if (ctx.roomCode) {
    const seat = ctx.seatRole ? ` as ${ctx.seatRole.toUpperCase()}` : '';
    return `ONLINE ${ctx.roomCode}${seat}`;
  }
  if (ctx.challengeId) return `Challenge ${ctx.challengeId.replace(/_/g, ' ')}`;
  if (ctx.mode === 'challenge') return 'In a challenge';
  if (ctx.mode === 'online') return 'In an ONLINE lobby';
  if (ctx.currentRoute) return `Browsing ${ctx.currentRoute}`;
  return 'Connected, not in a match';
}

function seatLine(seat: OnlineRoomLive['seats'][0]): string {
  if (!seat.sessionID && seat.status === 'open') return 'Open seat';
  const name = seat.name || 'Player';
  const ready = seat.ready ? 'ready' : seat.status;
  return `${name} · ${ready}`;
}

export function NowView({
  live,
  online,
  alerts,
  selectedSession,
  onSelectSession,
  onAlertClick,
  onViewActivity,
}: {
  live: LiveData;
  online: OnlineData | null;
  alerts: DashboardAlert[];
  selectedSession: string | null;
  onSelectSession: (sessionID: string | null) => void;
  onAlertClick?: (alert: DashboardAlert) => void;
  onViewActivity: (sessionID: string) => void;
}) {
  const [detail, setDetail] = useState<LiveSessionDetail | null>(null);

  useEffect(() => {
    if (!selectedSession) {
      setDetail(null);
      return;
    }
    void fetchLiveSession(selectedSession)
      .then(setDetail)
      .catch(() => setDetail(null));
  }, [selectedSession]);

  const rooms = (online?.live ?? []).filter((room) => room.phase !== 'finished');
  const inMatch = live.sessions.filter((s) => s.context.mode === 'online' || s.context.roomCode);
  const inChallenge = live.sessions.filter(
    (s) => s.context.mode === 'challenge' && !s.context.roomCode
  );
  const browsing = live.sessions.filter(
    (s) => s.context.mode !== 'online' && s.context.mode !== 'challenge' && !s.context.roomCode
  );

  const groups = [
    { title: 'In a match', sessions: inMatch },
    { title: 'In a challenge', sessions: inChallenge },
    { title: 'Browsing', sessions: browsing },
  ].filter((g) => g.sessions.length > 0);

  return (
    <div className="space-y-8">
      <p className="max-w-2xl text-sm text-zinc-400">
        {live.total === 0
          ? 'Nobody is connected.'
          : `${live.total} connected · ${live.inOnline} in ONLINE · ${live.inChallenge} in a challenge · ${live.nostrLinked} signed in with Nostr.`}
      </p>

      <AlertsStrip alerts={alerts} onAlertClick={onAlertClick} />

      <Section
        title="Live matches"
        description="ONLINE rooms that are still open. Finished matches stay in the log."
      >
        {rooms.length === 0 ? (
          <p className="text-sm text-zinc-500">No live matches.</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {rooms.map((room) => (
              <article key={room.roomId} className="panel rounded-lg p-4">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="font-display text-xl tracking-wide text-zinc-100">{room.roomCode}</h3>
                  <span className="text-xs text-accent">{ROOM_PHASE[room.phase] ?? room.phase}</span>
                </div>
                <p className="mt-1 text-sm text-zinc-400">
                  {room.buyin.toLocaleString()} sats buy-in · {room.seatsPaid}/{room.seatsTotal} paid
                  {room.spectators > 0 ? ` · ${room.spectators} watching` : ''} · opened{' '}
                  {formatAge(room.ageMs)} ago
                </p>
                <ul className="mt-3 space-y-1 text-sm text-zinc-300">
                  {room.seats.map((seat) => (
                    <li key={seat.role}>
                      <button
                        type="button"
                        className="text-left hover:text-accent disabled:hover:text-zinc-300"
                        disabled={!seat.sessionID}
                        onClick={() => seat.sessionID && onSelectSession(seat.sessionID)}
                      >
                        <span className="text-zinc-500">{seat.role.toUpperCase()}</span> {seatLine(seat)}
                      </button>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        )}
      </Section>

      <Section title="Who is here" description="Grouped by what they are doing, not by connection time.">
        {groups.length === 0 ? (
          <p className="text-sm text-zinc-500">No connected sessions.</p>
        ) : (
          <div className="space-y-6">
            {groups.map((group) => (
              <div key={group.title}>
                <h3 className="mb-2 text-xs font-medium tracking-wide text-zinc-500 uppercase">
                  {group.title}
                </h3>
                <ul className="divide-y divide-surface-border rounded-lg border border-surface-border">
                  {group.sessions.map((session) => (
                    <li key={session.sessionID}>
                      <button
                        type="button"
                        onClick={() => onSelectSession(session.sessionID)}
                        className="flex w-full items-center justify-between gap-4 px-3 py-2.5 text-left hover:bg-zinc-800/40"
                      >
                        <PlayerIdentityCell identity={session.identity} size="sm" />
                        <span className="min-w-0 flex-1 truncate text-sm text-zinc-300">
                          {doing(session.context)}
                          {session.context.lastEvent ? (
                            <span className="text-zinc-500">
                              {' '}
                              · {humanEvent(session.context.lastEvent)}
                            </span>
                          ) : null}
                        </span>
                        <span className="shrink-0 text-xs text-zinc-500">
                          {formatAge(session.lastSeenMs)} ago
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Section>

      {detail ? (
        <PlayerDetailDrawer
          detail={detail}
          onClose={() => onSelectSession(null)}
          onViewActivity={onViewActivity}
        />
      ) : null}
    </div>
  );
}
