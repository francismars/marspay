import type { Socket } from 'socket.io';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUYINMAX, BUYINMIN, P2PMAXWITHDRAWALS } from '../consts/values';
import { GameMode, PlayerRole } from '../types/game';
import { netPayoutSats } from '../utils/payout';

const {
  createLNURLPMock,
  createLNURLWMock,
  payInvoiceMock,
  getLNURLCallbackMock,
  getInvoiceFromCallbackMock,
  fetchZapInvoiceMock,
  resolveZapContextMock,
} = vi.hoisted(() => {
  let payLink = 0;
  let withdrawLink = 0;
  return {
    createLNURLPMock: vi.fn(async (description: string, min: number, max: number) => {
      payLink += 1;
      return {
        id: `pay-${payLink}`,
        lnurlp: `lnurlp-${payLink}`,
        description,
        min,
        max,
      };
    }),
    createLNURLWMock: vi.fn(async (amount: number, uses: number) => {
      withdrawLink += 1;
      return {
        id: `withdraw-${withdrawLink}`,
        lnurl: `lnurlw-${amount}-${uses}-${withdrawLink}`,
      };
    }),
    payInvoiceMock: vi.fn(async () => ({})),
    getLNURLCallbackMock: vi.fn(async () => 'https://cb.example/callback'),
    getInvoiceFromCallbackMock: vi.fn(async () => 'bolt11-prize'),
    fetchZapInvoiceMock: vi.fn(async () => 'lnbc1testinvoice'),
    resolveZapContextMock: vi.fn(async (kind1EventId: string, buyinSats: number) => ({
      kind1EventId,
      buyinSats,
      hostLud16: 'host@pay.example',
      meta: {
        callback: 'https://cb.example/zap',
        allowsNostr: true,
        nostrPubkey: '11'.repeat(32),
      },
      lnurlBech32: 'lnurl1host',
      kind1AuthorPubkey: '22'.repeat(32),
    })),
  };
});

vi.mock('../io', () => ({
  io: {
    to: vi.fn(() => ({ emit: vi.fn() })),
    emit: vi.fn(),
    sockets: { sockets: new Map() },
  },
}));

vi.mock('../telemetry/onlineTelemetry', () => ({
  trackOnlineOk: vi.fn(),
  trackOnlineReject: vi.fn(),
  maybeTrackOnlinePing: vi.fn(),
}));

vi.mock('../calls/NDK/setNDKInstance', () => ({
  setNDKInstance: vi.fn(async () => undefined),
}));

vi.mock('../calls/NDK/publishGameKind1', () => ({
  publishGameKind1: vi.fn(async () => null),
}));

vi.mock('../calls/NDK/publishOnlineKind1Reply', () => ({
  publishOnlineKind1Reply: vi.fn(async () => undefined),
}));

vi.mock('../calls/NDK/publishEndGameKind1', () => ({
  publishEndGameKind1: vi.fn(),
}));

vi.mock('../calls/LNBits/createLNURLP', () => ({
  default: createLNURLPMock,
}));

vi.mock('../calls/LNBits/createLNURLW', () => ({
  default: createLNURLWMock,
}));

vi.mock('../calls/LNBits/deleteLNURLP', () => ({
  default: vi.fn(async () => undefined),
}));

vi.mock('../calls/LNBits/payInvoice', () => ({
  default: payInvoiceMock,
}));

vi.mock('../calls/LNAddress/getLNURLCallback', () => ({
  default: getLNURLCallbackMock,
}));

vi.mock('../calls/LNAddress/getInvoiceFromCallback', () => ({
  default: getInvoiceFromCallbackMock,
}));

vi.mock('../calls/nostr/resolveOnlineSeatZapContext', () => ({
  resolveOnlineSeatZapContext: resolveZapContextMock,
}));

vi.mock('../calls/nostr/lnurlZapShared', async () => {
  const actual = await vi.importActual<typeof import('../calls/nostr/lnurlZapShared')>(
    '../calls/nostr/lnurlZapShared'
  );
  return {
    ...actual,
    fetchZapInvoiceFromCallback: fetchZapInvoiceMock,
  };
});

