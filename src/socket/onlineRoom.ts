import { Socket } from 'socket.io';
import { decode } from 'light-bolt11-decoder';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip19,
  verifyEvent,
  type Event,
} from 'nostr-tools';
import { publishGameKind1 } from '../calls/NDK/publishGameKind1';
import { publishOnlineKind1Reply } from '../calls/NDK/publishOnlineKind1Reply';
import { publishOnlineRematchKind1 } from '../calls/NDK/publishOnlineRematchKind1';
import { buildOnlineKind1PostPayload } from '../calls/nostr/buildOnlineKind1PostPayload';
import {
  rememberOnlineSeatZapContext,
  recallOnlineSeatZapContext,
  forgetOnlineSeatZapContext,
} from '../calls/nostr/onlineSeatZapContextCache';
import { resolveOnlineSeatZapContext } from '../calls/nostr/resolveOnlineSeatZapContext';
import { resolveKind1NoteEvent } from '../calls/nostr/resolveKind1NoteEvent';
import { fetchNostrAppProfile } from '../calls/nostr/fetchNostrAppProfile';
import {
  buildKind1ZapRequestTemplate,
  fetchZapInvoiceFromCallback,
} from '../calls/nostr/lnurlZapShared';
import { ZAP_RECEIPT_RELAYS } from '../consts/nostrRelays';
import { setNDKInstance } from '../calls/NDK/setNDKInstance';
import { backfillZapReceiptsForKind1 } from '../calls/NDK/subscribeEvent';
import createLNURLW from '../calls/LNBits/createLNURLW';
import getLNURLCallback from '../calls/LNAddress/getLNURLCallback';
import getInvoiceFromCallback from '../calls/LNAddress/getInvoiceFromCallback';
import payInvoice from '../calls/LNBits/payInvoice';
import { P2PMAXWITHDRAWALS } from '../consts/values';
import { onlineRoomPublicUrl } from '../consts/gamePublicUrl';
import { GameMode, PlayerRole } from '../types/game';
import type { OnlineRoomListItem } from '../types/online';
import { io } from '../server';
import { setIDToLNURLW, setLNURLWToID } from '../state/lnurlwState';
import {
  archivedRowToOnlineRoomListItem,
  listArchivedOnlineRoomsSync,
  resolveArchivedRoomByCodeSync,
  resolveArchivedRoomByIdSync,
} from '../state/onlineRoomArchive';
import { pruneOnlineSnapshotForWire } from '../state/onlineSnapshotWire';
import {
  getAppNostrPubkeyForSession,
  getAppNostrSession,
} from '../state/nostrAppSessionState';
import { dateNow } from '../utils/time';
import { allowSocketAction } from './actionRateLimit';
import { maybeTrackOnlinePing, trackOnlineOk, trackOnlineReject } from '../telemetry/onlineTelemetry';
import { resolveTrackPubkeyPrefix } from '../telemetry/resolveTrackPubkeyPrefix';
import { trackEvent } from '../telemetry/trackEvent';
import {
  advanceNostrThreadTip,
  areSeatsFilled,
  confirmOnlineStart,
  createOnlineRoom,
  deleteRoom,
  getOnlineReplay,
  getOnlinePostGame,
  getOnlineMatchRoundHistory,
  getRoomByCode,
  extendNostrLinkExpiry,
  getActiveNostrLinkPubkey,
  getLightningNostrLinkPubkey,
  completeOnlineClaimPayout,
  failOnlineClaimPayout,
  getOnlineClaimStatus,
  getOnlineForfeitStatus,
  getRoomById,
  tryLockOnlinePayout,
  unlockOnlinePayout,
  getRoomBySession,
  hasAnyPaidSeat,
  isOnlineRoomWinnerViewer,
  isPaidSeatSession,
  isRematchLoserSession,
  issueJoinPin,
  issueNostrLinkChallenge,
  joinRoom,
  peekPendingNostrChallenge,
  clearPendingNostrChallenge,
  registerNostrLink,
  registerPendingSeatPayment,
  removeLightningNostrLinksForSession,
  removeNostrLinkRegistrationForPubkey,
  leaveRoom,
  listOnlineHistoryMerged,
  listOnlineRooms,
  redactSerializedRoomForViewer,
  markOnlineRematchPending,
  serializeRoom,
  setOnlineRoomChangeNotifier,
  setSeatReady,
  setRoomNostrMeta,
  setRoomPhase,
  setOnlinePostGameLnurlw,
  setOnlinePostGameNostrPayout,
  setOnlineRematchRequested,
  stepRoomSnapshot,
  syncOnlineSeatSockets,
  takeDueClaimPayouts,
  updateRoomInput,
  voteOnlineDoubleOrNothing,
} from '../state/onlineRoomState';

import { netPayoutSats } from '../utils/payout';

const ONLINE_TICK_MS = 100;
const ONLINE_CLOCK_EMIT_MS = 1000;
const lastClockRoomEmit = new Map<string, number>();
/** Kind-9735 can arrive after the player pays a host invoice that is about to expire. */
const ONLINE_SEAT_LIGHTNING_RECEIPT_GRACE_MS = 10 * 60 * 1000;


function logOnline(sessionID: string | undefined, message: string) {
  const sessionTag = sessionID ?? 'unknown-session';
  console.log(`${dateNow()} [${sessionTag}] [ONLINE] ${message}`);
}

function emitOnlineRoomsList() {
  io.emit('resListOnlineRooms', {
    rooms: listOnlineRooms(),
  });
}

/** Broadcast live list + merged history (single source of truth for History tab). */
export function broadcastOnlineRoomLists() {
  emitOnlineRoomsList();
  io.emit('resOnlineHistory', {
    rooms: listOnlineHistoryMerged(),
  });
}

type OnlineSeatMention = {
  pubkey?: string;
  name?: string;
  payMethod?: 'lightning' | 'nostr_web' | 'nostr_app';
};

function getSeatMentions(roomId: string): OnlineSeatMention[] {
  const room = getRoomById(roomId);
  if (!room) {
    return [];
  }
  const p1 = room.seats.get(PlayerRole.Player1);
  const p2 = room.seats.get(PlayerRole.Player2);
  const toMention = (seat: typeof p1, fallback: string): OnlineSeatMention => ({
    pubkey: seat?.payMethod === 'lightning' ? undefined : seat?.pubkey,
    name: seat?.name ?? fallback,
    payMethod: seat?.payMethod,
  });
  return [toMention(p1, 'Player 1'), toMention(p2, 'Player 2')];
}

/** Lightning seat uses ephemeral keys — show lobby name in prose, not npub. */
function formatOnlinePlayerNostrLabel(mention: OnlineSeatMention) {
  if (mention.payMethod === 'lightning') {
    return mention.name?.trim() || 'Anonymous';
  }
  if (mention.pubkey) {
    return `nostr:${nip19.npubEncode(mention.pubkey)}`;
  }
  return mention.name?.trim() || 'Unknown player';
}

function winnerSeatMention(
  winnerSeat: { pubkey?: string; name?: string; payMethod?: OnlineSeatMention['payMethod'] } | undefined,
  winnerName: string
): OnlineSeatMention {
  return {
    pubkey: winnerSeat?.payMethod === 'lightning' ? undefined : winnerSeat?.pubkey,
    name: winnerName,
    payMethod: winnerSeat?.payMethod,
  };
}

function nostrThreadParent(room: { kind1EventId?: string; nostrThreadTipEventId?: string }) {
  const root = room.kind1EventId;
  if (!root) {
    return undefined;
  }
  return room.nostrThreadTipEventId ?? root;
}

/** Publish a Kind1 reply on the room thread and advance the linear parent tip. */
async function publishOnlineThreadReply(
  room: NonNullable<ReturnType<typeof getRoomById>>,
  sessionID: string,
  content: string,
  mentions?: OnlineSeatMention[]
): Promise<string | undefined> {
  const root = room.kind1EventId;
  const parent = nostrThreadParent(room);
  if (!root || !parent) {
    return undefined;
  }
  const eventId = await publishOnlineKind1Reply({
    sessionID,
    rootEventId: root,
    parentEventId: parent,
    content,
    mentions,
    appendMentionLine: false,
  });
  if (eventId) {
    advanceNostrThreadTip(room.roomId, eventId);
  }
  return eventId;
}

