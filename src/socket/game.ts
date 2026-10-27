import { Socket } from 'socket.io';
import {
  appendWinnerToGameInfo,
  getGameInfoFromID,
  serializeGameInfoFromID,
  setValueToGameInfoFromID,
} from '../state/gameState';
import { dateNow } from '../utils/time';
import { GameMode, PlayerRole } from '../types/game';
import { deleteLNURLPsFromSession } from '../state/lnurlpState';
import { BUYINMINPRACTICE } from '../consts/values';
import { publishGameKind1 } from '../calls/NDK/publishGameKind1';
import { trackEvent } from '../telemetry/trackEvent';
import { resolveTrackPubkeyPrefix } from '../telemetry/resolveTrackPubkeyPrefix';
import { netPayoutSats } from '../utils/payout';

const GAME_INFO_MISSING_LOG_COOLDOWN_MS = 10 * 60 * 1000;
const lastGameInfoMissingLogAt = new Map<string, number>();

function logGameInfoMissingOnce(sessionID: string, context: string): void {
  const now = Date.now();
  const last = lastGameInfoMissingLogAt.get(sessionID) ?? 0;
  if (now - last < GAME_INFO_MISSING_LOG_COOLDOWN_MS) {
    return;
  }
  lastGameInfoMissingLogAt.set(sessionID, now);
  console.warn(`${dateNow()} [${sessionID}] Game info not found (${context}).`);
}

export function gameInfos(socket: Socket) {
  const sessionID = socket.data.sessionID;
  if (!sessionID) {
    console.error(`${dateNow()} [${sessionID}] Session ID not found.`);
    return;
  }
  const gameInfo = getGameInfoFromID(sessionID);
  if (!gameInfo) {
    logGameInfoMissingOnce(sessionID, 'getDuelInfos');
    return;
  }
  console.log(
    `${dateNow()} [${sessionID}] Requested information for P2P game.`
  );
  console.log(`${dateNow()} [${sessionID}] Sending game P2P information.`);
  socket.emit('resGetDuelInfos', serializeGameInfoFromID(sessionID));
}

export function gameFinished(socket: Socket, winnerP: PlayerRole) {
  const sessionID = socket.data.sessionID;
  if (!sessionID) {
    console.error(`${dateNow()} [${sessionID}] Session ID not found.`);
    return;
  }
  const gameInfo = getGameInfoFromID(sessionID);
  if (!gameInfo) {
    logGameInfoMissingOnce(sessionID, 'gameFinished');
    return;
  }
  console.log(
    `${dateNow()} [${sessionID}] Game is finished. Winner is ${winnerP}.`
  );
  if (gameInfo.mode == GameMode.P2P || gameInfo.mode == GameMode.P2PNOSTR) {
    const loserP = getOpponent(winnerP);
    const winnerValue = gameInfo.players.get(winnerP)?.value;
    const loserValue = gameInfo.players.get(loserP)?.value;
    const newWinnerValue =
      winnerValue && loserValue
        ? netPayoutSats(winnerValue + loserValue)
        : undefined;
    if (!newWinnerValue) {
      console.error(
        `${dateNow()} [${sessionID}] Error calculating new winner value.`
      );
      return;
    }
    setValueToGameInfoFromID(sessionID, winnerP, newWinnerValue);
    setValueToGameInfoFromID(sessionID, loserP, 0);
  } else if (gameInfo.mode == GameMode.PRACTICE) {
    if (winnerP != PlayerRole.Player1) {
      const p1Value = gameInfo.players.get(PlayerRole.Player1)?.value;
      if (!p1Value) {
        console.error(
          `${dateNow()} [${sessionID}] Error calculating Player 1 value.`
        );
        return;
      }
      setValueToGameInfoFromID(
        sessionID,
        PlayerRole.Player1,
        p1Value - BUYINMINPRACTICE
      );
    }
  }
  appendWinnerToGameInfo(sessionID, winnerP);
  if (
    gameInfo.mode === GameMode.P2P ||
    gameInfo.mode === GameMode.P2PNOSTR ||
    gameInfo.mode === GameMode.TOURNAMENT ||
    gameInfo.mode === GameMode.TOURNAMENTNOSTR
  ) {
    const buyin = gameInfo.players.get(PlayerRole.Player1)?.value;
    trackEvent({
      event: 'p2p.game.finished',
      outcome: 'ok',
      sessionID,
      pubkeyPrefix: resolveTrackPubkeyPrefix(sessionID),
      buyin,
      meta: {
        mode: gameInfo.mode,
        winner: String(winnerP),
        ...(gameInfo.numberOfPlayers != null
          ? { numberOfPlayers: gameInfo.numberOfPlayers }
          : {}),
      },
    });
  }
  if (gameInfo.mode != GameMode.TOURNAMENT && gameInfo.mode != GameMode.TOURNAMENTNOSTR) {
    console.log(`${dateNow()} [${sessionID}] Deleting LNURLPs from Session.`);
    deleteLNURLPsFromSession(sessionID);
  }
  if (gameInfo.mode == GameMode.TOURNAMENTNOSTR) {
    void publishGameKind1(sessionID, {
      mode: GameMode.TOURNAMENTNOSTR,
      buyin: gameInfo.players.get(PlayerRole.Player1)?.value,
      numberOfPlayers: gameInfo.numberOfPlayers,
    });
  }
}

export function getOpponent(role: PlayerRole): PlayerRole {
  return role === PlayerRole.Player1 ? PlayerRole.Player2 : PlayerRole.Player1;
}
