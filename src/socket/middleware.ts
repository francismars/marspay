import { ExtendedError, Server, Socket } from 'socket.io';
import {
  getSocketFromID,
  sessionSocketRoomName,
  setIDToSocket,
} from '../state/sessionState';
import { ALLOWEDEMOJIS } from '../consts/emojis';
import { customAlphabet } from 'nanoid';
import { nolookalikes } from 'nanoid-dictionary';
import { dateNow } from '../utils/time';
import { SESSIONIDLENGHT } from '../consts/values';
import { Session } from '../types/session';
import { trackEvent } from '../telemetry/trackEvent';
import { recordSessionConnect } from '../telemetry/trafficAnalytics';

export default async function middleware(
  io: Server,
  socket: Socket,
  next: (err?: ExtendedError) => void
) {
  const sessionID = socket.handshake.auth.sessionID;
  const session: Session = {
    socketID: socket.id,
    lastSeen: Date.now(),
  };
  const validID = sanitiseID(sessionID);
  if (sessionID && validID) {
    // Always re-bind this socket to the client's sessionID when the format is valid.
    // Previously we only called setIDToSocket when an entry already existed; after a
    // process restart (or any empty IDToSocket map) the client still had a valid
    // session from localStorage while the server created a *new* session — LNURL/game
    // stayed on the old id and webhooks could not emit (no socket row for that id).
    const hadMapping = Boolean(getSocketFromID(sessionID));
    console.log(
      `${dateNow()} [${sessionID}] Client sessionID accepted (${
        hadMapping ? 'reconnect' : 'restored map entry'
      }).`
    );
    socket.data.sessionID = sessionID;
    socket.data.connectedAt = Date.now();
    setIDToSocket(sessionID, session);
    await socket.join(sessionSocketRoomName(sessionID));
    socket.emit('session', {
      sessionID,
    });
    trackEvent({
      event: 'session.connected',
      outcome: 'ok',
      sessionID,
      meta: { reconnect: hadMapping },
    });
    recordSessionConnect(sessionID, socket);
    return next();
  }
  const emoji = ALLOWEDEMOJIS[Math.floor(Math.random() * ALLOWEDEMOJIS.length)];
  const newID = customAlphabet(nolookalikes, SESSIONIDLENGHT);
  socket.data.sessionID = `${emoji}:${newID()}`;
  socket.data.connectedAt = Date.now();
  const realIP = socket.handshake.headers['x-real-ip']; //normalizeIP()
  console.log(
    `${dateNow()} [${
      socket.data.sessionID
    }] Created new sessionID for ${realIP}.`
  );
  setIDToSocket(socket.data.sessionID, session);
  await socket.join(sessionSocketRoomName(socket.data.sessionID));
  socket.emit('session', {
    sessionID: socket.data.sessionID,
  });
  trackEvent({
    event: 'session.connected',
    outcome: 'ok',
    sessionID: socket.data.sessionID as string,
    meta: { reconnect: false, newSession: true },
  });
  recordSessionConnect(socket.data.sessionID as string, socket);
  return next();
}

function sanitiseID(id: string) {
  // Missing or empty is a normal first connect; the caller mints a new id.
  if (!id) return false;
  if (id.split(':').length !== 2) {
    console.warn(`${dateNow()} [${id}] ID not valid.`);
    return false;
  }
  const emoji = id.split(':')[0];
  const stringID = id.split(':')[1];
  if (!ALLOWEDEMOJIS.includes(emoji)) {
    console.warn(`${dateNow()} [${id}] Invalid emoji in sessionID.`);
    return false;
  }
  if (stringID.length !== SESSIONIDLENGHT) {
    console.warn(`${dateNow()} [${id}] Invalid sessionID length.`);
    return false;
  }
  return true;
}