/** Publish the "match started" Kind1 reply once per `matchRound` (lobby → playing). */
export function publishOnlineMatchStarted(roomId: string, sessionID: string) {
  const room = getRoomById(roomId);
  if (!room || room.phase !== 'playing') {
    return;
  }
  if (room.nostrMatchStartedPostedRound === room.matchRound) {
    return;
  }
  if (!room.kind1EventId) {
    logOnline(
      sessionID,
      `match started nostr reply deferred roomId=${roomId} reason=kind1_pending matchRound=${room.matchRound}`
    );
    return;
  }
  const mentions = getSeatMentions(room.roomId);
  const vsLine = `${formatOnlinePlayerNostrLabel(mentions[0] ?? { name: 'Player 1' })} vs ${formatOnlinePlayerNostrLabel(mentions[1] ?? { name: 'Player 2' })}`;
  const roomUrl = onlineRoomPublicUrl(room.roomCode);
  const matchRound = room.matchRound;
  void publishOnlineThreadReply(
    room,
    sessionID,
    [
      `ONLINE MATCH STARTED · room ${room.roomCode}`,
      vsLine,
      'Spectators can watch live — same link for players and viewers.',
      '',
      `Watch & play: ${roomUrl}`,
    ].join('\n'),
    mentions
  ).then((eventId) => {
    if (!eventId) {
      return;
    }
    const live = getRoomById(roomId);
    if (live && live.matchRound === matchRound) {
      live.nostrMatchStartedPostedRound = matchRound;
    }
  });
}

function publishOnlineMatchResult(room: NonNullable<ReturnType<typeof getRoomById>>) {
  const winnerName = room.postGame.winnerName || room.snapshot.state.winnerName || 'Unknown winner';
  const winnerSeat = [...room.seats.values()].find(
    (seat) => seat.status === 'paid' && seat.sessionID === room.postGame.winnerSessionID
  );
  const netPrize = netPayoutSats(room.postGame.totalPrize ?? 0);
  const mentions = getSeatMentions(room.roomId);
  const [p1, p2] = mentions;
  const scoreLine = `${formatOnlinePlayerNostrLabel(p1 ?? { name: 'Player 1' })} ${room.snapshot.state.score[0]} - ${formatOnlinePlayerNostrLabel(p2 ?? { name: 'Player 2' })} ${room.snapshot.state.score[1]}.`;
  void publishOnlineThreadReply(
    room,
    room.hostSessionID,
    `ONLINE MATCH RESULT · room ${room.roomCode}\nWinner: ${winnerName}.\nFinal score: ${scoreLine}\nNet prize after fee: ${netPrize} sats.`,
    [winnerSeatMention(winnerSeat, winnerName), ...mentions]
  );
}

export async function createOnlineRoomHandler(
  socket: Socket,
  payload?: { buyin?: number; hostLNAddress?: string }
) {
  const sessionID = socket.data.sessionID as string | undefined;
  if (!sessionID) {
    return;
  }
  if (!allowSocketAction(socket, 'room_create')) {
    trackOnlineReject('online.room.created', 'rate_limited', { sessionID });
    socket.emit('onlinePinInvalid', { reason: 'rate_limited' });
    return;
  }
  logOnline(sessionID, `createOnlineRoom requested (buyin=${payload?.buyin ?? 'default'})`);
  const room = createOnlineRoom({
    hostSessionID: sessionID,
    hostSocketID: socket.id,
    buyin: payload?.buyin,
  });

  socket.join(room.roomId);
  socket.data.currentOnlineRoomId = room.roomId;
  const pin = issueJoinPin(room.roomId, sessionID, socket.id);
  logOnline(
    sessionID,
    `room created roomId=${room.roomId} code=${room.roomCode} buyin=${room.buyin} pinIssued=${pin?.pin ?? 'none'}`
  );
  const roomState = serializeRoom(room);
  io.to(room.roomId).emit('onlineRoomUpdated', roomState);
  broadcastOnlineRoomLists();
  socket.emit('resCreateOnlineRoom', {
    roomId: room.roomId,
    roomCode: room.roomCode,
    joinPin: pin?.pin ?? '',
    pinExpiresAt: pin?.expiresAt ?? Date.now(),
    nostrMeta: room.nostrMeta,
    room: roomState,
  });
  trackOnlineOk('online.room.created', {
    sessionID,
    pubkeyPrefix: resolveTrackPubkeyPrefix(sessionID, room.roomId),
    roomId: room.roomId,
    roomCode: room.roomCode,
    buyin: room.buyin,
  });

  // Publish Kind1 asynchronously so room creation UX is never blocked
  // by relay availability or NDK connection delays.
  void (async () => {
    try {
      logOnline(sessionID, `kind1 publish flow started roomId=${room.roomId}`);
      await setNDKInstance();
      logOnline(sessionID, `ndk initialized for roomId=${room.roomId}, publishing kind1`);
      const kind1 = await publishGameKind1(sessionID, {
        mode: GameMode.ONLINE,
        buyin: room.buyin,
        hostLNAddress: payload?.hostLNAddress,
        numberOfPlayers: 2,
        roomCode: room.roomCode,
        roomId: room.roomId,
      });
      logOnline(sessionID, `publishGameKind1 returned roomId=${room.roomId}`);
      if (kind1) {
        setRoomNostrMeta(
          room.roomId,
          {
            note1: kind1.note1,
            min: kind1.min,
            mode: kind1.mode,
          },
          kind1.id
        );
        const live = getRoomById(room.roomId);
        if (live) {
          io.to(room.roomId).emit('onlineRoomUpdated', serializeRoom(live));
        }
        logOnline(
          sessionID,
          `kind1 published roomId=${room.roomId} note=${kind1.note1}`
        );
        if (live?.phase === 'playing') {
          publishOnlineMatchStarted(room.roomId, sessionID);
        }
      } else {
        logOnline(sessionID, `kind1 publish returned no local kind1 record roomId=${room.roomId}`);
      }
    } catch (error) {
      console.error(`Failed to publish ONLINE room kind1 ${room.roomId}:`, error);
    }
  })();
}

export function listOnlineRoomsHandler(socket: Socket) {
  const sessionID = socket.data.sessionID as string | undefined;
  logOnline(sessionID, `listOnlineRooms requested`);
  socket.emit('resListOnlineRooms', {
    rooms: listOnlineRooms(),
  });
}

export function listOnlineArchivedRoomsHandler(socket: Socket) {
  const sessionID = socket.data.sessionID as string | undefined;
  logOnline(sessionID, `listOnlineArchivedRooms requested`);
  const rooms: OnlineRoomListItem[] = listArchivedOnlineRoomsSync().map(
    archivedRowToOnlineRoomListItem
  );
  socket.emit('resListOnlineArchivedRooms', { rooms });
}

export function listOnlineHistoryHandler(socket: Socket) {
  const sessionID = socket.data.sessionID as string | undefined;
  logOnline(sessionID, `listOnlineHistory requested`);
  socket.emit('resOnlineHistory', { rooms: listOnlineHistoryMerged() });
}

export function joinOnlineRoomHandler(socket: Socket, payload: { roomId: string }) {
  const sessionID = socket.data.sessionID as string | undefined;
  if (!sessionID) {
    return;
  }
  logOnline(sessionID, `joinOnlineRoom requested roomId=${payload.roomId}`);
  const joined = joinRoom(payload.roomId, sessionID, socket.id);
  if (!joined) {
    logOnline(sessionID, `joinOnlineRoom failed roomId=${payload.roomId} reason=room_not_found`);
    trackOnlineReject('online.room.joined', 'room_not_found', {
      sessionID,
      pubkeyPrefix: resolveTrackPubkeyPrefix(sessionID, payload.roomId),
      roomId: payload.roomId,
    });
    socket.emit('onlinePinInvalid', { reason: 'room_not_found' });
    return;
  }
  const { room, matchStarted } = joined;
  socket.join(room.roomId);
  socket.data.currentOnlineRoomId = room.roomId;
  const pin = issueJoinPin(room.roomId, sessionID, socket.id);
  logOnline(
    sessionID,
    `joined roomId=${room.roomId} code=${room.roomCode} pinIssued=${pin?.pin ?? 'none'} matchStarted=${matchStarted}`
  );
  if (matchStarted) {
    publishOnlineMatchStarted(room.roomId, sessionID);
  }
  if (room.phase === 'lobby') {
    const kind1Ids = new Set<string>();
    if (room.kind1EventId) {
      kind1Ids.add(room.kind1EventId);
    }
    if (room.postGame.rematchEventId) {
      kind1Ids.add(room.postGame.rematchEventId);
    }
    for (const kind1Id of kind1Ids) {
      void backfillZapReceiptsForKind1(kind1Id);
    }
  }
  const roomState = serializeRoom(room);
  io.to(room.roomId).emit('onlineRoomUpdated', roomState);
  broadcastOnlineRoomLists();
  socket.emit('resJoinOnlineRoom', {
    roomId: room.roomId,
    roomCode: room.roomCode,
    joinPin: pin?.pin ?? '',
    pinExpiresAt: pin?.expiresAt ?? Date.now(),
    nostrMeta: room.nostrMeta,
    room: roomState,
  });
  trackOnlineOk('online.room.joined', {
    sessionID,
    pubkeyPrefix: resolveTrackPubkeyPrefix(sessionID, room.roomId),
    roomId: room.roomId,
    roomCode: room.roomCode,
    buyin: room.buyin,
  });
}