vi.mock('../state/onlineRoomArchive', async () => {
  const actual = await vi.importActual<typeof import('../state/onlineRoomArchive')>(
    '../state/onlineRoomArchive'
  );
  return {
    ...actual,
    appendOnlineMatchArchive: vi.fn(async () => {}),
    appendOnlineRoomArchive: vi.fn(async () => {}),
  };
});

vi.mock('nostr-tools', async () => {
  const actual = await vi.importActual<typeof import('nostr-tools')>('nostr-tools');
  return {
    ...actual,
    verifyEvent: vi.fn(() => true),
  };
});

import { verifyEvent } from 'nostr-tools';
import { deleteGameInfoByID, setGameInfoByID } from '../state/gameState';
import { deleteLNURLPsFromSession } from '../state/lnurlpState';
import { deleteLNURLWFromSession } from '../state/lnurlwState';
import {
  createOnlineRoom,
  deleteRoom,
  getRoomById,
  hasPendingSeatPaymentForSession,
  registerNostrLink,
  seatPaidPlayer,
  setRoomNostrMeta,
  stepRoomSnapshot,
} from '../state/onlineRoomState';
import { getP2PMenuInfos } from './P2PMenu';
import { resetSocketActionRateLimitsForTests } from './actionRateLimit';
import {
  confirmOnlineSeatZapPayHandler,
  createOnlineNostrPayoutHandler,
  createOnlineWithdrawalHandler,
  requestOnlineSeatLightningHandler,
} from './onlineRoom';
import { createWithdrawalPostGame } from './postGame';

const roomIds: string[] = [];
const sessionIDs: string[] = [];

function trackSession(sessionID: string) {
  sessionIDs.push(sessionID);
  return sessionID;
}

function fakeSocket(sessionID: string, ip = '203.0.113.10') {
  const emitted: { event: string; payload: unknown }[] = [];
  const socket = {
    id: `sock-${sessionID}`,
    data: { sessionID },
    handshake: {
      headers: { 'x-real-ip': ip },
      address: '127.0.0.1',
    },
    join: vi.fn(),
    emit(event: string, payload: unknown) {
      emitted.push({ event, payload });
    },
  };
  return { socket: socket as unknown as Socket, emitted };
}

function lobbyWithKind1(label: string, buyin = 1000) {
  const sessionID = trackSession(`${label}-seat`);
  const { socket, emitted } = fakeSocket(sessionID, `203.0.113.${sessionIDs.length}`);
  const room = createOnlineRoom({
    hostSessionID: sessionID,
    hostSocketID: socket.id,
    buyin,
  });
  roomIds.push(room.roomId);
  const kind1EventId = `${label}-kind1`.padEnd(64, 'a');
  setRoomNostrMeta(room.roomId, { note1: 'note', min: buyin, mode: 'ONLINE' }, kind1EventId);
  return { sessionID, socket, emitted, room: getRoomById(room.roomId)!, kind1EventId };
}

/** Both seats paid, match ended, host (P1) won 2000 points. */
function finishedMatch(label: string) {
  const host = trackSession(`${label}-host`);
  const guest = trackSession(`${label}-guest`);
  const room = createOnlineRoom({
    hostSessionID: host,
    hostSocketID: `${host}-sock`,
    buyin: 1000,
  });
  roomIds.push(room.roomId);
  seatPaidPlayer({
    roomId: room.roomId,
    sessionID: host,
    socketID: `${host}-sock`,
    amount: 1000,
    name: 'Ada',
  });
  seatPaidPlayer({
    roomId: room.roomId,
    sessionID: guest,
    socketID: `${guest}-sock`,
    amount: 1000,
    name: 'Bea',
  });
  const live = getRoomById(room.roomId)!;
  live.snapshot.state.gameStarted = true;
  live.snapshot.state.gameEnded = true;
  live.snapshot.state.winnerPlayer = 'P1';
  live.snapshot.state.winnerName = 'Ada';
  live.snapshot.state.score = [2000, 0];
  stepRoomSnapshot(room.roomId);
  return { room: getRoomById(room.roomId)!, host, guest };
}

