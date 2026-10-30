import dotenv from 'dotenv';
import { dateNow } from '../../utils/time';
import { WITHDRAWURL } from '../../consts/lnbits';
import { lnbitsWebhookHeadersJson, missingLnbitsEnv } from './webhookSecret';

export default async function createLNURLW(
  amount: number,
  maxWithdrawals: number
) {
  dotenv.config({ quiet: true });
  const lnbitsURL = process.env.LNBITS_URL;
  const lnbitsKEY = process.env.LNBITS_KEY;
  const lnbitsHook = process.env.LNBITS_WITHDRAWHOOK;
  const webhookHeaders = lnbitsWebhookHeadersJson();

  if (!lnbitsURL || !lnbitsKEY || !lnbitsHook || !webhookHeaders) {
    console.error(
      `${dateNow()} Missing LNbits environment variables: ${missingLnbitsEnv({
        LNBITS_URL: lnbitsURL,
        LNBITS_KEY: lnbitsKEY,
        LNBITS_WITHDRAWHOOK: lnbitsHook,
        LNBITS_WEBHOOK_SECRET: webhookHeaders,
      })}`
    );
    return null;
  }
  try {
    const response = await fetch(lnbitsURL + WITHDRAWURL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Api-Key': lnbitsKEY,
      },
      body: JSON.stringify({
        title: 'Chain Duel Prize',
        min_withdrawable: amount,
        max_withdrawable: amount,
        uses: maxWithdrawals,
        wait_time: 1,
        is_unique: false,
        webhook_url: lnbitsHook,
        webhook_headers: webhookHeaders,
      }),
    });
    if (!response.ok) {
      throw new Error(`LNbits responded with status ${response.status}`);
    }

    const data = await response.json();
    return { id: data.id, lnurl: data.lnurl };
  } catch (error) {
    console.error('Failed to create LNURLW link:', error);
    return null;
  }
}
