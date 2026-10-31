import type { AuthorRelayContext } from './fetchAuthorEvents';
import { fetchLatestAuthorEvent } from './fetchAuthorEvents';
import type { AppNostrProfile } from '../../state/nostrAppSessionState';
import {
  getCachedNostrProfile,
  invalidateCachedNostrProfile,
  setCachedNostrProfile,
} from './nostrProfileCache';

function shortPubkeyLabel(pubkey: string): string {
  if (pubkey.length <= 16) {
    return pubkey;
  }
  return `${pubkey.slice(0, 8)}…${pubkey.slice(-6)}`;
}

function emptyProfile(pubkey: string): AppNostrProfile {
  return {
    pubkey,
    name: shortPubkeyLabel(pubkey),
    picture: null,
    nip05: null,
    lud16: null,
    lud06: null,
  };
}

function profileFromKind0(pubkey: string, contentRaw: string): AppNostrProfile {
  let content: Record<string, unknown>;
  try {
    content = JSON.parse(contentRaw) as Record<string, unknown>;
  } catch {
    return emptyProfile(pubkey);
  }
  const displayName = typeof content.display_name === 'string' ? content.display_name.trim() : '';
  const name = typeof content.name === 'string' ? content.name.trim() : '';
  const picture = typeof content.picture === 'string' ? content.picture.trim() || null : null;
  const nip05 = typeof content.nip05 === 'string' ? content.nip05.trim() || null : null;
  const lud16 = typeof content.lud16 === 'string' ? content.lud16.trim() || null : null;
  const lud06 = typeof content.lud06 === 'string' ? content.lud06.trim() || null : null;
  const resolvedName = displayName || name || shortPubkeyLabel(pubkey);
  return {
    pubkey,
    name: resolvedName,
    picture,
    nip05,
    lud16,
    lud06,
  };
}

/** Kind-0 metadata for app Nostr session (relays read on server only). */
export async function fetchNostrAppProfile(
  pubkey: string,
  options?: { relayContext?: AuthorRelayContext; forceRefresh?: boolean }
): Promise<AppNostrProfile> {
  if (options?.forceRefresh) {
    invalidateCachedNostrProfile(pubkey);
  }

  const cached = getCachedNostrProfile(pubkey);
  if (cached) {
    return cached;
  }

  const ev = await fetchLatestAuthorEvent(pubkey, 0, options);
  if (!ev?.content) {
    return emptyProfile(pubkey);
  }

  const profile = profileFromKind0(pubkey, ev.content);
  setCachedNostrProfile(profile);
  return profile;
}