beforeEach(() => {
  resetSocketActionRateLimitsForTests();
  vi.mocked(verifyEvent).mockReturnValue(true);
  createLNURLPMock.mockClear();
  createLNURLWMock.mockClear();
  payInvoiceMock.mockClear();
  getLNURLCallbackMock.mockClear();
  getInvoiceFromCallbackMock.mockClear();
  fetchZapInvoiceMock.mockClear();
  resolveZapContextMock.mockClear();
});

afterEach(() => {
  for (const roomId of roomIds) {
    deleteRoom(roomId);
  }
  roomIds.length = 0;
  for (const sessionID of sessionIDs) {
    deleteLNURLWFromSession(sessionID);
    deleteLNURLPsFromSession(sessionID);
    deleteGameInfoByID(sessionID);
  }
  sessionIDs.length = 0;
  resetSocketActionRateLimitsForTests();
});

describe('online withdraw and nostr payout', () => {
  it('refuses a withdraw from the loser', async () => {
    const { room, guest } = finishedMatch('withdraw-loser');
    const { socket, emitted } = fakeSocket(guest);

    await createOnlineWithdrawalHandler(socket, { roomId: room.roomId });

    expect(emitted).toEqual([
      { event: 'onlinePinInvalid', payload: { reason: 'only_winner_can_withdraw' } },
    ]);
    expect(createLNURLWMock).not.toHaveBeenCalled();
    expect(getRoomById(room.roomId)?.postGame.lnurlw).toBeUndefined();
  });

  it('pays the winner the net of their points, and a second request returns the same link', async () => {
    const { room, host } = finishedMatch('withdraw-winner');
    const { socket, emitted } = fakeSocket(host);
    const net = netPayoutSats(2000);

    await createOnlineWithdrawalHandler(socket, { roomId: room.roomId });

    expect(createLNURLWMock).toHaveBeenCalledTimes(1);
    expect(createLNURLWMock).toHaveBeenCalledWith(net, P2PMAXWITHDRAWALS);
    const created = await createLNURLWMock.mock.results[0]?.value;
    const lnurlw = { roomId: room.roomId, lnurlw: created.lnurl };
    expect(emitted).toContainEqual({ event: 'resCreateOnlineWithdrawal', payload: lnurlw });
    expect(getRoomById(room.roomId)?.phase).toBe('finished');

    await createOnlineWithdrawalHandler(socket, { roomId: room.roomId });

    expect(createLNURLWMock).toHaveBeenCalledTimes(1);
    expect(emitted.filter((event) => event.event === 'resCreateOnlineWithdrawal')).toEqual([
      { event: 'resCreateOnlineWithdrawal', payload: lnurlw },
      { event: 'resCreateOnlineWithdrawal', payload: lnurlw },
    ]);

    await createOnlineNostrPayoutHandler(socket, { roomId: room.roomId });

    expect(emitted.at(-1)).toEqual({
      event: 'onlinePinInvalid',
      payload: { reason: 'withdraw_started' },
    });
    expect(payInvoiceMock).not.toHaveBeenCalled();
    expect(getRoomById(room.roomId)?.roomId).toBe(room.roomId);
  });

  it('refuses a nostr payout when the winner has no lightning address', async () => {
    const { room, host } = finishedMatch('nostr-missing');
    const { socket, emitted } = fakeSocket(host);

    await createOnlineNostrPayoutHandler(socket, { roomId: room.roomId });

    expect(emitted).toEqual([
      { event: 'onlinePinInvalid', payload: { reason: 'winner_ln_missing' } },
    ]);
    expect(payInvoiceMock).not.toHaveBeenCalled();
    expect(getRoomById(room.roomId)?.phase).toBe('postgame');
  });

  it('pays a nostr payout of the net amount and deletes the room', async () => {
    const { room, host } = finishedMatch('nostr-pay');
    getRoomById(room.roomId)!.seats.get(PlayerRole.Player1)!.lnAddress = 'ada@pay.example';
    const { socket, emitted } = fakeSocket(host);
    const net = netPayoutSats(2000);

    await createOnlineNostrPayoutHandler(socket, { roomId: room.roomId });

    expect(getLNURLCallbackMock).toHaveBeenCalledWith(
      'https://pay.example/.well-known/lnurlp/ada'
    );
    expect(getInvoiceFromCallbackMock).toHaveBeenCalledWith('https://cb.example/callback', net);
    expect(payInvoiceMock).toHaveBeenCalledWith('bolt11-prize');
    expect(emitted).toContainEqual({
      event: 'resCreateOnlineNostrPayout',
      payload: { roomId: room.roomId, lnAddress: 'ada@pay.example', amount: net, ok: true },
    });
    expect(getRoomById(room.roomId)).toBeUndefined();
  });
});

