import type { NDKEvent } from '@nostr-dev-kit/ndk';
import type { Kind1PublishedSnapshot } from '../../types/nostr';

/** Capture Kind1 fields we already have at publish time. */
export function snapshotFromNdkEvent(ndkEvent: NDKEvent): Kind1PublishedSnapshot {
  return {
    content: ndkEvent.content,
    tags: ndkEvent.tags.map((tag) => [...tag]),
    pubkey: ndkEvent.pubkey,
    created_at: ndkEvent.created_at ?? Math.floor(Date.now() / 1000),
  };
}