export function joinOnlineRoomByCodeHandler(socket: Socket, payload: { roomCode: string }) {
  const sessionID = socket.data.sessionID as string | undefined;
  const roomCode = payload.roomCode.trim().toUpperCase();
  logOnline(sessionID, `joinOnlineRoomByCode requested code=${roomCode}`);
  const room = getRoomByCode(roomCode);
  if (room) {
    trackOnlineOk('online.room.joined_code', {
      sessionID,
      roomId: room.roomId,
      roomCode: room.roomCode,
      buyin: room.buyin,
    });
    joinOnlineRoomHandler(socket, { roomId: room.roomId });
    return;
  }

  const archived = resolveArchivedRoomByCodeSync(roomCode);
  if (!archived) {
    logOnline(sessionID, `joinOnlineRoomByCode failed code=${roomCode} reason=room_not_found`);
    trackOnlineReject('online.room.joined_code', 'room_not_found', {
      sessionID,
      roomCode,
    });
    socket.emit('onlinePinInvalid', { reason: 'room_not_found' });
    return;
  }

  const viewer = { sessionID, socketID: socket.id };
  const roomState = redactSerializedRoomForViewer(archived.serialized, viewer);
  logOnline(
    sessionID,
    `joinOnlineRoomByCode archive code=${roomCode} roomId=${archived.roomId} phase=${String(roomState.phase)}`
  );
  trackOnlineOk('online.room.joined_code', {
    sessionID,
    roomId: archived.roomId,
    roomCode: archived.roomCode,
  });
  socket.emit('resJoinOnlineRoom', {
    roomId: archived.roomId,
    roomCode: archived.roomCode,
    joinPin: '',
    pinExpiresAt: Date.now(),
    room: roomState,
  });
}

export function spectateOnlineRoomHandler(socket: Socket, payload: { roomId: string }) {
  const sessionID = socket.data.sessionID as string | undefined;
  if (!sessionID) {
    return;
  }
  logOnline(sessionID, `spectateOnlineRoom requested roomId=${payload.roomId}`);
  const joined = joinRoom(payload.roomId, sessionID, socket.id);
  if (!joined) {
    logOnline(sessionID, `spectateOnlineRoom failed roomId=${payload.roomId} reason=room_not_found`);
    trackOnlineReject('online.room.spectate', 'room_not_found', {
      sessionID,
      roomId: payload.roomId,
    });
    socket.emit('onlinePinInvalid', { reason: 'room_not_found' });
    return;
  }
  const { room, matchStarted } = joined;
  logOnline(sessionID, `spectating roomId=${room.roomId} code=${room.roomCode} matchStarted=${matchStarted}`);
  socket.join(room.roomId);
  socket.data.currentOnlineRoomId = room.roomId;
  if (matchStarted) {
    publishOnlineMatchStarted(room.roomId, sessionID);
  }
  io.to(room.roomId).emit('onlineRoomUpdated', serializeRoom(room));
  broadcastOnlineRoomLists();
  trackOnlineOk('online.room.spectate', {
    sessionID,
    roomId: room.roomId,
    roomCode: room.roomCode,
    buyin: room.buyin,
  });
}

export function spectateOnlineRoomByCodeHandler(
  socket: Socket,
  payload: { roomCode: string }
) {
  const sessionID = socket.data.sessionID as string | undefined;
  const room = getRoomByCode(payload.roomCode);
  if (!room) {
    logOnline(sessionID, `spectateOnlineRoomByCode failed code=${payload.roomCode}`);
    trackOnlineReject('online.room.spectate', 'room_not_found', {
      sessionID,
      roomCode: payload.roomCode,
    });
    socket.emit('onlinePinInvalid', { reason: 'room_not_found' });
    return;
  }
  spectateOnlineRoomHandler(socket, { roomId: room.roomId });
}

export function onlineConfirmStartHandler(socket: Socket, payload: { roomId: string }) {
  const sessionID = socket.data.sessionID as string | undefined;
  if (!sessionID) {
    return;
  }
  const result = confirmOnlineStart(payload.roomId, sessionID);
  if (!result.ok) {
    logOnline(
      sessionID,
      `onlineConfirmStart denied roomId=${payload.roomId} reason=${result.reason}`
    );
    trackOnlineReject('online.arena.confirm', result.reason ?? 'denied', {
      sessionID,
      roomId: payload.roomId,
    });
    socket.emit('onlinePinInvalid', { reason: result.reason });
    return;
  }
  trackOnlineOk('online.arena.confirm', {
    sessionID,
    roomId: payload.roomId,
    meta: { countdownStarted: result.countdownStarted },
  });
  const room = getRoomById(payload.roomId);
  if (room) {
    io.to(room.roomId).emit('onlineRoomUpdated', serializeRoom(room));
  }
}

export function getOnlineRoomStateHandler(
  socket: Socket,
  payload: { roomId: string; matchRound?: number }
) {
  const sessionID = socket.data.sessionID as string | undefined;
  const viewer = { sessionID, socketID: socket.id };
  const room = getRoomById(payload.roomId);
  if (room) {
    logOnline(sessionID, `getOnlineRoomState roomId=${room.roomId} phase=${room.phase}`);
    if (sessionID) {
      const joined = joinRoom(payload.roomId, sessionID, socket.id);
      socket.join(payload.roomId);
      socket.data.currentOnlineRoomId = payload.roomId;
      if (joined?.matchStarted) {
        publishOnlineMatchStarted(payload.roomId, sessionID);
      }
    }
    socket.emit('onlineRoomUpdated', serializeRoom(room, viewer));
    return;
  }
  const archived = resolveArchivedRoomByIdSync(payload.roomId, payload.matchRound);
  if (archived) {
    logOnline(
      sessionID,
      `getOnlineRoomState from archive roomId=${payload.roomId} matchRound=${payload.matchRound ?? 'n/a'} code=${archived.roomCode}`
    );
    socket.emit('onlineRoomUpdated', redactSerializedRoomForViewer(archived.serialized, viewer));
    return;
  }
  logOnline(sessionID, `getOnlineRoomState failed roomId=${payload.roomId} reason=room_not_found`);
  socket.emit('onlinePinInvalid', { reason: 'room_not_found' });
}

export function leaveOnlineRoomHandler(socket: Socket, payload?: { roomId?: string }) {
  const sessionID = socket.data.sessionID as string | undefined;
  if (!sessionID) {
    return;
  }
  const room = payload?.roomId ? getRoomById(payload.roomId) : undefined;
  const roomId = room?.roomId;
  if (roomId) {
    socket.leave(roomId);
    socket.data.currentOnlineRoomId = undefined;
  }
  logOnline(sessionID, `leaveOnlineRoom roomId=${roomId ?? 'unknown'}`);
  leaveRoom(sessionID, { releaseSeat: true });
  broadcastOnlineRoomLists();
}

export function cancelOnlineRoomHandler(socket: Socket, payload: { roomId: string }) {
  const sessionID = socket.data.sessionID as string | undefined;
  const room = getRoomById(payload.roomId);
  if (!sessionID || !room || !room.members.has(sessionID)) {
    logOnline(sessionID, `cancelOnlineRoom denied roomId=${payload.roomId}`);
    trackOnlineReject('online.room.cancelled', 'denied', {
      sessionID,
      roomId: payload.roomId,
    });
    return;
  }
  if (hasAnyPaidSeat(payload.roomId)) {
    logOnline(sessionID, `cancelOnlineRoom blocked roomId=${payload.roomId} reason=paid_seat_exists`);
    trackOnlineReject('online.room.cancelled', 'paid_seat_exists', {
      sessionID,
      roomId: payload.roomId,
    });
    socket.emit('onlinePinInvalid', { reason: 'room_has_paid_seats' });
    return;
  }
  logOnline(sessionID, `cancelOnlineRoom roomId=${room.roomId}`);
  trackOnlineOk('online.room.cancelled', {
    sessionID,
    roomId: room.roomId,
    roomCode: room.roomCode,
  });
  setRoomPhase(room.roomId, 'cancelled');
  io.to(room.roomId).emit('onlineRoomUpdated', serializeRoom(room));
  deleteRoom(room.roomId);
  broadcastOnlineRoomLists();
}

