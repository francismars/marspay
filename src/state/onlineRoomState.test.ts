import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlayerRole } from '../types/game';
import { clearSteeringOnRespawn } from '../game/onlineInput';
import { netPayoutSats } from '../utils/payout';
import { trackOnlineOk } from '../telemetry/onlineTelemetry';
import { setIDToSocket } from './sessionState';
import { cleanupInactiveSessions } from './cleanupState';
import { appendOnlineMatchArchive } from './onlineRoomArchive';
import {
  ONLINE_CLAIM_PRESENCE_MS,
  ONLINE_FORFEIT_DISCONNECT_MS,
  ONLINE_IDLE_GRACE_MS,
  completeOnlineClaimPayout,
  confirmOnlineStart,
  createOnlineRoom,
  getOnlineClaimStatus,
  getOnlineForfeitStatus,
  getRoomById,
  joinRoom,
  leaveRoom,
  resolveOnlineDisconnects,
  runOnlineRoomCleanup,
  seatPaidPlayer,
  serializeRoom,
  stepRoomSnapshot,
  takeDueClaimPayouts,
  tryLockOnlinePayout,
  updateRoomInput,
} from './onlineRoomState';

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
  vi.useRealTimers();
  vi.clearAllMocks();
  takeDueClaimPayouts();
});

function paidMatch(label: string) {
  const host = `${label}-host`;
  const guest = `${label}-guest`;
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
  seatPaidPlayer({
    roomId: room.roomId,
    sessionID: guest,
    socketID: `${guest}-sock`,
    amount: 1000,
    name: 'Bea',
  });
  return { room: getRoomById(room.roomId)!, host, guest };
}

function seat(roomId: string, role: PlayerRole.Player1 | PlayerRole.Player2) {
  return getRoomById(roomId)!.seats.get(role)!;
}

function markSteered(roomId: string, sessionID: string, at: number) {
  const room = getRoomById(roomId)!;
  for (const [role, seat] of room.seats) {
    if (seat.sessionID === sessionID) {
      room.seats.set(role, { ...seat, lastSteerAt: at });
    }
  }
}

