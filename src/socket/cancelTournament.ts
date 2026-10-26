import { Socket } from 'socket.io';
import { deleteGameInfoByID, getGameInfoFromID } from '../state/gameState';
import { dateNow } from '../utils/time';
import {
  deleteLNURLPsFromSession,
  getLNURLPsFromID,
} from '../state/lnurlpState';
import createLNURLW from '../calls/LNBits/createLNURLW';
import {
  getLNURLWFromID,
  setIDToLNURLW,
  setLNURLWToID,
} from '../state/lnurlwState';
import { setIDToSocket } from '../state/sessionState';
import { GameMode } from '../types/game';
import { deleteKind1sFromSession, getKind1sfromSessionID } from '../state/nostrState';

export async function cancelTournament(socket: Socket) {
  const sessionID = socket.data.sessionID;
  console.log(`dateNow() [${sessionID}] Attempting to cancel tournament.`);
  const response: {
    depositcount: number;
    lnurlw?: string;
  } = { depositcount: 0 };
  const LNURLW = getLNURLWFromID(sessionID);
  if (LNURLW) {
    console.log(`${dateNow()} [${sessionID}] Found an existing LNURLw.`);
    return;
  }
  const tournamentInfo = getGameInfoFromID(sessionID);
  if (!tournamentInfo) {
    console.log(`${dateNow()} [${sessionID}] No tournament information found.`);
    return;
  }
  if (!tournamentInfo.players) {
    console.log(
      `${dateNow()} [${sessionID}] No players found in tournament information.`
    );
    return;
  }
  const depositcount = tournamentInfo.players.size;
  console.log(
    `${dateNow()} [${sessionID}] Found an ongoing tournament with ${depositcount} deposits.`
  );
  response.depositcount = depositcount;
  if (depositcount == 0) {
    if (tournamentInfo.mode === GameMode.TOURNAMENTNOSTR) {
      deleteKind1sFromSession(sessionID);
    }
    deleteLNURLPsFromSession(sessionID);
    deleteGameInfoByID(sessionID);
    setIDToSocket(sessionID, {
      socketID: socket.id,
      lastSeen: Date.now(),
    });
    socket.emit('rescanceltourn', response);
    return;
  }
  const LNURLPs = getLNURLPsFromID(sessionID);
  let amount: number;
  if (tournamentInfo.mode === GameMode.TOURNAMENTNOSTR) {
    const kind1 = getKind1sfromSessionID(sessionID)?.slice(-1)[0];
    amount =
      kind1?.min ??
      Math.floor(
        [...tournamentInfo.players.values()].reduce(
          (sum, player) => sum + player.value,
          0
        ) / depositcount
      );
  } else {
    if (!LNURLPs || LNURLPs[0].mode != 'TOURNAMENT') {
      console.log(
        `${dateNow()} [${sessionID}] No LNURLp found for tournament information.`
      );
      return;
    }
    amount = LNURLPs[0].min;
  }
  console.log(
    `${dateNow()} [${sessionID}] Creating LNRURLw with ${amount} sats and ${depositcount} uses.`
  );
  const lnurlw = await createLNURLW(Math.floor(amount * 0.95), depositcount);
  if (lnurlw) {
    console.log(`${dateNow()} [${sessionID}] Created LNURLw ${lnurlw.id}.`);
    setIDToLNURLW(sessionID, {
      id: lnurlw.id,
      lnurlw: lnurlw.lnurl,
      maxWithdrawals: depositcount,
      claimedCount: 0,
    });
    setLNURLWToID(lnurlw.id, sessionID);
    response.lnurlw = lnurlw.lnurl;
  }
  if (tournamentInfo.mode === GameMode.TOURNAMENTNOSTR) {
    // Explicit user cancel: clean up public nostr posts.
    deleteKind1sFromSession(sessionID);
  }
  console.log(
    `${dateNow()} [${sessionID}] Sending cancel tournament information.`
  );
  socket.emit('rescanceltourn', response);
}