/** RTT probe: client `emit('pingLatency', () => { ... })` — ack runs on server immediately. */
export function pingLatencyHandler(_socket: Socket, cb?: () => void) {
  if (typeof cb === 'function') {
    cb();
  }
}

/**
 * Seated players report measured RTT; server stores per-seat `pingMs` and broadcasts `onlineRoomUpdated`
 * so everyone can show both players' latency.
 */
export function reportOnlineRoomPingHandler(
  socket: Socket,
  payload: { roomId?: string; latencyMs?: unknown }
) {
  const sessionID = socket.data.sessionID as string | undefined;
  if (!sessionID || typeof payload?.roomId !== 'string') {
    return;
  }
  const room = getRoomById(payload.roomId);
  if (!room) {
    return;
  }
  const raw = payload.latencyMs;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return;
  }
  const latencyMs = Math.max(0, Math.min(10000, Math.round(raw)));
  const seat = [...room.seats.values()].find(
    (s) => s.sessionID === sessionID && s.status === 'paid'
  );
  if (!seat) {
    return;
  }
  seat.pingMs = latencyMs;
  room.updatedAt = Date.now();
  io.to(room.roomId).emit('onlineRoomUpdated', serializeRoom(room));
  maybeTrackOnlinePing({ sessionID, roomId: room.roomId, latencyMs });
}

export function roomInputHandler(
  socket: Socket,
  payload: {
    roomId: string;
    input: import('../game/onlineInput').OnlineRoomInputPayload;
  }
) {
  const sessionID = socket.data.sessionID as string | undefined;
  if (!sessionID) {
    return;
  }
  const room = getRoomById(payload.roomId);
  if (!room) {
    return;
  }
  if (room.phase !== 'playing') {
    return;
  }
  const paidBySession = isPaidSeatSession(payload.roomId, sessionID);
  const paidBySocket = [...room.seats.values()].some(
    (seat) => seat.status === 'paid' && seat.socketID === socket.id
  );
  if (!paidBySession && !paidBySocket) {
    logOnline(
      sessionID,
      `roomInput denied roomId=${payload.roomId} reason=not_paid_player socket=${socket.id}`
    );
    return;
  }
  updateRoomInput(payload.roomId, sessionID, payload.input);
}

export function startOnlineGameHandler(socket: Socket, payload: { roomId: string }) {
  const sessionID = socket.data.sessionID as string | undefined;
  const room = getRoomById(payload.roomId);
  if (!sessionID || !room) {
    logOnline(sessionID, `startOnlineGame denied roomId=${payload.roomId}`);
    return;
  }
  const ready = setSeatReady(payload.roomId, sessionID, true);
  if (!ready.ok) {
    logOnline(sessionID, `startOnlineGame blocked roomId=${payload.roomId} reason=${ready.reason}`);
    trackOnlineReject('online.game.started', ready.reason ?? 'blocked', {
      sessionID,
      pubkeyPrefix: resolveTrackPubkeyPrefix(sessionID, payload.roomId),
      roomId: payload.roomId,
    });
    socket.emit('onlinePinInvalid', { reason: ready.reason });
    return;
  }
  if (!areSeatsFilled(payload.roomId)) {
    logOnline(sessionID, `startOnlineGame blocked roomId=${payload.roomId} reason=seats_not_filled`);
    trackOnlineReject('online.game.started', 'seats_not_filled', {
      sessionID,
      pubkeyPrefix: resolveTrackPubkeyPrefix(sessionID, payload.roomId),
      roomId: payload.roomId,
    });
    socket.emit('onlinePinInvalid', { reason: 'seats_not_filled' });
  }
  logOnline(
    sessionID,
    `startOnlineGame compatibility signal roomId=${payload.roomId} started=${ready.started}`
  );
  if (ready.started) {
    trackOnlineOk('online.game.started', {
      sessionID,
      pubkeyPrefix: resolveTrackPubkeyPrefix(sessionID, payload.roomId),
      roomId: payload.roomId,
      roomCode: room.roomCode,
      buyin: room.buyin,
    });
    publishOnlineMatchStarted(payload.roomId, sessionID);
  }
  io.to(room.roomId).emit('onlineRoomUpdated', serializeRoom(room));
  broadcastOnlineRoomLists();
}

export function onlineSetReadyHandler(
  socket: Socket,
  payload: { roomId: string; ready: boolean }
) {
  const sessionID = socket.data.sessionID as string | undefined;
  const room = getRoomById(payload.roomId);
  if (!sessionID || !room) {
    logOnline(sessionID, `onlineSetReady denied roomId=${payload.roomId}`);
    return;
  }
  const result = setSeatReady(payload.roomId, sessionID, !!payload.ready);
  if (!result.ok) {
    logOnline(sessionID, `onlineSetReady blocked roomId=${payload.roomId} reason=${result.reason}`);
    trackOnlineReject('online.seat.ready', result.reason ?? 'blocked', {
      sessionID,
      roomId: payload.roomId,
    });
    socket.emit('onlinePinInvalid', { reason: result.reason });
    return;
  }
  logOnline(
    sessionID,
    `onlineSetReady roomId=${payload.roomId} ready=${payload.ready} started=${result.started}`
  );
  trackOnlineOk('online.seat.ready', {
    sessionID,
    roomId: payload.roomId,
    roomCode: room.roomCode,
    meta: { ready: payload.ready, started: result.started },
  });
  if (result.started) {
    trackOnlineOk('online.game.started', {
      sessionID,
      pubkeyPrefix: resolveTrackPubkeyPrefix(sessionID, payload.roomId),
      roomId: payload.roomId,
      roomCode: room.roomCode,
      buyin: room.buyin,
    });
    publishOnlineMatchStarted(payload.roomId, sessionID);
  }
  io.to(room.roomId).emit('onlineRoomUpdated', serializeRoom(room));
  broadcastOnlineRoomLists();
}

export function getOnlinePostGameHandler(socket: Socket, payload: { roomId: string }) {
  const sessionID = socket.data.sessionID as string | undefined;
  if (!sessionID) {
    return;
  }
  const room = getRoomById(payload.roomId);
  if (room) {
    // Refresh room membership/socket mapping on postgame entry so seat ownership
    // stays associated through reconnects and route transitions.
    const joined = joinRoom(payload.roomId, sessionID, socket.id);
    socket.join(payload.roomId);
    socket.data.currentOnlineRoomId = payload.roomId;
    if (joined?.matchStarted) {
      publishOnlineMatchStarted(payload.roomId, sessionID);
      io.to(room.roomId).emit('onlineRoomUpdated', serializeRoom(room));
      broadcastOnlineRoomLists();
    }
  }
  const viewer = { sessionID, socketID: socket.id };
  const info = getOnlinePostGame(payload.roomId, viewer);
  if (!info) {
    logOnline(sessionID, `getOnlinePostGame failed roomId=${payload.roomId}`);
    socket.emit('onlinePinInvalid', { reason: 'postgame_unavailable' });
    return;
  }
  const matchRounds = getOnlineMatchRoundHistory(payload.roomId);
  logOnline(
    sessionID,
    `getOnlinePostGame roomId=${payload.roomId} winner=${info.winnerName} points=${info.winnerPoints} rounds=${matchRounds.length}`
  );
  socket.emit('resOnlinePostGameInfo', { ...info, matchRounds });
}

export function getOnlineReplayHandler(socket: Socket, payload: { roomId: string; matchRound?: number }) {
  const sessionID = socket.data.sessionID as string | undefined;
  if (!sessionID) {
    return;
  }
  const replay = getOnlineReplay(payload.roomId, payload.matchRound);
  if (!replay || replay.frameCount === 0) {
    logOnline(sessionID, `getOnlineReplay unavailable roomId=${payload.roomId}`);
    socket.emit('onlinePinInvalid', { reason: 'replay_unavailable' });
    return;
  }
  logOnline(
    sessionID,
    `getOnlineReplay roomId=${payload.roomId} frameCount=${replay.frameCount} tickMs=${replay.tickMs}`
  );
  socket.emit('resOnlineReplay', replay);
}

