import { Router, Request, Response } from 'express';
import { dateNow } from '../utils/time';
import { sessionSocketRoomName } from '../state/sessionState';
import { getIDFromLNURLP, getLNURLPsFromID } from '../state/lnurlpState';
import {
  serializeGameInfoFromID,
  getPlayerInfoFromIDToGame,
  setGameInfoByID,
  getGameInfoFromID,
} from '../state/gameState';
import {
  GameInfo,
  GameMode,
  Payment,
  PlayerInfo,
  PlayerRole,
} from '../types/game';
import { io } from '../server';
import { ExtendedError } from 'socket.io';
import dotenv from 'dotenv';
import { DESIGNERPERCENT, DEVPERCENT, HOSTPERCENT } from '../consts/splits';
import getLNURLCallback from '../calls/LNAddress/getLNURLCallback';
import getInvoiceFromCallback from '../calls/LNAddress/getInvoiceFromCallback';
import payInvoice from '../calls/LNBits/payInvoice';
import { Split } from '../types/split';
import { normalizeIP } from '../utils/ip';
import { LNURLP } from '../types/lnurlp';
import { trackEvent } from '../telemetry/trackEvent';

const router = Router();
dotenv.config({ quiet: true });

interface LNURLPReqBody {
  payment_hash: string;
  payment_request: string;
  amount: number;
  comment: string | string[] | null;
  webhook_data: string;
  lnurlp: string;
  body: string;
}

function ipFilter(
  req: Request,
  res: Response,
  next: (err?: ExtendedError) => void
) {
  const nolmalizedIP = req.headers['x-real-ip'];
  const allowedServerIp = process.env.LNBITS_IP;
  if (nolmalizedIP === allowedServerIp) {
    next();
  } else {
    res.status(403).send('Access denied');
  }
}

router.post('/', ipFilter, async (req: Request, res: Response) => {
  const reqBody = req.body as LNURLPReqBody;
  const reqLNURLP = reqBody.lnurlp;

  if (!reqLNURLP) {
    console.error(`${dateNow()} LNURLp not sent.`);
    res.status(404).send('LNURLp not sent.');
    return;
  }

  const sessionID = getIDFromLNURLP(reqLNURLP);
  if (!sessionID) {
    console.error(`${dateNow()} Session ID not found.`);
    res.status(404).send('Session ID not found.');
    return;
  }

  const amount = reqBody.amount / 1000;
  const comment = normalizePaymentComment(reqBody.comment);
  console.log(
    `${dateNow()} [${sessionID}] Paid LNURLp ${reqLNURLP} with ${amount} sats and note ${comment}.`
  );
  const LNURLPs = getLNURLPsFromID(sessionID);
  if (LNURLPs) {
    const lnurlp = LNURLPs.find((lnurlp) => lnurlp.id === reqLNURLP);
    if (!lnurlp) {
      console.error(
        `${dateNow()} [${sessionID}] LNURLp ${reqLNURLP} not found for session.`
      );
      res.status(404).send('LNURLp not found for session.');
      return;
    }
    trackEvent({
      event: 'deposit.paid',
      outcome: 'ok',
      sessionID,
      amountSats: amount,
      meta: { gameMode: String(lnurlp.mode) },
    });
    const playerRole = decidePlayerRole(lnurlp, sessionID);
    if (!playerRole) {
      console.error(`${dateNow()} [${sessionID}] Player role not created.`);
      res.status(404).send('Player role not created.');
      return;
    }
    const playerInfos = getPlayerInfoFromIDToGame(sessionID, playerRole);
    const value = playerInfos?.value ?? 0;
    const prevName = playerInfos?.name ?? null;
    const prevPayments = playerInfos?.payments ?? [];
    const playerName = comment ?? prevName ?? playerRole;
    const payment: Payment = { amount: amount, note: comment };
    const playerInfo: PlayerInfo = {
      name: playerName,
      value: value + amount,
      payments: [...prevPayments, payment],
    };
    const newPlayerInfo = new Map<PlayerRole, PlayerInfo>();
    newPlayerInfo.set(playerRole, playerInfo);
    const gameMode = lnurlp.mode as GameMode;
    const gameInfo: GameInfo = {
      mode: gameMode,
      players: newPlayerInfo,
    };
    setGameInfoByID(sessionID, gameInfo);
    // Splits must run even when no socket is connected (UI missed update otherwise).
    paySplits(sessionID, amount, lnurlp.hostLNAddress);
    // Fan-out by session room (middleware joins each socket to marspay:session:<id>).
    // Relying only on IDToSocket + socket.id missed cases where the map was empty/stale.
    const sessionRoom = sessionSocketRoomName(sessionID);
    io.to(sessionRoom).emit('updatePayments', serializeGameInfoFromID(sessionID));
    const roomSize = io.sockets.adapter.rooms.get(sessionRoom)?.size ?? 0;
    if (roomSize === 0) {
      console.warn(
        `${dateNow()} [${sessionID}] updatePayments emitted to session room but no socket joined (client offline); UI will catch up on reconnect / getPracticeMenuInfos`
      );
    }
    res.status(200).send('OK');
  }
});

