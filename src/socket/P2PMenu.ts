import { Socket } from 'socket.io';
import { dateNow } from '../utils/time';
import { getLNURLPsFromID } from '../state/lnurlpState';
import { getLNURLWFromID } from '../state/lnurlwState';
import { getGameInfoFromID, serializeGameInfoFromID } from '../state/gameState';
import { BUYINMAX, BUYINMIN, BUYINMINWINNER } from '../consts/values';
import { appendLNURLPToID, setLNURLPToID } from '../state/lnurlpState';
import { GameMode } from '../types/game';
import createLNURLP from '../calls/LNBits/createLNURLP';
import { getKind1sfromSessionID } from '../state/nostrState';
import { allowSocketAction } from './actionRateLimit';
import { getNostrP2PMenuInfos } from './nostrP2PMenu';

export async function getP2PMenuInfos(socket: Socket, hostLNAddress?: string ) {
  const sessionID = socket.data.sessionID;
  if (!sessionID) {
    console.error(`${dateNow()} [${sessionID}] Session ID not found.`);
    return;
  }
  console.log(
    `${dateNow()} [${sessionID}] Requested necessary informations for Game Menu.`
  );
  const LNURW = getLNURLWFromID(sessionID);
  if (!LNURW) {
    const note1s = getKind1sfromSessionID(sessionID);
    if (note1s) {
      console.log(`${dateNow()} [${sessionID}] Found associated Nostr Event.`);
      getNostrP2PMenuInfos(socket);
      return;
    }
    const LNURLPs = getLNURLPsFromID(sessionID);
    if (!LNURLPs) {
      console.log(
        `${dateNow()} [${sessionID}] There are no associated LNRURLPs. Creating new ones.`
      );
      if (!allowSocketAction(socket, 'lnurl_create')) {
        socket.emit('resGetGameMenuInfos', { reason: 'rate_limited' });
        return;
      }
      await newLNURLPsP2P(sessionID, hostLNAddress);
    } else if (LNURLPs) {
      if (LNURLPs[0].mode !== GameMode.P2P) {
        console.log(
          `${dateNow()} [${sessionID}] Found existing LNRURLPs but they are not P2P.`
        );
        return;
      }
      console.log(`${dateNow()} [${sessionID}] Found existing LNRURLPs.`);
    }
    console.log(`${dateNow()} [${sessionID}] Sending LNRURLPs to client.`);
    socket.emit('resGetGameMenuInfos', getLNURLPsFromID(sessionID));
    const gameInfo = getGameInfoFromID(sessionID);
    if (gameInfo) {
      socket.emit('updatePayments', serializeGameInfoFromID(sessionID));
    }
  } else if (LNURW) {
    console.log(`${dateNow()} [${sessionID}] Found associated LNURLW.`);
    socket.emit('resGetGameMenuInfos', { lnurlw: LNURW });
  }
}

async function newLNURLPsP2P(sessionID: string, hostLNAddress?: string): Promise<void> {
  const playersDescriptions = ['Player 1', 'Player 2'];
  const gameInfo = getGameInfoFromID(sessionID);
  const winnerP = gameInfo?.winners?.slice(-1)[0];
  for (const description of playersDescriptions) {
    const amount = winnerP
      ? winnerP === description
        ? BUYINMINWINNER
        : gameInfo.players.get(winnerP)!.value
      : BUYINMIN;
    console.log(
      `${dateNow()} [${sessionID}] Requesting new LNURLp with description ${description} from ${amount} to ${BUYINMAX} sats.`
    );
    const lnurlinfo = await createLNURLP(description, amount, BUYINMAX);
    if (!lnurlinfo) {
      console.log(
        `${dateNow()} [${sessionID}] It wasn't possible to create LNURLp.`
      );
      return;
    }
    console.log(`${dateNow()} [${sessionID}] Created LNURLp ${lnurlinfo.id}.`);
    setLNURLPToID(lnurlinfo.id, sessionID);
    lnurlinfo.mode = GameMode.P2P;
    if(hostLNAddress && hostLNAddress.split("@").length==2) lnurlinfo.hostLNAddress = hostLNAddress
    appendLNURLPToID(sessionID, lnurlinfo);
  }
}
