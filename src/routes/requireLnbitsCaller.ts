import { NextFunction, Request, Response } from 'express';
import {
  LNBITS_WEBHOOK_SECRET_HEADER,
  lnbitsWebhookSecret,
} from '../calls/LNBits/webhookSecret';
import { secretEqual } from '../utils/secretEqual';

/** LNbits is the only caller allowed to hit the deposit and withdraw webhooks. */
export function requireLnbitsCaller(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers[LNBITS_WEBHOOK_SECRET_HEADER];
  const provided = typeof header === 'string' ? header : '';
  if (!secretEqual(provided, lnbitsWebhookSecret())) {
    res.status(403).send('Access denied');
    return;
  }
  next();
}
