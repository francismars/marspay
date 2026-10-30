/** Header LNbits sends back on deposit and withdraw webhooks. */
export const LNBITS_WEBHOOK_SECRET_HEADER = 'x-webhook-secret';

export function lnbitsWebhookSecret(): string {
  return process.env.LNBITS_WEBHOOK_SECRET?.trim() ?? '';
}

/** JSON string stored on the LNURL link as `webhook_headers`. */
export function lnbitsWebhookHeadersJson(): string | null {
  const secret = lnbitsWebhookSecret();
  if (!secret) return null;
  return JSON.stringify({ 'X-Webhook-Secret': secret });
}

/** Names of required LNbits settings that are unset. Values are not included. */
export function missingLnbitsEnv(
  values: Record<string, string | null | undefined>
): string {
  return Object.entries(values)
    .filter(([, value]) => !value)
    .map(([name]) => name)
    .join(', ');
}
