import { Router } from 'express';
import { listOnlineRooms } from '../state/onlineRoomState';

const router = Router();

/** Rooms still in lobby, play, or post-game. Finished and cancelled rooms are gone. */
function liveRoomCounts(): { liveRooms: number; livePaidRooms: number } {
  let liveRooms = 0;
  let livePaidRooms = 0;
  for (const room of listOnlineRooms()) {
    if (room.phase === 'finished' || room.phase === 'cancelled') {
      continue;
    }
    liveRooms += 1;
    if ((room.playersPaid ?? 0) > 0) {
      livePaidRooms += 1;
    }
  }
  return { liveRooms, livePaidRooms };
}

router.get('/', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.status(200).json({
    ok: true,
    uptimeSec: Math.floor(process.uptime()),
    ...liveRoomCounts(),
  });
});

export default router;
