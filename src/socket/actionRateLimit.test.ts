import type { Socket } from 'socket.io';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createLNURLPMock } = vi.hoisted(() => {
  let n = 0;
  return {
    createLNURLPMock: vi.fn(async () => {
      n += 1;
      return {
        id: `link-${n}`,
        lnurl: `lnurl-${n}`,
        description: 'Player',
        min: 1,
        max: 100,
      };
    }),
  };
});

vi.mock('../server', () => ({
  io: {
    to: vi.fn(() => ({ emit: vi.fn() })),
    emit: vi.fn(),
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

vi.mock('../calls/LNBits/createLNURLP', () => ({
  default: createLNURLPMock,
}));

import { publishGameKind1 } from '../calls/NDK/publishGameKind1';
import {
  createOnlineRoom,
  deleteRoom,
  getRoomById,
  seatPaidPlayer,
  setRoomNostrMeta,
  setRoomPhase,
} from '../state/onlineRoomState';
import { getP2PMenuInfos } from './P2PMenu';
import {
  allowSocketAction,
  resetSocketActionRateLimitsForTests,
} from './actionRateLimit';
import {
  createOnlineRoomHandler,
  requestOnlineSeatLightningHandler,
  roomInputHandler,
} from './onlineRoom';

const createdRoomIds: string[] = [];

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

beforeEach(() => {
  resetSocketActionRateLimitsForTests();
  vi.mocked(publishGameKind1).mockClear();
  createLNURLPMock.mockClear();
});

afterEach(() => {
  for (const roomId of createdRoomIds) {
    deleteRoom(roomId);
  }
  createdRoomIds.length = 0;
  resetSocketActionRateLimitsForTests();
});

describe('socket action rate limits', () => {
  it('refuses the 4th room creation within a minute and still accepts play input', async () => {
    const sessionID = 'rate-play-host';
    const { socket, emitted } = fakeSocket(sessionID, '203.0.113.77');
    const room = createOnlineRoom({
      hostSessionID: sessionID,
      hostSocketID: socket.id,
      buyin: 1000,
    });
    createdRoomIds.push(room.roomId);
    seatPaidPlayer({
      roomId: room.roomId,
      sessionID,
      socketID: socket.id,
      amount: 1000,
      name: 'Ada',
    });
    setRoomPhase(room.roomId, 'playing');

    for (let i = 0; i < 40; i += 1) {
      roomInputHandler(socket, { roomId: room.roomId, input: { up: true } });
    }
    expect(getRoomById(room.roomId)?.inputBySession.get(sessionID)?.up).toBe(true);

    for (let i = 0; i < 4; i += 1) {
      await createOnlineRoomHandler(socket);
    }

    const createdEvents = emitted.filter((event) => event.event === 'resCreateOnlineRoom');
    expect(createdEvents).toHaveLength(3);
    expect(emitted.filter((event) => event.event === 'onlinePinInvalid')).toEqual([
      { event: 'onlinePinInvalid', payload: { reason: 'rate_limited' } },
    ]);
    expect(getRoomById(room.roomId)?.inputBySession.get(sessionID)?.up).toBe(true);

    await new Promise((resolve) => setImmediate(resolve));
    expect(publishGameKind1).toHaveBeenCalledTimes(3);

    for (const event of createdEvents) {
      createdRoomIds.push((event.payload as { roomId: string }).roomId);
    }
  });

  it('refuses a new session once the IP has created 3 rooms', () => {
    const ip = '203.0.113.50';
    for (let i = 0; i < 3; i += 1) {
      const { socket } = fakeSocket(`rate-ip-${i}`, ip);
      expect(allowSocketAction(socket, 'room_create')).toBe(true);
    }
    const { socket } = fakeSocket('rate-ip-3', ip);
    expect(allowSocketAction(socket, 'room_create')).toBe(false);
  });

  it('does not share a bucket across loopback sockets', () => {
    for (let i = 0; i < 4; i += 1) {
      const { socket } = fakeSocket(`rate-loop-${i}`, '127.0.0.1');
      expect(allowSocketAction(socket, 'room_create')).toBe(true);
    }
  });

  it('refuses the 7th lightning invoice on an otherwise valid seat', async () => {
    const sessionID = 'rate-invoice-host';
    const { socket, emitted } = fakeSocket(sessionID, '203.0.113.88');
    const room = createOnlineRoom({
      hostSessionID: sessionID,
      hostSocketID: socket.id,
      buyin: 1000,
    });
    createdRoomIds.push(room.roomId);
    setRoomNostrMeta(
      room.roomId,
      { note1: 'note', min: 1000, mode: 'ONLINE' },
      'b'.repeat(64)
    );
    for (let i = 0; i < 6; i += 1) {
      expect(allowSocketAction(socket, 'seat_invoice')).toBe(true);
    }

    await requestOnlineSeatLightningHandler(socket, { roomId: room.roomId });

    expect(emitted).toEqual([
      { event: 'resOnlineSeatLightningError', payload: { reason: 'rate_limited' } },
    ]);
  });

  it('refuses the 7th pay-link menu and still returns an existing menu', async () => {
    const ip = '198.51.100.20';
    for (let i = 0; i < 6; i += 1) {
      const { socket } = fakeSocket(`rate-menu-${i}`, ip);
      await getP2PMenuInfos(socket);
    }
    expect(createLNURLPMock).toHaveBeenCalledTimes(12);

    const blocked = fakeSocket('rate-menu-6', ip);
    await getP2PMenuInfos(blocked.socket);
    expect(createLNURLPMock).toHaveBeenCalledTimes(12);
    expect(blocked.emitted).toEqual([
      { event: 'resGetGameMenuInfos', payload: { reason: 'rate_limited' } },
    ]);

    const refresh = fakeSocket('rate-menu-0', ip);
    await getP2PMenuInfos(refresh.socket);
    expect(createLNURLPMock).toHaveBeenCalledTimes(12);
    expect(Array.isArray(refresh.emitted[0]?.payload)).toBe(true);
  });
});