function normalizePaymentComment(comment: string | string[] | null): string | null {
  if (comment == null) return null;
  const joined =
    typeof comment === 'string'
      ? comment
      : comment.map((part) => String(part ?? '')).join('');
  const withoutControlChars = [...joined]
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join('');
  // Keep full user-provided name, while removing control chars and normalizing whitespace.
  const normalized = withoutControlChars
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized === '') return null;
  return normalized.slice(0, 64);
}

function paySplits(sessionID: string, amount: number, hostLNAddress?: string) {
  const devLN = process.env.DEVELOPER_LNADDRESS;
  const designerLN = process.env.DESIGNER_LNADDRESS;
  const hostLN = hostLNAddress ? hostLNAddress : process.env.HOST_LNADDRESS;
  const devPercent = DEVPERCENT;
  const designerPercent = DESIGNERPERCENT;
  const hostPercent = HOSTPERCENT;
  if (!devLN || !designerLN || !hostLN) {
    console.error(`${dateNow()} [${sessionID}] Split address is missing.`);
  }
  const feeSplit: Split[] = [
    { lnaddress: devLN!, percent: devPercent, role: 'developer' },
    { lnaddress: hostLN!, percent: hostPercent, role: 'host' },
    { lnaddress: designerLN!, percent: designerPercent, role: 'designer' },
  ];
  for (const split of feeSplit) {
    const splitedAmount = Math.floor(amount * split.percent);
    if (splitedAmount <= 0) {
      continue;
    }
    console.log(
      `${dateNow()} [${sessionID}] Sending ${
        split.percent
      } split of ${splitedAmount} sats to ${split.role} at ${split.lnaddress}`
    );
    paySplit(split.lnaddress as string, splitedAmount).catch((error) => {
      console.log(
        `${dateNow()} [${sessionID} Couldn't send split to ${split.role}: ${
          error.message
        }`
      );
    });
  }
}

async function paySplit(lnAddress: string, satsAmount: number) {
  const [userLN, domainLN] = lnAddress.split('@');
  const LNurl = `https://${domainLN}/.well-known/lnurlp/${userLN}`;

  const callback = await getLNURLCallback(LNurl);
  const invoice = await getInvoiceFromCallback(callback, satsAmount);
  await payInvoice(invoice);
}

function decidePlayerRole(lnurlp: LNURLP, sessionID: string) {
  if (lnurlp.mode == GameMode.P2P || lnurlp.mode == GameMode.PRACTICE) {
    return lnurlp.description as PlayerRole;
  } else {
    // if (lnurlp.mode == GameMode.TOURNAMENT)
    const gameInfos = getGameInfoFromID(sessionID);
    if (!gameInfos) {
      console.error(`${dateNow()} [${sessionID}] GameInfo not found.`);
      return;
    }
    const assignedRoles = [...gameInfos.players.keys()];
    const allRoles = Object.values(PlayerRole).slice(
      0,
      gameInfos.numberOfPlayers ?? 1
    );
    const availableRoles = allRoles.filter(
      (role) => !assignedRoles.includes(role as PlayerRole)
    );
    if (availableRoles.length === 0) {
      console.error(`${dateNow()} [${sessionID}] No available player roles.`);
      return;
    }
    return availableRoles[
      Math.floor(Math.random() * availableRoles.length)
    ] as PlayerRole;
  }
}

export default router;