describe('online seat payment', () => {
  it('returns a lightning invoice for the room buy-in', async () => {
    const { socket, emitted, room } = lobbyWithKind1('ln-seat', 1000);

    await requestOnlineSeatLightningHandler(socket, { roomId: room.roomId });

    expect(fetchZapInvoiceMock).toHaveBeenCalledWith(
      'https://cb.example/zap',
      expect.anything(),
      'lnurl1host',
      1_000_000
    );
    expect(emitted).toEqual([
      expect.objectContaining({
        event: 'resOnlineSeatLightning',
        payload: expect.objectContaining({
          roomId: room.roomId,
          pr: 'lnbc1testinvoice',
          buyin: 1000,
        }),
      }),
    ]);
  });

  it('refuses a lightning invoice when that session already holds a seat', async () => {
    const { socket, emitted, room, sessionID } = lobbyWithKind1('ln-seated', 1000);
    seatPaidPlayer({
      roomId: room.roomId,
      sessionID,
      socketID: socket.id,
      amount: 1000,
      name: 'Ada',
    });

    await requestOnlineSeatLightningHandler(socket, { roomId: room.roomId });

    expect(emitted).toEqual([
      { event: 'resOnlineSeatLightningError', payload: { reason: 'already_seated' } },
    ]);
    expect(fetchZapInvoiceMock).not.toHaveBeenCalled();
  });

  it('returns a zap invoice for the linked pubkey and remembers the pending seat', async () => {
    const { socket, emitted, room, sessionID } = lobbyWithKind1('zap-seat', 1000);
    const linkedPk = 'cd'.repeat(32);
    expect(
      registerNostrLink(room.roomId, sessionID, socket.id, linkedPk)
    ).toMatchObject({ ok: true });

    confirmOnlineSeatZapPayHandler(socket, {
      roomId: room.roomId,
      event: {
        kind: 9734,
        pubkey: linkedPk.toUpperCase(),
        content: '',
        created_at: 1,
        tags: [],
        id: 'e'.repeat(64),
        sig: 'f'.repeat(128),
      },
    });
    await vi.waitFor(() => {
      expect(emitted.some((event) => event.event === 'resOnlineSeatZapPayInvoice')).toBe(true);
    });

    expect(fetchZapInvoiceMock).toHaveBeenCalledWith(
      'https://cb.example/zap',
      expect.objectContaining({ pubkey: linkedPk.toUpperCase() }),
      'lnurl1host',
      1_000_000
    );
    expect(emitted).toContainEqual({
      event: 'resOnlineSeatZapPayInvoice',
      payload: {
        roomId: room.roomId,
        pr: 'lnbc1testinvoice',
        lightningUri: 'lightning:lnbc1testinvoice',
        buyinSats: 1000,
      },
    });
    expect(hasPendingSeatPaymentForSession(sessionID, room.roomId)).toBe(true);
    expect(getRoomById(room.roomId)?.seats.get(PlayerRole.Player1)?.status).toBe('open');
  });

  it('refuses a zap signed by a pubkey that is not linked to that seat', async () => {
    const { socket, emitted, room, sessionID } = lobbyWithKind1('zap-mismatch', 1000);
    registerNostrLink(room.roomId, sessionID, socket.id, 'cd'.repeat(32));

    confirmOnlineSeatZapPayHandler(socket, {
      roomId: room.roomId,
      event: {
        kind: 9734,
        pubkey: 'ab'.repeat(32),
        content: '',
        created_at: 1,
        tags: [],
        id: 'e'.repeat(64),
        sig: 'f'.repeat(128),
      },
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(emitted).toEqual([
      { event: 'resOnlineSeatZapPayError', payload: { reason: 'pubkey_mismatch' } },
    ]);
    expect(fetchZapInvoiceMock).not.toHaveBeenCalled();
    expect(hasPendingSeatPaymentForSession(sessionID, room.roomId)).toBe(false);
  });
});

describe('P2P menu', () => {
  it('creates two P2P pay links at the minimum buy-in', async () => {
    const sessionID = trackSession('p2p-menu');
    const { socket, emitted } = fakeSocket(sessionID, '198.51.100.40');

    await getP2PMenuInfos(socket);

    expect(createLNURLPMock).toHaveBeenCalledTimes(2);
    expect(createLNURLPMock).toHaveBeenNthCalledWith(1, 'Player 1', BUYINMIN, BUYINMAX);
    expect(createLNURLPMock).toHaveBeenNthCalledWith(2, 'Player 2', BUYINMIN, BUYINMAX);
    expect(emitted[0]).toEqual({
      event: 'resGetGameMenuInfos',
      payload: [
        expect.objectContaining({ description: 'Player 1', min: BUYINMIN, mode: GameMode.P2P }),
        expect.objectContaining({ description: 'Player 2', min: BUYINMIN, mode: GameMode.P2P }),
      ],
    });
  });
});

describe('P2P and tournament postgame withdraw', () => {
  it('withdraws the P2P winner stake with no house fee', async () => {
    const sessionID = trackSession('postgame-p2p');
    setGameInfoByID(sessionID, {
      mode: GameMode.P2P,
      winners: [PlayerRole.Player2],
      players: new Map([
        [PlayerRole.Player1, { name: 'Ada', value: 1000 }],
        [PlayerRole.Player2, { name: 'Bea', value: 4100 }],
      ]),
    });
    const { socket, emitted } = fakeSocket(sessionID);

    await createWithdrawalPostGame(socket);

    expect(createLNURLWMock).toHaveBeenCalledTimes(1);
    expect(createLNURLWMock).toHaveBeenCalledWith(4100, P2PMAXWITHDRAWALS);
    const created = await createLNURLWMock.mock.results[0]?.value;
    expect(emitted).toEqual([{ event: 'resCreateWithdrawalPostGame', payload: created.lnurl }]);
  });

  it('withdraws a tournament pot of player-one stake times the field, after the fee', async () => {
    const sessionID = trackSession('postgame-tournament');
    setGameInfoByID(sessionID, {
      mode: GameMode.TOURNAMENT,
      numberOfPlayers: 4,
      winners: [PlayerRole.Player2],
      players: new Map([
        [PlayerRole.Player1, { name: 'Ada', value: 1000 }],
        [PlayerRole.Player2, { name: 'Bea', value: 9999 }],
      ]),
    });
    const { socket, emitted } = fakeSocket(sessionID);
    const net = netPayoutSats(1000 * 4);

    await createWithdrawalPostGame(socket);

    expect(createLNURLWMock).toHaveBeenCalledTimes(1);
    expect(createLNURLWMock).toHaveBeenCalledWith(net, P2PMAXWITHDRAWALS);
    const created = await createLNURLWMock.mock.results[0]?.value;
    expect(emitted).toEqual([{ event: 'resCreateWithdrawalPostGame', payload: created.lnurl }]);
  });
});
