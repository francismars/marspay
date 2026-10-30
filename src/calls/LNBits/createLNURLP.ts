import dotenv from 'dotenv';
import { LNURLP } from '../../types/lnurlp';
import { dateNow } from '../../utils/time';
import { PAYURL } from '../../consts/lnbits';
import { lnbitsWebhookHeadersJson, missingLnbitsEnv } from './webhookSecret';

export default async function createLNURLP(
  description: string,
  buyInMin: number,
  buyInMax: number,
  /** LNURL-pay comment field length; use `0` for anonymous fixed seats (no PIN in comment). */
  commentChars: number = 10
): Promise<LNURLP | null> {
  dotenv.config({ quiet: true });
  const lnbitsURL = process.env.LNBITS_URL;
  const lnbitsKEY = process.env.LNBITS_KEY;
  const lnbitsHook = process.env.LNBITS_DEPOSITHOOK;
  const webhookHeaders = lnbitsWebhookHeadersJson();

  if (!lnbitsURL || !lnbitsKEY || !lnbitsHook || !webhookHeaders) {
    console.error(
      `${dateNow()} Missing LNbits environment variables: ${missingLnbitsEnv({
        LNBITS_URL: lnbitsURL,
        LNBITS_KEY: lnbitsKEY,
        LNBITS_DEPOSITHOOK: lnbitsHook,
        LNBITS_WEBHOOK_SECRET: webhookHeaders,
      })}`
    );
    return null;
  }

  try {
    const response = await fetch(lnbitsURL + PAYURL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Api-Key': lnbitsKEY,
      },
      body: JSON.stringify({
        description: description,
        min: buyInMin,
        max: buyInMax,
        comment_chars: commentChars,
        webhook_url: lnbitsHook,
        webhook_headers: webhookHeaders,
      }),
    });

    if (!response.ok) {
      console.error(
        `${dateNow()} LNbits responded with status ${response.status}`
      );
      return null;
    }

    const data = await response.json();
    return {
      id: data.id,
      lnurlp: data.lnurl,
      description: data.description,
      min: data.min,
    };
  } catch (error) {
    console.error(`${dateNow()} Failed to create LNURLP link: ${error}`);
    return null;
  }
}