export async function createOnlineWithdrawalHandler(socket: Socket, payload: { roomId: string }) {
  const sessionID = socket.data.sessionID as string | undefined;
  if (!sessionID) {
    return;
  }
  const viewer = { sessionID, socketID: socket.id };
  const info = getOnlinePostGame(payload.roomId, viewer);
  const room = getRoomById(payload.roomId);
  if (!info || !room || !isOnlineRoomWinnerViewer(room, viewer)) {
    logOnline(sessionID, `createOnlineWithdrawal denied roomId=${payload.roomId}`);
    trackOnlineReject('online.payout.withdrawal', 'only_winner_can_withdraw', {
      sessionID,
      roomId: payload.roomId,
    });
    socket.emit('onlinePinInvalid', { reason: 'only_winner_can_withdraw' });
    return;
  }
  if (info.rematchRequested) {
    socket.emit('onlinePinInvalid', { reason: 'rematch_pending' });
    return;
  }
  if (info.lnurlw || info.payoutMethod === 'nostr_zap' || room.postGame.payoutLock) {
    if (info.lnurlw) {
      socket.emit('resCreateOnlineWithdrawal', { roomId: payload.roomId, lnurlw: info.lnurlw });
      return;
    }
    socket.emit('onlinePinInvalid', { reason: 'withdraw_started' });
    return;
  }
  const amount = netPayoutSats(info.winnerPoints);
  if (amount <= 0) {
    logOnline(sessionID, `createOnlineWithdrawal skipped roomId=${payload.roomId} reason=zero_amount`);
    socket.emit('resCreateOnlineWithdrawal', { roomId: payload.roomId, lnurlw: 'pass' });
    return;
  }
  if (!tryLockOnlinePayout(payload.roomId, 'lnurlw')) {
    socket.emit('onlinePinInvalid', { reason: 'withdraw_started' });
    return;
  }
  const lnurlw = await createLNURLW(amount, P2PMAXWITHDRAWALS);
  if (!lnurlw) {
    unlockOnlinePayout(payload.roomId);
    logOnline(sessionID, `createOnlineWithdrawal failed roomId=${payload.roomId} reason=lnbits_error`);
    socket.emit('onlinePinInvalid', { reason: 'lnurlw_create_failed' });
    return;
  }
  setIDToLNURLW(sessionID, { id: lnurlw.id, lnurlw: lnurlw.lnurl, maxWithdrawals: 1, claimedCount: 0 });
  setLNURLWToID(lnurlw.id, sessionID);
  setOnlinePostGameLnurlw(payload.roomId, lnurlw.lnurl);
  logOnline(sessionID, `createOnlineWithdrawal success roomId=${payload.roomId} amount=${amount}`);
  trackOnlineOk('online.payout.withdrawal', {
    sessionID,
    roomId: payload.roomId,
    amountSats: amount,
  });
  const liveRoom = getRoomById(payload.roomId);
  if (liveRoom) {
    io.to(liveRoom.roomId).emit('onlineRoomUpdated', serializeRoom(liveRoom));
    void publishOnlineThreadReply(
      liveRoom,
      sessionID,
      `ONLINE ROUND CLOSED · room ${liveRoom.roomCode}\nWinner selected payout.\nRound closed.`,
      getSeatMentions(liveRoom.roomId)
    );
  }
  broadcastOnlineRoomLists();
  socket.emit('resCreateOnlineWithdrawal', { roomId: payload.roomId, lnurlw: lnurlw.lnurl });
}

export async function createOnlineNostrPayoutHandler(socket: Socket, payload: { roomId: string }) {
  const sessionID = socket.data.sessionID as string | undefined;
  if (!sessionID) {
    return;
  }
  const viewer = { sessionID, socketID: socket.id };
  const info = getOnlinePostGame(payload.roomId, viewer);
  const room = getRoomById(payload.roomId);
  if (!info || !room || !isOnlineRoomWinnerViewer(room, viewer)) {
    logOnline(sessionID, `createOnlineNostrPayout denied roomId=${payload.roomId}`);
    trackOnlineReject('online.payout.nostr', 'only_winner_can_withdraw', {
      sessionID,
      roomId: payload.roomId,
    });
    socket.emit('onlinePinInvalid', { reason: 'only_winner_can_withdraw' });
    return;
  }
  if (info.rematchRequested) {
    logOnline(sessionID, `createOnlineNostrPayout blocked roomId=${payload.roomId} reason=rematch_pending`);
    socket.emit('onlinePinInvalid', { reason: 'rematch_pending' });
    return;
  }
  if (info.lnurlw || info.payoutMethod === 'nostr_zap' || room.postGame.payoutLock) {
    logOnline(sessionID, `createOnlineNostrPayout blocked roomId=${payload.roomId} reason=withdraw_started`);
    socket.emit('onlinePinInvalid', { reason: 'withdraw_started' });
    return;
  }
  const lnAddress = info.winnerLnAddress;
  if (!lnAddress) {
    logOnline(sessionID, `createOnlineNostrPayout blocked roomId=${payload.roomId} reason=winner_ln_missing`);
    socket.emit('onlinePinInvalid', { reason: 'winner_ln_missing' });
    return;
  }
  const amount = netPayoutSats(info.winnerPoints);
  if (amount <= 0) {
    logOnline(sessionID, `createOnlineNostrPayout skipped roomId=${payload.roomId} reason=zero_amount`);
    socket.emit('onlinePinInvalid', { reason: 'zero_amount' });
    return;
  }
  if (!tryLockOnlinePayout(payload.roomId, 'nostr')) {
    socket.emit('onlinePinInvalid', { reason: 'withdraw_started' });
    return;
  }
  try {
    await payLnAddress(lnAddress, amount);
  } catch (error) {
    unlockOnlinePayout(payload.roomId);
    logOnline(
      sessionID,
      `createOnlineNostrPayout failed roomId=${payload.roomId} ln=${lnAddress} error=${
        error instanceof Error ? error.message : String(error)
      }`
    );
    socket.emit('onlinePinInvalid', { reason: 'nostr_payout_failed' });
    return;
  }
  setOnlinePostGameNostrPayout(payload.roomId, lnAddress);
  logOnline(sessionID, `createOnlineNostrPayout success roomId=${payload.roomId} amount=${amount} ln=${lnAddress}`);
  trackOnlineOk('online.payout.nostr', {
    sessionID,
    roomId: payload.roomId,
    amountSats: amount,
  });
  const liveRoom = getRoomById(payload.roomId);
  if (liveRoom) {
    io.to(liveRoom.roomId).emit('onlineRoomUpdated', serializeRoom(liveRoom));
    void publishOnlineThreadReply(
      liveRoom,
      sessionID,
      `ONLINE ROUND CLOSED · room ${liveRoom.roomCode}\nWinner selected payout.\nRound closed.`,
      getSeatMentions(liveRoom.roomId)
    );
  }
  deleteRoom(payload.roomId);
  broadcastOnlineRoomLists();
  socket.emit('resCreateOnlineNostrPayout', {
    roomId: payload.roomId,
    lnAddress,
    amount,
    ok: true,
  });
}

