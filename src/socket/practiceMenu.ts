import { Socket } from 'socket.io';
import { dateNow } from '../utils/time';
import { getLNURLWFromID } from '../state/lnurlwState';
import {
  appendLNURLPToID,
  getLNURLPsFromID,
  setLNURLPToID,
} from '../state/lnurlpState';
import { GameMode } from '../types/game';
import { getGameInfoFromID, serializeGameInfoFromID } from '../state/gameState';
import { BUYINMAX, BUYINMINPRACTICE } from '../consts/values';
import createLNURLP from '../calls/LNBits/createLNURLP';
import { allowSocketAction } from './actionRateLimit';

export async function getPracticeMenuInfos(socket: Socket, LNAddress?: string) {
  const sessionID = socket.data.sessionID;
  if (!sessionID) {
    console.error(`${dateNow()} [${sessionID}] Session ID not found.`);
    return;
  }
  console.log(
    `${dateNow()} [${sessionID}] Requested necessary informations for Practice Menu.`
  );
  const LNURW = getLNURLWFromID(sessionID);
  if (!LNURW) {
    const LNURLPs = getLNURLPsFromID(sessionID);
    if (!LNURLPs) {
      console.log(
        `${dateNow()} [${sessionID}] There is no associated LNRURLP. Creating new one.`
      );
      if (!allowSocketAction(socket, 'lnurl_create')) {
        socket.emit('resGetPracticeMenuInfos', { reason: 'rate_limited' });
        return;
      }
      await newLNURLPPRACTICE(sessionID, LNAddress);
    } else if (LNURLPs) {
      if (LNURLPs[0].mode !== GameMode.PRACTICE) {
        console.log(
          `${dateNow()} [${sessionID}] Found existing LNRURLPs but they are not PRACTICE.`
        );
        return;
      }
      console.log(`${dateNow()} [${sessionID}] Found existing LNRURLP.`);
    }
    console.log(`${dateNow()} [${sessionID}] Sending LNRURLP to client.`);
    socket.emit('resGetPracticeMenuInfos', getLNURLPsFromID(sessionID));
    const gameInfo = getGameInfoFromID(sessionID);
    if (gameInfo) {
      socket.emit('updatePayments', serializeGameInfoFromID(sessionID));
    }
  } else if (LNURW) {
    console.log(`${dateNow()} [${sessionID}] Found associated LNURLW.`);
    const response = { lnurlw: LNURW };
    socket.emit('resGetPracticeMenuInfos', response);
  }
}

async function newLNURLPPRACTICE(sessionID: string, hostLNAddress?: string): Promise<void> {
  const playerDescription = 'Player 1';
  const amount = BUYINMINPRACTICE;
  console.log(
    `${dateNow()} [${sessionID}] Requesting new LNURLp with description ${playerDescription} of ${BUYINMINPRACTICE} to ${BUYINMAX} sats.`
  );
  const lnurlinfo = await createLNURLP(playerDescription, amount, BUYINMAX);
  if (!lnurlinfo) {
    console.log(
      `${dateNow()} [${sessionID}] It wasn't possible to create LNURLp.`
    );
    return;
  }
  console.log(`${dateNow()} [${sessionID}] Created LNURLp ${lnurlinfo.id}.`);
  setLNURLPToID(lnurlinfo.id, sessionID);
  lnurlinfo.mode = GameMode.PRACTICE;
  if(hostLNAddress && hostLNAddress.split("@").length==2) lnurlinfo.hostLNAddress = hostLNAddress
  appendLNURLPToID(sessionID, lnurlinfo);
}