describe('online disconnect forfeit', () => {
  it('gives the pot to the player who stays after the other has been gone for 5 minutes', () => {
    const { room, host, guest } = paidMatch('stay');
    expect(room.phase).toBe('playing');
    expect(room.snapshot.state.gameStarted).toBe(false);
    confirmOnlineStart(room.roomId, host);

    leaveRoom(guest);
    const goneAt = seat(room.roomId, PlayerRole.Player2).disconnectedAt!;
    resolveOnlineDisconnects(goneAt + ONLINE_FORFEIT_DISCONNECT_MS);

    const live = getRoomById(room.roomId)!;
    expect(live.phase).toBe('postgame');
    expect(live.postGame.outcome).toBe('forfeit');
    expect(live.snapshot.state.winnerPlayer).toBe('P1');
    expect(live.snapshot.state.score[0]).toBe(live.snapshot.state.totalPoints);
    expect(live.snapshot.state.score[1]).toBe(0);
    expect(netPayoutSats(live.postGame.winnerPoints)).toBe(1900);
  });

  it('still forfeits after the match has started, and does not simulate while paused', () => {
    const { room, host, guest } = paidMatch('started');
    confirmOnlineStart(room.roomId, host);
    confirmOnlineStart(room.roomId, guest);
    for (let i = 0; i < 50; i += 1) {
      stepRoomSnapshot(room.roomId);
    }
    const live = getRoomById(room.roomId)!;
    expect(live.snapshot.state.gameStarted).toBe(true);
    const head = [...live.snapshot.state.p1.head];
    const tick = live.snapshot.tick;

    leaveRoom(guest);
    for (let i = 0; i < 10; i += 1) {
      stepRoomSnapshot(room.roomId);
    }
    const paused = getRoomById(room.roomId)!;
    expect(paused.phase).toBe('playing');
    expect(paused.snapshot.tick).toBe(tick);
    expect(paused.snapshot.state.p1.head).toEqual(head);

    const goneAt = seat(room.roomId, PlayerRole.Player2).disconnectedAt!;
    const dueAt = goneAt + ONLINE_FORFEIT_DISCONNECT_MS;
    markSteered(room.roomId, host, dueAt);
    resolveOnlineDisconnects(dueAt);
    expect(getRoomById(room.roomId)!.phase).toBe('postgame');
    expect(getRoomById(room.roomId)!.snapshot.state.winnerPlayer).toBe('P1');
  });

  it('accumulates disconnect time across reconnects', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = new Date('2026-10-29T12:00:00Z');
    vi.setSystemTime(start);
    const { room, host, guest } = paidMatch('accumulate');
    confirmOnlineStart(room.roomId, host);

    leaveRoom(guest);
    vi.setSystemTime(start.getTime() + 3 * 60 * 1000);
    resolveOnlineDisconnects();
    expect(getRoomById(room.roomId)!.phase).toBe('playing');

    joinRoom(room.roomId, guest, `${guest}-sock`);
    expect(seat(room.roomId, PlayerRole.Player2).disconnectMs).toBe(3 * 60 * 1000);
    expect(seat(room.roomId, PlayerRole.Player2).disconnectedAt).toBeUndefined();

    vi.setSystemTime(start.getTime() + 5 * 60 * 1000);
    leaveRoom(guest);
    vi.setSystemTime(start.getTime() + 7 * 60 * 1000);
    resolveOnlineDisconnects();

    const live = getRoomById(room.roomId)!;
    expect(live.phase).toBe('postgame');
    expect(live.snapshot.state.winnerPlayer).toBe('P1');
    expect(live.snapshot.state.score[0]).toBe(live.snapshot.state.totalPoints);
  });

  it('abandons when both seats are disconnected as the clock runs out', () => {
    const { room, host, guest } = paidMatch('both');
    leaveRoom(host);
    leaveRoom(guest);
    const goneAt = Math.min(
      seat(room.roomId, PlayerRole.Player1).disconnectedAt!,
      seat(room.roomId, PlayerRole.Player2).disconnectedAt!
    );
    resolveOnlineDisconnects(goneAt + ONLINE_FORFEIT_DISCONNECT_MS);

    expect(getRoomById(room.roomId)).toBeUndefined();
    expect(appendOnlineMatchArchive).toHaveBeenCalled();
    const payload = vi.mocked(appendOnlineMatchArchive).mock.calls.at(-1)?.[0];
    const serialized = payload?.serializedRoom as {
      phase?: string;
      result?: { outcome?: string; p1Paid?: number; p2Paid?: number; winnerRole?: string };
    };
    expect(serialized.phase).not.toBe('lobby');
    expect(serialized.result?.outcome).toBe('abandoned');
    expect(serialized.result?.p1Paid).toBe(1000);
    expect(serialized.result?.p2Paid).toBe(1000);
    expect(serialized.result?.winnerRole).toBeUndefined();
    expect(trackOnlineOk).toHaveBeenCalledWith(
      'online.room.abandoned',
      expect.objectContaining({
        amountSats: 2000,
        meta: expect.objectContaining({ p1Paid: 1000, p2Paid: 1000 }),
      })
    );
  });

  it('does not turn a paid match into an empty lobby after a long disconnect', () => {
    const { room, host, guest } = paidMatch('long');
    confirmOnlineStart(room.roomId, host);
    leaveRoom(guest);
    const goneAt = seat(room.roomId, PlayerRole.Player2).disconnectedAt!;
    resolveOnlineDisconnects(goneAt + 15 * 60 * 1000);
    const live = getRoomById(room.roomId)!;
    expect(live.phase).toBe('postgame');
    expect(live.seats.get(PlayerRole.Player1)?.paidAmount).toBe(1000);
    expect(live.seats.get(PlayerRole.Player2)?.paidAmount).toBe(1000);
  });

  it('sends a forfeit clock for one paid lobby seat and deletes the room when it hits zero', () => {
    const host = 'lobby-host';
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
    leaveRoom(host);
    const goneAt = seat(room.roomId, PlayerRole.Player1).disconnectedAt!;
    const clock = getOnlineForfeitStatus(getRoomById(room.roomId)!, goneAt + 1000);
    expect(clock?.p1RemainingMs).toBe(ONLINE_FORFEIT_DISCONNECT_MS - 1000);
    expect(clock?.p2RemainingMs).toBeUndefined();
    expect(serializeRoom(getRoomById(room.roomId)!).forfeit?.p1RemainingMs).toBeGreaterThan(
      ONLINE_FORFEIT_DISCONNECT_MS - 1000
    );

    resolveOnlineDisconnects(goneAt + ONLINE_FORFEIT_DISCONNECT_MS);
    expect(getRoomById(room.roomId)).toBeUndefined();
    expect(trackOnlineOk).toHaveBeenCalledWith(
      'online.room.abandoned',
      expect.objectContaining({
        amountSats: 1000,
        meta: expect.objectContaining({ reason: 'lobby_seat', paid: 1000 }),
      })
    );
  });

  it('ends a normal match from the sim and pays 95%', () => {
    const { room } = paidMatch('score');
    const live = getRoomById(room.roomId)!;
    live.snapshot.state.gameStarted = true;
    live.snapshot.state.gameEnded = true;
    live.snapshot.state.winnerPlayer = 'P1';
    live.snapshot.state.winnerName = 'Ada';
    live.snapshot.state.score = [2000, 0];
    stepRoomSnapshot(room.roomId);
    const finished = getRoomById(room.roomId)!;
    expect(finished.phase).toBe('postgame');
    expect(finished.postGame.winnerPoints).toBe(2000);
    expect(netPayoutSats(finished.postGame.winnerPoints)).toBe(1900);
    expect(finished.postGame.outcome).toBeUndefined();
  });

  it('does not treat sim ticks as activity', () => {
    const { room } = paidMatch('ticks');
    const live = getRoomById(room.roomId)!;
    const activity = live.lastActivityAt;
    stepRoomSnapshot(room.roomId);
    expect(getRoomById(room.roomId)!.lastActivityAt).toBe(activity);
  });

  it('deletes an empty room by last activity, including ghost members with no session', () => {
    const host = 'idle-host';
    const room = createOnlineRoom({
      hostSessionID: host,
      hostSocketID: `${host}-sock`,
      buyin: 1000,
    });
    room.members.set('ghost', {
      sessionID: 'ghost',
      socketID: 'ghost-sock',
      joinedAt: 0,
      lastSeen: 0,
    });
    room.lastActivityAt = 1;
    runOnlineRoomCleanup(ROOM_IDLE_AFTER);
    expect(getRoomById(room.roomId)).toBeUndefined();
  });

  it('keeps simulating after a crash clears a latched direction', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = new Date('2026-10-29T20:30:00Z');
    vi.setSystemTime(start);
    const { room, host, guest } = paidMatch('crash');
    const live = getRoomById(room.roomId)!;
    live.snapshot.state.gameStarted = true;
    const steeredAt = start.getTime() + ONLINE_IDLE_GRACE_MS + 1000;
    markSteered(room.roomId, host, steeredAt);
    markSteered(room.roomId, guest, steeredAt);
    for (const sessionID of [host, guest]) {
      const input = {
        up: false,
        down: false,
        left: false,
        right: false,
        latchedDir: 'Up' as const,
        pendingTurn: '' as const,
        steerLockUntilRelease: false,
      };
      live.inputBySession.set(sessionID, input);
      clearSteeringOnRespawn(input);
    }
    vi.setSystemTime(steeredAt + 200);
    const tick = live.snapshot.tick;
    stepRoomSnapshot(room.roomId);
    stepRoomSnapshot(room.roomId);
    const after = getRoomById(room.roomId)!;
    expect(after.phase).toBe('playing');
    expect(after.snapshot.tick).toBe(tick + 2);
    expect(getOnlineForfeitStatus(after)).toBeUndefined();
  });

  it('runs an idle clock without pausing the board, then forfeits to the player still steering', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = new Date('2026-10-29T20:00:00Z');
    vi.setSystemTime(start);
    const { room, host, guest } = paidMatch('idle-win');
    const live = getRoomById(room.roomId)!;
    live.snapshot.state.gameStarted = true;
    markSteered(room.roomId, host, start.getTime());
    markSteered(room.roomId, guest, start.getTime());

    const quietAt = start.getTime() + ONLINE_IDLE_GRACE_MS + 1;
    vi.setSystemTime(quietAt);
    markSteered(room.roomId, host, quietAt);
    const tick = live.snapshot.tick;
    stepRoomSnapshot(room.roomId);
    resolveOnlineDisconnects();
    const clock = getOnlineForfeitStatus(getRoomById(room.roomId)!, quietAt);
    expect(getRoomById(room.roomId)!.snapshot.tick).toBe(tick + 1);
    expect(clock?.paused).toBe(false);
    expect(clock?.p1RemainingMs).toBeUndefined();
    expect(clock?.p2Reason).toBe('idle');
    expect(clock?.p2RemainingMs).toBe(ONLINE_FORFEIT_DISCONNECT_MS);

    const dueAt = quietAt + ONLINE_FORFEIT_DISCONNECT_MS;
    vi.setSystemTime(dueAt);
    markSteered(room.roomId, host, dueAt);
    resolveOnlineDisconnects(dueAt);
    const won = getRoomById(room.roomId)!;
    expect(won.phase).toBe('postgame');
    expect(won.snapshot.state.winnerPlayer).toBe('P1');
    expect(won.postGame.outcome).toBe('forfeit');
  });

  it('drops the room when one seat is idle and the other is disconnected', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = new Date('2026-10-29T20:10:00Z');
    vi.setSystemTime(start);
    const { room, host, guest } = paidMatch('idle-dc');
    getRoomById(room.roomId)!.snapshot.state.gameStarted = true;
    markSteered(room.roomId, host, start.getTime());
    leaveRoom(guest);

    vi.setSystemTime(start.getTime() + ONLINE_FORFEIT_DISCONNECT_MS);
    resolveOnlineDisconnects();
    expect(getRoomById(room.roomId)).toBeUndefined();
    expect(trackOnlineOk).toHaveBeenCalledWith(
      'online.room.abandoned',
      expect.objectContaining({
        meta: expect.objectContaining({ reason: 'idle' }),
      })
    );
  });

  it('pauses the shared bank when an idle seat steers again', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = new Date('2026-10-29T20:20:00Z');
    vi.setSystemTime(start);
    const { room, host, guest } = paidMatch('idle-steer');
    getRoomById(room.roomId)!.snapshot.state.gameStarted = true;
    markSteered(room.roomId, host, start.getTime());
    markSteered(room.roomId, guest, start.getTime());

    const openedAt = start.getTime() + ONLINE_IDLE_GRACE_MS + 1;
    vi.setSystemTime(openedAt);
    resolveOnlineDisconnects();
    vi.setSystemTime(openedAt + 60 * 1000);
    updateRoomInput(room.roomId, host, { intent: 'up' });

    const live = getRoomById(room.roomId)!;
    expect(seat(room.roomId, PlayerRole.Player1).disconnectMs).toBe(60 * 1000);
    expect(seat(room.roomId, PlayerRole.Player1).idleSince).toBeUndefined();
    const clock = getOnlineForfeitStatus(live);
    expect(clock?.paused).toBe(false);
    expect(clock?.p1RemainingMs).toBeUndefined();
    expect(clock?.p2Reason).toBe('idle');
    expect(clock?.p2RemainingMs).toBe(ONLINE_FORFEIT_DISCONNECT_MS - 60 * 1000);
  });

  it('does not treat key-ups or lastAxis packets as steering', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = new Date('2026-10-29T21:00:00Z');
    vi.setSystemTime(start);
    const { room, host } = paidMatch('idle-keyup');
    const live = getRoomById(room.roomId)!;
    live.snapshot.state.gameStarted = true;
    markSteered(room.roomId, host, start.getTime());
    markSteered(room.roomId, live.seats.get(PlayerRole.Player2)!.sessionID!, start.getTime());

    for (let elapsed = 500; elapsed <= 30_000; elapsed += 500) {
      vi.setSystemTime(start.getTime() + elapsed);
      updateRoomInput(room.roomId, host, { lastAxis: 'up' });
      updateRoomInput(room.roomId, host, {
        up: false,
        down: false,
        left: false,
        right: false,
        lastAxis: 'up',
      });
      resolveOnlineDisconnects();
    }

    const idleSince = seat(room.roomId, PlayerRole.Player1).idleSince;
    expect(idleSince).toBe(start.getTime() + ONLINE_IDLE_GRACE_MS + 500);
    expect(getRoomById(room.roomId)!.phase).toBe('playing');
  });

  it('does not treat a held key as steering, and a new key-down clears idle', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = new Date('2026-10-29T21:10:00Z');
    vi.setSystemTime(start);
    const { room, host, guest } = paidMatch('idle-held');
    getRoomById(room.roomId)!.snapshot.state.gameStarted = true;
    markSteered(room.roomId, guest, start.getTime());
    updateRoomInput(room.roomId, host, { up: true });

    for (let elapsed = 500; elapsed <= 30_000; elapsed += 500) {
      vi.setSystemTime(start.getTime() + elapsed);
      markSteered(room.roomId, guest, start.getTime() + elapsed);
      updateRoomInput(room.roomId, host, { up: true });
      resolveOnlineDisconnects();
    }

    expect(seat(room.roomId, PlayerRole.Player1).idleSince).toBe(
      start.getTime() + ONLINE_IDLE_GRACE_MS + 500
    );

    vi.setSystemTime(start.getTime() + 30_000);
    markSteered(room.roomId, guest, start.getTime() + 30_000);
    updateRoomInput(room.roomId, host, { intent: 'down' });
    expect(seat(room.roomId, PlayerRole.Player1).idleSince).toBeUndefined();
    expect(getOnlineForfeitStatus(getRoomById(room.roomId)!)).toBeUndefined();
  });
});

