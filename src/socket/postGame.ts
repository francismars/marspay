import { Socket } from 'socket.io';
import { dateNow } from '../utils/time';
import {
  getGameInfoFromID,
  serializeGameInfoFromID,
  setChampionToGameInfo,
} from '../state/gameState';
import {
  getLNURLWFromID,
  setIDToLNURLW,
  setLNURLWToID,
} from '../state/lnurlwState';
import { GameMode, PlayerInfo, PlayerRole } from '../types/game';
import createLNURLW from '../calls/LNBits/createLNURLW';
import { P2PMAXWITHDRAWALS } from '../consts/values';
import { handleEndOfSession } from '../state/cleanupState';
import { publishEndGameKind1 } from '../calls/NDK/publishEndGameKind1';
import { netPayoutSats } from '../utils/payout';

interface Response {
  mode: GameMode;
  players: {
    [k: string]: PlayerInfo;
  };
  winners: PlayerRole[] | undefined;
  lnurlw?: string;
}

export function postGameInfo(socket: Socket) {
  const sessionID = socket.data.sessionID;
  console.log(
    `${dateNow()} [${sessionID}] Requested P2P postGame information.`
  );
  const gameInfos = getGameInfoFromID(sessionID);
  if (gameInfos && gameInfos.winners) {
    console.log(`${dateNow()} [${sessionID}] Sending P2P postGame info.`);
    if (gameInfos.mode == GameMode.TOURNAMENT || gameInfos.mode == GameMode.TOURNAMENTNOSTR) {
      setChampionToGameInfo(sessionID);
    }
    const response: Response | undefined = serializeGameInfoFromID(sessionID);
    const LNURLW = getLNURLWFromID(sessionID);
    if (LNURLW) {
      console.log(`${dateNow()} [${sessionID}] Sending existing LNRURLw.`);
      response!.lnurlw = LNURLW.lnurlw;
    }
    socket.emit('resPostGameInfoRequest', response);
  } else
    console.log(`${dateNow()} [${sessionID}] has no associated postGame info.`);
}

export async function createWithdrawalPostGame(socket: Socket) {
  const sessionID = socket.data.sessionID;
  console.log(`${dateNow()} [${sessionID}] Requested LNRURLw.`);
  const LNURLW = getLNURLWFromID(sessionID);
  if (LNURLW) {
    console.log(`${dateNow()} [${sessionID}] LNRURLw sent previously.`);
  } else if (!LNURLW) {
    console.log(`${dateNow()} [${sessionID}] No associated LNRURLw.`);
    const gameInfo = getGameInfoFromID(sessionID);
    if (!gameInfo) {
      console.log(
        `${dateNow()} [${sessionID}] Tried to create withdrawal link but didn't make any deposits`
      );
      return;
    }
    if (!gameInfo?.winners) {
      console.log(
        `${dateNow()} [${sessionID}] Tried to create withdrawal link but there are no winners`
      );
      return;
    }
    if (gameInfo.mode == GameMode.P2PNOSTR || gameInfo.mode == GameMode.TOURNAMENTNOSTR) {
      publishEndGameKind1(sessionID);
    }
    const winner: PlayerRole = gameInfo!.winners!.slice(-1)[0];
    const valueFrom =
      gameInfo.mode == GameMode.P2P || gameInfo.mode == GameMode.P2PNOSTR
        ? winner
        : PlayerRole.Player1;
    const winnerValue = gameInfo!.players!.get(valueFrom)!.value;
    const grossAmount =
      gameInfo.mode == GameMode.TOURNAMENT
        ? winnerValue * gameInfo.numberOfPlayers!
        : gameInfo.mode == GameMode.TOURNAMENTNOSTR
        ? [...gameInfo.players.values()].reduce((sum, player) => sum + player.value, 0)
        : winnerValue;
    const amount =
      gameInfo.mode == GameMode.TOURNAMENT || gameInfo.mode == GameMode.TOURNAMENTNOSTR
        ? netPayoutSats(grossAmount)
        : grossAmount;
    if (amount == 0) {
      console.log(
        `${dateNow()} [${sessionID}] Requested to create LNURLW with 0 sats. Deleting Session data.`
      );
      socket.emit('resCreateWithdrawalPostGame', 'pass');
      handleEndOfSession(sessionID);
    } else if (amount > 0) {
      const maxWithdrawals = P2PMAXWITHDRAWALS;
      console.log(
        `${dateNow()} [${sessionID}] Creating LNRURLw with ${amount} sats and ${maxWithdrawals} uses.`
      );
      const lnurlw = await createLNURLW(Math.floor(amount), maxWithdrawals);
      if (lnurlw) {
        console.log(`${dateNow()} [${sessionID}] Created LNURLw ${lnurlw.id}.`);
        setIDToLNURLW(sessionID, { id: lnurlw.id, lnurlw: lnurlw.lnurl });
        setLNURLWToID(lnurlw.id, sessionID);
        socket.emit('resCreateWithdrawalPostGame', lnurlw.lnurl);
      }
    }
  }
}
