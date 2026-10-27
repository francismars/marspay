import { describe, expect, it } from 'vitest';
import { CHALLENGE_CATALOG } from '../../state/challengeState';
import { NORMIE_DEADBEEF_WIN } from './normieDeadbeefWin.fixture';
import { replayChallengeSim, replayChallengeWin } from './replayRunner';

const normie = CHALLENGE_CATALOG.find((entry) => entry.id === 'normie');
if (!normie) {
  throw new Error('NORMIE DUEL missing from challenge catalog');
}

const SEED = 'deadbeef';

describe('challenge replay', () => {
  it('rejects an idle run on a fixed seed', () => {
    const sim = replayChallengeSim({ seed: SEED, challenge: normie, inputLog: [] });
    expect(sim).toEqual({
      gameEnded: true,
      winnerPlayer: 'P2',
      simSteps: 542,
      p1Score: 0,
      p2Score: 2000,
    });

    expect(replayChallengeWin({ seed: SEED, challenge: normie, inputLog: [] })).toEqual({
      ok: false,
      reason: 'replay_not_p1_win',
      debug: {
        winnerPlayer: 'P2',
        simSteps: 542,
        p1Score: 0,
        p2Score: 2000,
        inputCount: 0,
        lastInputTick: null,
      },
    });
  });

  it('accepts the recorded P1 win on the same seed', () => {
    const sim = replayChallengeSim({
      seed: SEED,
      challenge: normie,
      inputLog: NORMIE_DEADBEEF_WIN,
    });
    expect(sim).toEqual({
      gameEnded: true,
      winnerPlayer: 'P1',
      simSteps: 291,
      p1Score: 2000,
      p2Score: 0,
    });

    expect(
      replayChallengeWin({
        seed: SEED,
        challenge: normie,
        inputLog: NORMIE_DEADBEEF_WIN,
      })
    ).toEqual({
      ok: true,
      winnerPlayer: 'P1',
      tickCount: 250,
      simSteps: 291,
    });
  });

  it('stops and rejects a run that hits the step cap before the match ends', () => {
    const sim = replayChallengeSim({
      seed: SEED,
      challenge: normie,
      inputLog: [],
      maxSimSteps: 10,
    });
    expect(sim).toEqual({
      gameEnded: false,
      winnerPlayer: null,
      simSteps: 10,
      p1Score: 1000,
      p2Score: 1000,
    });

    expect(
      replayChallengeWin({
        seed: SEED,
        challenge: normie,
        inputLog: [],
        maxSimSteps: 10,
      })
    ).toEqual({
      ok: false,
      reason: 'replay_no_end',
      debug: {
        winnerPlayer: null,
        simSteps: 10,
        p1Score: 1000,
        p2Score: 1000,
        inputCount: 0,
        lastInputTick: null,
      },
    });
  });

  it('repeats the idle result for the same seed', () => {
    const first = replayChallengeSim({ seed: SEED, challenge: normie, inputLog: [] });
    const second = replayChallengeSim({ seed: SEED, challenge: normie, inputLog: [] });
    expect(second).toEqual(first);
  });
});
