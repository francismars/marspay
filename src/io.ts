import { Server } from 'socket.io';

// No HTTP server here. Route modules import this file; server.ts attaches and listens.
export const io = new Server();
