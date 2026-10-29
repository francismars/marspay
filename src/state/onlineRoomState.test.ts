import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlayerRole } from '../types/game';
import { setIDToSocket } from './sessionState';
import { cleanupInactiveSessions } from './cleanupState';
import { createOnlineRoom, getRoomById, seatPaidPlayer } from './onlineRoomState';

vi.mock('../telemetry/onlineTelemetry', () => ({
  trackOnlineOk: vi.fn(),
  trackOnlineReject: vi.fn(),
  maybeTrackOnlinePing: vi.fn(),
}));

vi.mock('./onlineRoomArchive', async () => {
  const actual = await vi.importActual<typeof import('./onlineRoomArchive')>('./onlineRoomArchive');
  return {
    ...actual,
    appendOnlineMatchArchive: vi.fn(async () => {}),
    appendOnlineRoomArchive: vi.fn(async () => {}),
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('session cleanup leaves paid seats', () => {
  it('marks the seat disconnected and drops the member when the session is removed', () => {
    const host = 'cleanup-host';
    const room = createOnlineRoom({
      hostSessionID: host,
      hostSocketID: `${host}-sock`,
      buyin: 1000,
    });
    seatPaidPlayer({
      roomId: room.roomId,
      sessionID: host,
      socketID: `${host}-sock`,
      amount: 1000,
      name: 'Ada',
    });
    setIDToSocket(host, { socketID: `${host}-sock`, lastSeen: 0 });
    cleanupInactiveSessions(0);
    const live = getRoomById(room.roomId)!;
    expect(live.seats.get(PlayerRole.Player1)?.disconnectedAt).toEqual(expect.any(Number));
    expect(live.seats.get(PlayerRole.Player1)?.status).toBe('paid');
    expect(live.seats.get(PlayerRole.Player1)?.paidAmount).toBe(1000);
    expect(live.members.has(host)).toBe(false);
  });
});
