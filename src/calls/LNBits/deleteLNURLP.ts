import { PAYURL } from '../../consts/lnbits';
import { dateNow } from '../../utils/time';
import dotenv from 'dotenv';

export default async function deleteLNURLP(lnurl: string) {
  dotenv.config({ quiet: true });
  const lnbitsURL = process.env.LNBITS_URL;
  const lnbitsKEY = process.env.LNBITS_KEY;

  if (!lnbitsURL || !lnbitsKEY) {
    console.error(`${dateNow()} Missing LNbits environment variables`);
    return null;
  }
  try {
    const response = await fetch(lnbitsURL + PAYURL + lnurl, {
      method: 'DELETE',
      headers: {
        'X-Api-Key': lnbitsKEY,
      },
    });
    if (!response.ok) {
      throw new Error(`LNbits responded with status ${response.status}`);
    }

    const data = await response.json();
    if (!data.success) {
      console.error(`${dateNow()} LNBits failed to delete LNURLp: ${lnurl}`);
    }
    return;
  } catch (error) {
    console.error('Failed to delete LNURLp:', error);
    return null;
  }
}
