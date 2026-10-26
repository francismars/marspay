/** Turn `client.quickmatch.started` into words an operator can read. */
export function humanEvent(event: string | undefined): string {
  if (!event) return '—';
  return event
    .replace(/^client\./, '')
    .replace(/[._]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export type PlayMode = 'quickmatch' | 'challenge' | 'p2p' | 'online' | 'nostr';

export const PLAY_MODES: PlayMode[] = ['quickmatch', 'challenge', 'p2p', 'online', 'nostr'];

/** What the headline rate on Play actually measures. */
export const MODE_STORY: Record<PlayMode, { name: string; finishes: string }> = {
  quickmatch: {
    name: 'Quick Match',
    finishes: 'Started a match and played it through.',
  },
  challenge: {
    name: 'Challenges',
    finishes: 'Passed eligibility and claimed the bounty.',
  },
  p2p: {
    name: 'P2P',
    finishes: 'Paid the deposit and the server recorded a finished game.',
  },
  online: {
    name: 'ONLINE',
    finishes: 'Paid for a seat and the match finished.',
  },
  nostr: {
    name: 'Nostr sign-in',
    finishes: 'Linked a Nostr account and started a challenge run.',
  },
};

export const ROOM_PHASE: Record<string, string> = {
  lobby: 'Waiting for players',
  playing: 'Match in progress',
  postgame: 'Choosing a rematch',
  finished: 'Finished',
};
