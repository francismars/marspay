import { describe, expect, it } from 'vitest';
import {
  createOnlineGameState,
  getCaptureLabel,
  getOnlineHudState,
  startOnlineCountdown,
  stepOnlineGame,
  tryApplyOnlineWantedDirection,
} from './onlineEngine';
import {
  decodeInnerJsonToFrames,
  encodeFramesToInnerJson,
} from '../state/onlineReplayCodec';
import type { OnlineRoomSnapshot } from '../types/online';

/** Countdown ends when ticks exceed this. The engine does not export the constant. */
const COUNTDOWN_END_TICK = 40;

function startMatch() {
  const state = createOnlineGameState({
    p1Name: 'Ada',
    p2Name: 'Bea',
    p1Points: 1000,
    p2Points: 1000,
  });
  startOnlineCountdown(state);
  for (let i = 0; i < COUNTDOWN_END_TICK + 1; i += 1) {
    stepOnlineGame(state);
  }
  return state;
}

describe('online match rules', () => {
  it('keeps the countdown running through tick 40 and starts on the next tick', () => {
    const state = createOnlineGameState({
      p1Name: 'Ada',
      p2Name: 'Bea',
      p1Points: 1000,
      p2Points: 1000,
    });
    startOnlineCountdown(state);

    for (let i = 0; i < COUNTDOWN_END_TICK; i += 1) {
      stepOnlineGame(state);
    }
    expect(state.gameStarted).toBe(false);
    expect(state.countdownTicks).toBe(COUNTDOWN_END_TICK);

    stepOnlineGame(state);
    expect(state.gameStarted).toBe(true);
    expect(state.countdownStart).toBe(false);
    expect(state.countdownTicks).toBe(COUNTDOWN_END_TICK + 1);
  });

  it('rejects a reverse and accepts a legal turn once the match has started', () => {
    const state = createOnlineGameState({
      p1Name: 'Ada',
      p2Name: 'Bea',
      p1Points: 1000,
      p2Points: 1000,
    });

    expect(tryApplyOnlineWantedDirection(state, 'P1', 'Left')).toBe(false);
    expect(state.p1.dirWanted).toBe('Right');
    expect(tryApplyOnlineWantedDirection(state, 'P2', 'Right')).toBe(false);
    expect(state.p2.dirWanted).toBe('Left');

    startOnlineCountdown(state);
    for (let i = 0; i < COUNTDOWN_END_TICK + 1; i += 1) {
      stepOnlineGame(state);
    }
    stepOnlineGame(state);
    expect(state.p1.dir).toBe('Right');
    expect(state.p2.dir).toBe('Left');

    expect(tryApplyOnlineWantedDirection(state, 'P1', 'Left')).toBe(false);
    expect(state.p1.dirWanted).toBe('Right');
    expect(tryApplyOnlineWantedDirection(state, 'P1', 'Up')).toBe(true);
    expect(state.p1.dirWanted).toBe('Up');

    expect(tryApplyOnlineWantedDirection(state, 'P2', 'Right')).toBe(false);
    expect(state.p2.dirWanted).toBe('Left');
    expect(tryApplyOnlineWantedDirection(state, 'P2', 'Down')).toBe(true);
    expect(state.p2.dirWanted).toBe('Down');
  });

  it('ends the match when a score reaches zero', () => {
    const p1Broke = startMatch();
    p1Broke.score[0] = 0;
    p1Broke.score[1] = 2000;
    stepOnlineGame(p1Broke);
    expect(p1Broke.gameEnded).toBe(true);
    expect(p1Broke.winnerPlayer).toBe('P2');
    expect(p1Broke.winnerName).toBe('Bea');

    const p2Broke = startMatch();
    p2Broke.score[0] = 2000;
    p2Broke.score[1] = 0;
    stepOnlineGame(p2Broke);
    expect(p2Broke.gameEnded).toBe(true);
    expect(p2Broke.winnerPlayer).toBe('P1');
    expect(p2Broke.winnerName).toBe('Ada');
  });

  it('maps snake length to capture percent', () => {
    expect(getCaptureLabel(1)).toBe('2%');
    expect(getCaptureLabel(2)).toBe('4%');
    expect(getCaptureLabel(3)).toBe('4%');
    expect(getCaptureLabel(4)).toBe('8%');
    expect(getCaptureLabel(6)).toBe('8%');
    expect(getCaptureLabel(7)).toBe('16%');
    expect(getCaptureLabel(10)).toBe('16%');
    expect(getCaptureLabel(11)).toBe('32%');
    expect(getCaptureLabel(40)).toBe('32%');
  });
});

describe('compact replay codec', () => {
  it('roundtrips a snapshot', () => {
    const state = createOnlineGameState({
      p1Name: 'Ada',
      p2Name: 'Bea',
      p1Points: 1000,
      p2Points: 1000,
    });
    state.gameStarted = true;
    state.p1.dir = 'Up';
    state.p1.dirWanted = 'Up';
    state.p1.head = [8, 10];
    state.score = [1040, 960];
    state.coinbases.push({ pos: [10, 4], reward: 16 });
    state.pointChanges.push({
      player: 'P1',
      value: 40,
      p1Pos: [8, 10],
      p2Pos: [44, 12],
      p1YOffsetPx: 0,
      p2YOffsetPx: 0,
      alpha: 1,
    });

    const snap: OnlineRoomSnapshot = {
      tick: 42,
      phase: 'playing',
      state,
      hud: getOnlineHudState(state),
    };

    expect(decodeInnerJsonToFrames(encodeFramesToInnerJson([snap]))).toEqual([snap]);
  });
});
