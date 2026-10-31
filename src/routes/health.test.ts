import { describe, expect, it } from 'vitest';
import { app } from '../app';
import {
  createOnlineRoom,
  seatPaidPlayer,
  setRoomPhase,
} from '../state/onlineRoomState';

function get(path: string): Promise<{ status: number; body: string; cacheControl: string | null }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      fetch(`http://127.0.0.1:${port}${path}`)
        .then(async (res) => {
          const body = await res.text();
          server.close(() =>
            resolve({
              status: res.status,
              body,
              cacheControl: res.headers.get('cache-control'),
            })
          );
        })
        .catch((error: unknown) => {
          server.close(() => reject(error));
        });
    });
    server.on('error', reject);
  });
}

describe('GET /health', () => {
  it('returns process uptime and live room counts', async () => {
    const before = JSON.parse((await get('/health')).body) as {
      liveRooms: number;
      livePaidRooms: number;
    };

    createOnlineRoom({
      hostSessionID: 'health-empty-host',
      hostSocketID: 'health-empty-sock',
      buyin: 1000,
    });

    const paid = createOnlineRoom({
      hostSessionID: 'health-paid-host',
      hostSocketID: 'health-paid-sock',
      buyin: 1000,
    });
    seatPaidPlayer({
      roomId: paid.roomId,
      sessionID: 'health-paid-host',
      socketID: 'health-paid-sock',
      amount: 1000,
      name: 'Ada',
    });

    const finished = createOnlineRoom({
      hostSessionID: 'health-finished-host',
      hostSocketID: 'health-finished-sock',
      buyin: 1000,
    });
    seatPaidPlayer({
      roomId: finished.roomId,
      sessionID: 'health-finished-host',
      socketID: 'health-finished-sock',
      amount: 1000,
      name: 'Bea',
    });
    setRoomPhase(finished.roomId, 'finished');

    const cancelled = createOnlineRoom({
      hostSessionID: 'health-cancelled-host',
      hostSocketID: 'health-cancelled-sock',
      buyin: 1000,
    });
    setRoomPhase(cancelled.roomId, 'cancelled');

    const res = await get('/health');
    expect(res.status).toBe(200);
    expect(res.cacheControl).toBe('no-store');
    const body = JSON.parse(res.body) as {
      ok: boolean;
      uptimeSec: number;
      liveRooms: number;
      livePaidRooms: number;
    };
    expect(body).toEqual({
      ok: true,
      uptimeSec: body.uptimeSec,
      liveRooms: before.liveRooms + 2,
      livePaidRooms: before.livePaidRooms + 1,
    });
    expect(Number.isInteger(body.uptimeSec)).toBe(true);
    expect(body.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(Object.keys(body).sort()).toEqual([
      'livePaidRooms',
      'liveRooms',
      'ok',
      'uptimeSec',
    ]);
  });
});
