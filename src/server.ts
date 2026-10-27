import dotenv from 'dotenv';
import http from 'http';
import { Server } from 'socket.io';
import registerSocketHandlers from './socket';
import { app } from './app';
import { warmEventLog } from './telemetry/eventLog';

dotenv.config();

const port = Number(process.env.PORT) || 3001;

const httpServer = http.createServer(app);
const io = new Server(httpServer);

httpServer.on('error', onError);

void start();

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