const ROOM_IDLE_AFTER = 20 * 60 * 1000 + 5;

describe('prize claim clock', () => {
  function finishedMatch(label: string, lnAddress?: string) {
    const { room, host, guest } = paidMatch(label);
    if (lnAddress) {
      room.seats.get(PlayerRole.Player1)!.lnAddress = lnAddress;
    }
    room.snapshot.state.gameStarted = true;
    room.snapshot.state.gameEnded = true;
    room.snapshot.state.winnerPlayer = 'P1';
    room.snapshot.state.winnerName = 'Ada';
    room.snapshot.state.score = [2000, 0];
    stepRoomSnapshot(room.roomId);
    return { room: getRoomById(room.roomId)!, host, guest };
  }

  it('sends the claim clock while the winner is still connected', () => {
    const { room, host, guest } = finishedMatch('claim-show');
    expect(getOnlineForfeitStatus(getRoomById(room.roomId)!)).toBeUndefined();
    const claim = getOnlineClaimStatus(getRoomById(room.roomId)!);
    expect(claim?.limitMs).toBe(ONLINE_CLAIM_PRESENCE_MS);
    expect(claim?.remainingMs).toBeGreaterThan(ONLINE_CLAIM_PRESENCE_MS - 1000);
    expect(serializeRoom(getRoomById(room.roomId)!).forfeit).toBeUndefined();
    expect(serializeRoom(getRoomById(room.roomId)!).claim?.remainingMs).toBe(claim?.remainingMs);

    leaveRoom(guest);
    leaveRoom(host);
    expect(getRoomById(room.roomId)!.phase).toBe('postgame');
    expect(getOnlineClaimStatus(getRoomById(room.roomId)!)).toBeDefined();
    expect(seat(room.roomId, PlayerRole.Player1).disconnectedAt).toEqual(expect.any(Number));
  });

  it('keeps the room while a connected winner is still deciding', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = new Date('2026-10-29T21:00:00Z');
    vi.setSystemTime(start);
    const { room } = finishedMatch('claim-stay');
    const startedAt = getRoomById(room.roomId)!.postGame.claimStartedAt!;
    resolveOnlineDisconnects(startedAt + 10 * 60 * 1000);
    const live = getRoomById(room.roomId)!;
    expect(live.phase).toBe('postgame');
    expect(tryLockOnlinePayout(room.roomId, 'lnurlw')).toBe(true);
    expect(takeDueClaimPayouts()).toEqual([]);
  });

  it('pays once when the winner has been gone for five minutes across reconnects', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = new Date('2026-10-29T21:10:00Z');
    vi.setSystemTime(start);
    const { room, host } = finishedMatch('claim-away-pay', 'ada@pay.example');
    const startedAt = getRoomById(room.roomId)!.postGame.claimStartedAt!;
    leaveRoom(host);
    vi.setSystemTime(startedAt + 3 * 60 * 1000);
    resolveOnlineDisconnects();
    expect(getRoomById(room.roomId)?.phase).toBe('postgame');
    expect(takeDueClaimPayouts()).toEqual([]);

    joinRoom(room.roomId, host, `${host}-sock`);
    expect(getRoomById(room.roomId)!.postGame.claimMs).toBe(3 * 60 * 1000);
    leaveRoom(host);
    vi.setSystemTime(startedAt + 5 * 60 * 1000);
    resolveOnlineDisconnects();
    expect(takeDueClaimPayouts()).toEqual([
      expect.objectContaining({
        roomId: room.roomId,
        lnAddress: 'ada@pay.example',
        amountSats: 1900,
      }),
    ]);
    resolveOnlineDisconnects(startedAt + 5 * 60 * 1000 + 20_000);
    expect(takeDueClaimPayouts()).toEqual([]);
    const live = getRoomById(room.roomId)!;
    expect(live.postGame.payoutLock).toBe('auto');
    completeOnlineClaimPayout(room.roomId, 'ada@pay.example');
    expect(getRoomById(room.roomId)!.phase).toBe('finished');
    expect(getRoomById(room.roomId)!.postGame.payoutMethod).toBe('nostr_zap');
  });

  it('archives an unclaimed prize when a winner with no Lightning address is gone for five minutes', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = new Date('2026-10-29T21:15:00Z');
    vi.setSystemTime(start);
    const { room, host } = finishedMatch('claim-unclaimed');
    getRoomById(room.roomId)!.seats.get(PlayerRole.Player1)!.pubkey = 'winner-pubkey';
    const startedAt = getRoomById(room.roomId)!.postGame.claimStartedAt!;
    leaveRoom(host);
    vi.setSystemTime(startedAt + 3 * 60 * 1000);
    joinRoom(room.roomId, host, `${host}-sock`);
    leaveRoom(host);
    vi.setSystemTime(startedAt + 5 * 60 * 1000);
    resolveOnlineDisconnects();
    expect(getRoomById(room.roomId)).toBeUndefined();
    expect(takeDueClaimPayouts()).toEqual([]);
    expect(appendOnlineMatchArchive).toHaveBeenCalled();
    const payload = vi.mocked(appendOnlineMatchArchive).mock.calls.at(-1)?.[0];
    const serialized = payload?.serializedRoom as {
      phase?: string;
      result?: {
        outcome?: string;
        netPrize?: number;
        winnerSessionID?: string;
        winnerPubkey?: string;
      };
    };
    expect(serialized.phase).toBe('finished');
    expect(serialized.result?.outcome).toBe('unclaimed');
    expect(serialized.result?.netPrize).toBe(1900);
    expect(serialized.result?.winnerSessionID).toBe(host);
    expect(serialized.result?.winnerPubkey).toBe('winner-pubkey');
    expect(trackOnlineOk).toHaveBeenCalledWith(
      'online.prize.unclaimed',
      expect.objectContaining({
        sessionID: host,
        amountSats: 1900,
        meta: expect.objectContaining({ winnerPubkey: 'winner-pubkey', winnerSessionID: host }),
      })
    );
  });

  it('pauses the away bank when the winner reconnects', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = new Date('2026-10-29T21:20:00Z');
    vi.setSystemTime(start);
    const { room, host } = finishedMatch('claim-bank');
    const startedAt = getRoomById(room.roomId)!.postGame.claimStartedAt!;
    leaveRoom(host);
    vi.setSystemTime(start.getTime() + 60 * 1000);
    joinRoom(room.roomId, host, `${host}-sock`);
    const back = getRoomById(room.roomId)!;
    expect(back.seats.get(PlayerRole.Player1)?.disconnectedAt).toBeUndefined();
    expect(back.postGame.claimMs).toBe(60 * 1000);
    const claim = getOnlineClaimStatus(back);
    expect(claim?.limitMs).toBe(ONLINE_CLAIM_PRESENCE_MS);
    expect(claim?.remainingMs).toBe(
      ONLINE_CLAIM_PRESENCE_MS - (start.getTime() + 60 * 1000 - startedAt)
    );
  });

  it('refuses a second payout while one is already locked', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = new Date('2026-10-29T21:30:00Z');
    vi.setSystemTime(start);
    const { room } = finishedMatch('claim-lock', 'ada@pay.example');
    const startedAt = getRoomById(room.roomId)!.postGame.claimStartedAt!;
    resolveOnlineDisconnects(startedAt + ONLINE_CLAIM_PRESENCE_MS);
    expect(takeDueClaimPayouts()).toHaveLength(1);
    const locked = getRoomById(room.roomId)!;
    expect(locked.postGame.payoutLock).toBe('auto');
    expect(getOnlineClaimStatus(locked)).toBeUndefined();
    expect(tryLockOnlinePayout(room.roomId, 'lnurlw')).toBe(false);
    expect(tryLockOnlinePayout(room.roomId, 'nostr')).toBe(false);
    resolveOnlineDisconnects(startedAt + ONLINE_CLAIM_PRESENCE_MS + 20_000);
    expect(takeDueClaimPayouts()).toEqual([]);

    const manual = finishedMatch('manual-lock', 'bea@pay.example');
    expect(tryLockOnlinePayout(manual.room.roomId, 'nostr')).toBe(true);
    const manualStarted = getRoomById(manual.room.roomId)!.postGame.claimStartedAt!;
    resolveOnlineDisconnects(manualStarted + ONLINE_FORFEIT_DISCONNECT_MS);
    expect(takeDueClaimPayouts()).toEqual([]);
    expect(getOnlineClaimStatus(getRoomById(manual.room.roomId)!)).toBeUndefined();
  });
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
