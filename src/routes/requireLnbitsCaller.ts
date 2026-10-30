import { NextFunction, Request, Response } from 'express';

/** LNbits is the only caller allowed to hit the deposit and withdraw webhooks. */
export function requireLnbitsCaller(req: Request, res: Response, next: NextFunction): void {
  const callerIp = req.headers['x-real-ip'];
  const allowedServerIp = process.env.LNBITS_IP;
  if (callerIp === allowedServerIp) {
    next();
    return;
  }
  res.status(403).send('Access denied');
}
