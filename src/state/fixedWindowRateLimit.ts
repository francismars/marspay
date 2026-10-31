type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
const DEFAULT_WINDOW_MS = 60_000;
let lastSweep = 0;

function sweep(now: number) {
  if (now - lastSweep < DEFAULT_WINDOW_MS && buckets.size < 2000) {
    return;
  }
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (now >= bucket.resetAt) {
      buckets.delete(key);
    }
  }
}

/** Fixed one-minute window. Returns true when this call is still inside the limit. */
export function consumeFixedWindow(
  key: string,
  limit: number,
  windowMs = DEFAULT_WINDOW_MS,
  now = Date.now()
): boolean {
  sweep(now);
  let bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }
  if (bucket.count >= limit) {
    return false;
  }
  bucket.count += 1;
  return true;
}

export function resetFixedWindowForTests() {
  buckets.clear();
  lastSweep = 0;
}