export function onlineDoubleOrNothingHandler(socket: Socket, payload: { roomId: string }) {
  const sessionID = socket.data.sessionID as string | undefined;
  if (!sessionID) {
    return;
  }
  const vote = voteOnlineDoubleOrNothing(payload.roomId, sessionID);
  if (!vote.ok) {
    logOnline(sessionID, `onlineDoubleOrNothing denied roomId=${payload.roomId} reason=${vote.reason}`);
    trackOnlineReject('online.rematch.vote', vote.reason ?? 'denied', {
      sessionID,
      roomId: payload.roomId,
    });
    socket.emit('onlinePinInvalid', { reason: vote.reason });
    return;
  }
  trackOnlineOk('online.rematch.vote', {
    sessionID,
    roomId: payload.roomId,
    meta: { agreed: vote.agreed, votes: vote.votes },
  });
  io.to(payload.roomId).emit('onlineDoubleOrNothingUpdate', {
    roomId: payload.roomId,
    votes: vote.votes,
    required: 2,
    agreed: vote.agreed,
  });
  const room = getRoomById(payload.roomId);
  if (room) {
    if (vote.agreed) {
      const winnerRole = room.postGame.winnerRole;
      const loserRole =
        winnerRole === PlayerRole.Player1 ? PlayerRole.Player2 : PlayerRole.Player1;
      const loserSeat = loserRole ? room.seats.get(loserRole) : undefined;
      const requiredAmount = Math.max(1, netPayoutSats(room.postGame.winnerPoints));
      markOnlineRematchPending({
        roomId: room.roomId,
        requiredAmount,
        waitingForSessionID: loserSeat?.sessionID,
      });
      const mentions = getSeatMentions(room.roomId);
      const loserLabel = formatOnlinePlayerNostrLabel({
        pubkey: loserSeat?.payMethod === 'lightning' ? undefined : loserSeat?.pubkey,
        name: loserSeat?.name ?? 'the losing player',
        payMethod: loserSeat?.payMethod,
      });
      const roomUrl = onlineRoomPublicUrl(room.roomCode);
      void (async () => {
        try {
          await publishOnlineThreadReply(
            room,
            sessionID,
            [
              `DOUBLE OR NOTHING · room ${room.roomCode}`,
              'Both players agreed to a rematch.',
              `Waiting for ${loserLabel} to pay ${requiredAmount} sats.`,
              '',
              `Join / spectate: ${roomUrl}`,
            ].join('\n'),
            mentions
          );
          const liveForRematch = getRoomById(room.roomId);
          if (!liveForRematch?.kind1EventId) {
            logOnline(sessionID, `onlineDoubleOrNothing rematch skipped roomId=${room.roomId} reason=kind1_missing`);
            return;
          }
          const published = await publishOnlineRematchKind1({
            sessionID,
            rootEventId: liveForRematch.kind1EventId,
            parentEventId: nostrThreadParent(liveForRematch),
            roomId: liveForRematch.roomId,
            roomCode: liveForRematch.roomCode,
            amount: requiredAmount,
            loserPubkey: loserSeat?.pubkey,
            loserName: loserSeat?.name,
            loserPayMethod: loserSeat?.payMethod,
          });
          if (!published) {
            return;
          }
          advanceNostrThreadTip(room.roomId, published.eventId);
          setOnlineRematchRequested({
            roomId: room.roomId,
            requiredAmount,
            rematchEventId: published.eventId,
            rematchNote1: published.note1,
            waitingForSessionID: loserSeat?.sessionID,
          });
          const live = getRoomById(room.roomId);
          if (live) {
            io.to(live.roomId).emit('onlineRoomUpdated', serializeRoom(live));
          }
        } catch (error) {
          logOnline(
            sessionID,
            `onlineDoubleOrNothing rematch publish failed roomId=${room.roomId} error=${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      })();
    }
    const live = getRoomById(payload.roomId);
    if (live) {
      io.to(live.roomId).emit('onlineRoomUpdated', serializeRoom(live));
    }
    broadcastOnlineRoomLists();
  }
}

export function requestOnlineNostrLinkChallengeHandler(socket: Socket, payload: { roomId: string }) {
  const sessionID = socket.data.sessionID as string | undefined;
  if (!sessionID) {
    return;
  }
  const roomId = payload?.roomId;
  if (!roomId) {
    socket.emit('onlinePinInvalid', { reason: 'room_not_found' });
    return;
  }
  const appPk = getAppNostrPubkeyForSession(sessionID);
  if (appPk) {
    const reg = registerNostrLink(roomId, sessionID, socket.id, appPk);
    if (reg.ok) {
      const appRec = getAppNostrSession(sessionID);
      const profile = appRec?.profile ?? {
        pubkey: appPk,
        name: `${appPk.slice(0, 12)}…`,
        picture: null,
      };
      socket.emit('resOnlineNostrLinkOk', {
        expiresAt: reg.expiresAt,
        profile: {
          pubkey: profile.pubkey,
          name: profile.name,
          picture: profile.picture,
        },
      });
      return;
    }
    socket.emit('onlinePinInvalid', { reason: reg.reason });
    return;
  }
  const issued = issueNostrLinkChallenge(sessionID, roomId);
  if (!issued) {
    socket.emit('onlinePinInvalid', { reason: 'nostr_challenge_denied' });
    return;
  }
  socket.emit('resOnlineNostrLinkChallenge', {
    roomId,
    challenge: issued.challenge,
    expiresAt: issued.expiresAt,
  });
}

export async function confirmOnlineNostrLinkHandler(
  socket: Socket,
  payload: { roomId: string; event: unknown }
) {
  const sessionID = socket.data.sessionID as string | undefined;
  if (!sessionID) {
    return;
  }
  const roomId = payload?.roomId;
  const room = roomId ? getRoomById(roomId) : undefined;
  const roomCode = room?.roomCode;
  const trackCtx = {
    sessionID,
    roomId,
    roomCode,
    pubkeyPrefix: resolveTrackPubkeyPrefix(sessionID, roomId),
  };

  if (!roomId) {
    trackEvent({ event: 'online.nostr.link', outcome: 'reject', reason: 'room_not_found', ...trackCtx });
    socket.emit('onlinePinInvalid', { reason: 'room_not_found' });
    return;
  }
  const ev = payload?.event;
  if (!ev || typeof ev !== 'object') {
    trackEvent({ event: 'online.nostr.link', outcome: 'reject', reason: 'nostr_invalid_event', ...trackCtx });
    socket.emit('onlinePinInvalid', { reason: 'nostr_invalid_event' });
    return;
  }
  if (!verifyEvent(ev as Event)) {
    trackEvent({ event: 'online.nostr.link', outcome: 'reject', reason: 'nostr_invalid_signature', ...trackCtx });
    socket.emit('onlinePinInvalid', { reason: 'nostr_invalid_signature' });
    return;
  }
  const event = ev as Event;
  if (event.kind !== 1) {
    trackEvent({ event: 'online.nostr.link', outcome: 'reject', reason: 'nostr_invalid_kind', ...trackCtx });
    socket.emit('onlinePinInvalid', { reason: 'nostr_invalid_kind' });
    return;
  }
  const pending = peekPendingNostrChallenge(sessionID, roomId);
  if (!pending || pending.challenge !== event.content.trim()) {
    trackEvent({ event: 'online.nostr.link', outcome: 'reject', reason: 'nostr_challenge_mismatch', ...trackCtx });
    socket.emit('onlinePinInvalid', { reason: 'nostr_challenge_mismatch' });
    return;
  }
  clearPendingNostrChallenge(sessionID);
  const reg = registerNostrLink(roomId, sessionID, socket.id, event.pubkey);
  if (!reg.ok) {
    trackEvent({
      event: 'online.nostr.link',
      outcome: 'reject',
      reason: reg.reason,
      ...trackCtx,
      pubkeyPrefix: event.pubkey.slice(0, 12),
    });
    socket.emit('onlinePinInvalid', { reason: reg.reason });
    return;
  }
  let profile: { pubkey: string; name: string; picture: string | null };
  try {
    const appProfile = await fetchNostrAppProfile(event.pubkey);
    profile = {
      pubkey: appProfile.pubkey,
      name: appProfile.name,
      picture: appProfile.picture,
    };
  } catch {
    const pk = event.pubkey;
    profile = {
      pubkey: pk,
      name: `${pk.slice(0, 12)}…`,
      picture: null,
    };
  }
  trackEvent({
    event: 'online.nostr.link',
    outcome: 'ok',
    sessionID,
    roomId,
    roomCode,
    pubkeyPrefix: event.pubkey.slice(0, 12),
  });
  socket.emit('resOnlineNostrLinkOk', { expiresAt: reg.expiresAt, profile });
}

export function requestOnlineKind1PostHandler(socket: Socket, payload: { roomId: string }) {
  const roomId = payload?.roomId;
  if (!roomId) {
    socket.emit('resOnlineKind1Post', { roomId: '', ok: false, reason: 'room_not_found' });
    return;
  }
  const room = getRoomById(roomId);
  if (!room) {
    socket.emit('resOnlineKind1Post', { roomId, ok: false, reason: 'room_not_found' });
    return;
  }
  const rematchPending = Boolean(room.postGame.rematchRequested);
  const noteRef = rematchPending
    ? room.postGame.rematchNote1 ?? ''
    : room.nostrMeta?.note1 ?? '';
  if (!noteRef) {
    socket.emit('resOnlineKind1Post', { roomId, ok: false, reason: 'note_not_ready' });
    return;
  }
  void (async () => {
    try {
      const ev = await resolveKind1NoteEvent(noteRef);
      socket.emit('resOnlineKind1Post', await buildOnlineKind1PostPayload(roomId, ev));
    } catch (e) {
      socket.emit('resOnlineKind1Post', {
        roomId,
        ok: false,
        reason: e instanceof Error ? e.message : 'fetch_failed',
      });
    }
  })();
}

export function requestOnlineSeatZapPayPrepareHandler(socket: Socket, payload: { roomId: string }) {
  const sessionID = socket.data.sessionID as string | undefined;
  if (!sessionID) {
    socket.emit('resOnlineSeatZapPayError', { reason: 'no_session' });
    return;
  }
  const roomId = payload?.roomId;
  if (!roomId) {
    socket.emit('resOnlineSeatZapPayError', { reason: 'room_not_found' });
    return;
  }
  const room = getRoomById(roomId);
  if (!room) {
    socket.emit('resOnlineSeatZapPayError', { reason: 'room_not_found' });
    return;
  }
  if (!getActiveNostrLinkPubkey(roomId, sessionID)) {
    socket.emit('resOnlineSeatZapPayError', { reason: 'nostr_not_linked' });
    return;
  }
  const rematchLoser = isRematchLoserSession(room, sessionID);
  let kind1EventId: string | undefined;
  let buyinSats: number;
  if (rematchLoser) {
    kind1EventId = room.postGame.rematchEventId;
    buyinSats = room.postGame.rematchRequiredAmount ?? 0;
    if (!kind1EventId || buyinSats <= 0) {
      socket.emit('resOnlineSeatZapPayError', { reason: 'rematch_not_ready' });
      return;
    }
  } else {
    if (room.phase !== 'lobby') {
      socket.emit('resOnlineSeatZapPayError', { reason: 'room_not_accepting' });
      return;
    }
    if (room.postGame.rematchRequested) {
      socket.emit('resOnlineSeatZapPayError', { reason: 'rematch_locked' });
      return;
    }
    const alreadyPaid = [...room.seats.values()].some(
      (s) => s.sessionID === sessionID && s.status === 'paid'
    );
    if (alreadyPaid) {
      socket.emit('resOnlineSeatZapPayError', { reason: 'already_seated' });
      return;
    }
    const hasOpen = [...room.seats.values()].some((s) => s.status === 'open');
    if (!hasOpen) {
      socket.emit('resOnlineSeatZapPayError', { reason: 'seats_full' });
      return;
    }
    if (!room.kind1EventId) {
      socket.emit('resOnlineSeatZapPayError', { reason: 'kind1_not_ready' });
      return;
    }
    kind1EventId = room.kind1EventId;
    buyinSats = room.buyin;
  }
  if (!allowSocketAction(socket, 'seat_invoice')) {
    socket.emit('resOnlineSeatZapPayError', { reason: 'rate_limited' });
    return;
  }
  void (async () => {
    try {
      const ctx = await resolveOnlineSeatZapContext(kind1EventId!, buyinSats);
      rememberOnlineSeatZapContext(sessionID, roomId, ctx);
      const zapRequestTpl = buildKind1ZapRequestTemplate({
        kind1EventId: kind1EventId!,
        kind1AuthorPubkey: ctx.kind1AuthorPubkey,
        amountMsats: buyinSats * 1000,
        relays: ZAP_RECEIPT_RELAYS,
        comment: '',
        lnurlBech32: ctx.lnurlBech32,
      });
      socket.emit('resOnlineSeatZapPayPrepare', {
        roomId,
        unsignedZap: {
          kind: zapRequestTpl.kind,
          created_at: zapRequestTpl.created_at,
          tags: zapRequestTpl.tags,
          content: zapRequestTpl.content,
        },
        millisats: buyinSats * 1000,
        lnurlBech32: ctx.lnurlBech32,
        buyinSats,
        hostLud16: ctx.hostLud16,
      });
    } catch (e) {
      socket.emit('resOnlineSeatZapPayError', {
        reason: e instanceof Error ? e.message : 'prepare_failed',
      });
    }
  })();
}

export function confirmOnlineSeatZapPayHandler(
  socket: Socket,
  payload: { roomId: string; event: unknown }
) {
  const sessionID = socket.data.sessionID as string | undefined;
  if (!sessionID) {
    socket.emit('resOnlineSeatZapPayError', { reason: 'no_session' });
    return;
  }
  const roomId = payload?.roomId;
  if (!roomId) {
    socket.emit('resOnlineSeatZapPayError', { reason: 'room_not_found' });
    return;
  }
  const raw = payload?.event;
  if (!raw || typeof raw !== 'object') {
    socket.emit('resOnlineSeatZapPayError', { reason: 'invalid_event' });
    return;
  }
  if (!verifyEvent(raw as Event)) {
    socket.emit('resOnlineSeatZapPayError', { reason: 'invalid_signature' });
    return;
  }
  const signed = raw as Event;
  if (signed.kind !== 9734) {
    socket.emit('resOnlineSeatZapPayError', { reason: 'invalid_kind' });
    return;
  }
  const room = getRoomById(roomId);
  if (!room) {
    socket.emit('resOnlineSeatZapPayError', { reason: 'room_not_found' });
    return;
  }
  const linkedPk = getActiveNostrLinkPubkey(roomId, sessionID);
  if (!linkedPk) {
    socket.emit('resOnlineSeatZapPayError', { reason: 'nostr_not_linked' });
    return;
  }
  if (signed.pubkey.toLowerCase() !== linkedPk.toLowerCase()) {
    socket.emit('resOnlineSeatZapPayError', { reason: 'pubkey_mismatch' });
    return;
  }
  const rematchLoser = isRematchLoserSession(room, sessionID);
  const kind1EventId = rematchLoser ? room.postGame.rematchEventId : room.kind1EventId;
  const buyinSats = rematchLoser ? (room.postGame.rematchRequiredAmount ?? 0) : room.buyin;
  if (!kind1EventId || buyinSats <= 0) {
    socket.emit('resOnlineSeatZapPayError', { reason: rematchLoser ? 'rematch_not_ready' : 'kind1_not_ready' });
    return;
  }
  if (!allowSocketAction(socket, 'seat_invoice')) {
    socket.emit('resOnlineSeatZapPayError', { reason: 'rate_limited' });
    return;
  }
  void (async () => {
    try {
      const ctx =
        recallOnlineSeatZapContext(sessionID, roomId, kind1EventId, buyinSats) ??
        (await resolveOnlineSeatZapContext(kind1EventId, buyinSats));
      if (!ctx.meta.callback) {
        socket.emit('resOnlineSeatZapPayError', { reason: 'recipient_lnurl_no_zap' });
        return;
      }
      const pr = await fetchZapInvoiceFromCallback(
        ctx.meta.callback,
        signed,
        ctx.lnurlBech32,
        buyinSats * 1000
      );
      forgetOnlineSeatZapContext(sessionID, roomId);
      registerPendingSeatPayment(
        roomId,
        sessionID,
        socket.id,
        linkedPk,
        kind1EventId
      );
      const lightningUri = pr.startsWith('lightning:') ? pr : `lightning:${pr}`;
      socket.emit('resOnlineSeatZapPayInvoice', {
        roomId,
        pr,
        lightningUri,
        buyinSats,
      });
    } catch (e) {
      socket.emit('resOnlineSeatZapPayError', {
        reason: e instanceof Error ? e.message : 'invoice_failed',
      });
    }
  })();
}

export async function requestOnlineSeatLightningHandler(
  socket: Socket,
  payload: { roomId: string }
) {
  const sessionID = socket.data.sessionID as string | undefined;
  if (!sessionID) {
    return;
  }
  const roomId = payload?.roomId;
  const rejectSeatLightning = (reason: string) => {
    trackOnlineReject('online.seat.lightning.requested', reason, {
      sessionID,
      roomId,
    });
    socket.emit('resOnlineSeatLightningError', { reason });
  };
  if (!roomId) {
    rejectSeatLightning('room_not_found');
    return;
  }
  const room = getRoomById(roomId);
  if (!room) {
    rejectSeatLightning('room_not_found');
    return;
  }
  const rematchLoser = isRematchLoserSession(room, sessionID);
  let payAmount: number;
  let purpose: 'seat' | 'rematch' = 'seat';
  if (rematchLoser) {
    payAmount = room.postGame.rematchRequiredAmount ?? 0;
    if (payAmount <= 0 || !room.postGame.rematchEventId) {
      rejectSeatLightning('rematch_not_ready');
      return;
    }
    purpose = 'rematch';
  } else {
    if (room.phase !== 'lobby') {
      rejectSeatLightning('room_not_accepting');
      return;
    }
    if (room.postGame.rematchRequested) {
      rejectSeatLightning('rematch_locked');
      return;
    }
    const alreadyPaid = [...room.seats.values()].some(
      (s) => s.sessionID === sessionID && s.status === 'paid'
    );
    if (alreadyPaid) {
      rejectSeatLightning('already_seated');
      return;
    }
    const hasOpen = [...room.seats.values()].some((s) => s.status === 'open');
    if (!hasOpen) {
      rejectSeatLightning('seats_full');
      return;
    }
    if (!room.kind1EventId) {
      rejectSeatLightning('kind1_not_ready');
      return;
    }
    payAmount = room.buyin;
  }
  const kind1EventId = purpose === 'rematch' ? room.postGame.rematchEventId : room.kind1EventId;
  if (!kind1EventId) {
    rejectSeatLightning(purpose === 'rematch' ? 'rematch_not_ready' : 'kind1_not_ready');
    return;
  }
  if (!allowSocketAction(socket, 'seat_invoice')) {
    rejectSeatLightning('rate_limited');
    return;
  }
  removeLightningNostrLinksForSession(room.roomId, sessionID);
  const sk = generateSecretKey();
  const pkHex = getPublicKey(sk);
  const nostrReg = registerNostrLink(room.roomId, sessionID, socket.id, pkHex, {
    linkPayMethod: 'lightning',
  });
  if (!nostrReg.ok) {
    rejectSeatLightning(nostrReg.reason);
    return;
  }
  try {
    const ctx = await resolveOnlineSeatZapContext(kind1EventId, payAmount);
    if (!ctx.meta.callback) {
      throw new Error('recipient_lnurl_no_zap');
    }
    const signedZapRequest = finalizeEvent(
      buildKind1ZapRequestTemplate({
        kind1EventId,
        kind1AuthorPubkey: ctx.kind1AuthorPubkey,
        amountMsats: payAmount * 1000,
        relays: ZAP_RECEIPT_RELAYS,
        comment: '',
        lnurlBech32: ctx.lnurlBech32,
      }),
      sk
    );
    const pr = await fetchZapInvoiceFromCallback(
      ctx.meta.callback,
      signedZapRequest,
      ctx.lnurlBech32,
      payAmount * 1000
    );
    const invoiceExpiresAt = bolt11ExpiresAtMs(pr) ?? Date.now() + 60 * 60 * 1000;
    const linkedUntil = extendNostrLinkExpiry(
      room.roomId,
      pkHex,
      invoiceExpiresAt + ONLINE_SEAT_LIGHTNING_RECEIPT_GRACE_MS
    );
    if (linkedUntil == null) {
      return;
    }
    const lightningUri = pr.startsWith('lightning:') ? pr : `lightning:${pr}`;
    socket.emit('resOnlineSeatLightning', {
      roomId: room.roomId,
      pr,
      lightningUri,
      buyin: payAmount,
      expiresAt: invoiceExpiresAt,
    });
    trackOnlineOk('online.seat.lightning.requested', {
      sessionID,
      roomId: room.roomId,
      roomCode: room.roomCode,
      buyin: payAmount,
      meta: { purpose },
    });
  } catch (e) {
    removeNostrLinkRegistrationForPubkey(room.roomId, pkHex, sessionID);
    const current = getLightningNostrLinkPubkey(room.roomId, sessionID);
    if (current && current !== pkHex.toLowerCase()) {
      return;
    }
    rejectSeatLightning(e instanceof Error ? e.message : 'invoice_failed');
  }
}

export function cancelOnlineSeatLightningHandler(socket: Socket) {
  const sessionID = socket.data.sessionID as string | undefined;
  if (!sessionID) {
    return;
  }
  const room = getRoomBySession(sessionID);
  if (room) {
    removeLightningNostrLinksForSession(room.roomId, sessionID);
  }
  socket.emit('resOnlineSeatLightningCancelled', {});
}

/** Host zap invoices expire on their own timer. Fall back to the BOLT11 default of one hour. */
function bolt11ExpiresAtMs(pr: string): number | undefined {
  try {
    const raw = pr.trim().replace(/^lightning:/i, '');
    const decoded = decode(raw);
    const sections = decoded.sections as Array<{ name?: string; value?: unknown }>;
    const readNumber = (name: string) => {
      const section = sections.find((item) => item.name === name);
      const value = typeof section?.value === 'number' ? section.value : Number(section?.value);
      return Number.isFinite(value) ? value : undefined;
    };
    const timestampSec = readNumber('timestamp');
    const expirySec = readNumber('expiry') ?? 3600;
    if (timestampSec == null) {
      return undefined;
    }
    return (timestampSec + expirySec) * 1000;
  } catch {
    return undefined;
  }
}

export function startOnlineLoop() {
  setOnlineRoomChangeNotifier(({ roomId, prev, next, roomNotFound }) => {
    const live = getRoomById(roomId);
    if (live && prev === 'playing' && next === 'postgame') {
      publishOnlineMatchResult(live);
    }
    if (live) {
      io.to(roomId).emit('onlineRoomUpdated', serializeRoom(live));
    } else if (roomNotFound) {
      io.to(roomId).emit('onlinePinInvalid', { reason: 'room_not_found' });
    }
    broadcastOnlineRoomLists();
  });
  setInterval(() => {
    syncOnlineSeatSockets((socketID) => {
      const sock = io.sockets.sockets.get(socketID);
      return Boolean(sock?.connected);
    });
    for (const job of takeDueClaimPayouts()) {
      void payClaimClock(job);
    }
    const rooms = listOnlineRooms();
    for (const room of rooms) {
      if (room.phase === 'playing') {
        stepRoomSnapshot(room.roomId);
        const live = getRoomById(room.roomId);
        if (!live || live.phase !== 'playing') {
          continue;
        }
        const forfeit = getOnlineForfeitStatus(live);
        io.to(room.roomId).emit('onlineRoomSnapshot', {
          roomId: live.roomId,
          snapshot: pruneOnlineSnapshotForWire(live.snapshot),
          ...(forfeit ? { forfeit } : {}),
        });
        continue;
      }
      const live = getRoomById(room.roomId);
      if (!live) {
        continue;
      }
      const clock =
        live.phase === 'lobby' ? getOnlineForfeitStatus(live) : getOnlineClaimStatus(live);
      if (!clock) {
        lastClockRoomEmit.delete(live.roomId);
        continue;
      }
      const now = Date.now();
      const previous = lastClockRoomEmit.get(live.roomId) ?? 0;
      if (now - previous < ONLINE_CLOCK_EMIT_MS) {
        continue;
      }
      lastClockRoomEmit.set(live.roomId, now);
      io.to(live.roomId).emit('onlineRoomUpdated', serializeRoom(live));
    }
  }, ONLINE_TICK_MS);
}

async function payClaimClock(job: {
  roomId: string;
  lnAddress: string;
  amountSats: number;
  winnerSessionID?: string;
}) {
  try {
    await payLnAddress(job.lnAddress, job.amountSats);
  } catch (error) {
    logOnline(
      job.winnerSessionID,
      `claim payout failed roomId=${job.roomId} ln=${job.lnAddress} error=${
        error instanceof Error ? error.message : String(error)
      }`
    );
    failOnlineClaimPayout(job.roomId);
    return;
  }
  completeOnlineClaimPayout(job.roomId, job.lnAddress);
  logOnline(
    job.winnerSessionID,
    `claim payout success roomId=${job.roomId} amount=${job.amountSats} ln=${job.lnAddress}`
  );
  trackOnlineOk('online.payout.nostr', {
    sessionID: job.winnerSessionID,
    roomId: job.roomId,
    amountSats: job.amountSats,
    meta: { claim: true },
  });
  const liveRoom = getRoomById(job.roomId);
  if (liveRoom) {
    io.to(liveRoom.roomId).emit('onlineRoomUpdated', serializeRoom(liveRoom));
    void publishOnlineThreadReply(
      liveRoom,
      job.winnerSessionID ?? liveRoom.hostSessionID,
      `ONLINE ROUND CLOSED · room ${liveRoom.roomCode}\nWinner payout sent.\nRound closed.`,
      getSeatMentions(liveRoom.roomId)
    );
  }
  broadcastOnlineRoomLists();
}

async function payLnAddress(lnAddress: string, satsAmount: number) {
  const [userLN, domainLN] = lnAddress.split('@');
  if (!userLN || !domainLN) {
    throw new Error('invalid_ln_address');
  }
  const lnurl = `https://${domainLN}/.well-known/lnurlp/${userLN}`;
  const callback = await getLNURLCallback(lnurl);
  const invoice = await getInvoiceFromCallback(callback, satsAmount);
  await payInvoice(invoice);
}
