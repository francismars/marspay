import dotenv from 'dotenv';
import http from 'http';
import path from 'path';
import { Server } from 'socket.io';
import registerSocketHandlers from './socket';
import { app } from './app';
import { warmEventLog } from './telemetry/eventLog';

dotenv.config({ quiet: true });

const port = Number(process.env.PORT) || 3001;

const httpServer = http.createServer(app);
const io = new Server(httpServer);

httpServer.on('error', onError);

// Route modules import this file for `io`. Binding here would listen (and
// process.exit on EADDRINUSE) in any test or tool that loads the app.
if (isServerEntrypoint(process.argv[1])) {
  void start();
}

export function isServerEntrypoint(scriptPath: string | undefined): boolean {
  const base = path.basename(scriptPath ?? '');
  return base === 'server.ts' || base === 'server.js';
}

async function start(): Promise<void> {
  // One tail load before the match loop, so dashboard polls never read the log on the game thread.
  await warmEventLog();
  registerSocketHandlers(io);
  httpServer.listen(port, () => {
    console.log(`🚀 Server running at http://localhost:${port}`);
  });
}

function onError(error: NodeJS.ErrnoException): void {
  if (error.syscall !== 'listen') {
    throw error;
  }

  const bind = typeof port === 'string' ? `Pipe ${port}` : `Port ${port}`;

  switch (error.code) {
    case 'EACCES':
      console.error(`${bind} requires elevated privileges`);
      process.exit(1);
      break;
    case 'EADDRINUSE':
      console.error(`${bind} is already in use`);
      process.exit(1);
      break;
    default:
      throw error;
  }
}

export { io };
