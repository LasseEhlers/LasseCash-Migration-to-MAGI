/**
 * ⚠️ A SHARED PROMISE CAN OUTLIVE THE REQUEST THAT STARTED IT (found 2026-11-17).
 *
 * The server caches unfinished work so that callers arriving together share
 * one build: the post list, the pool ledger, Hive bodies. On Cloudflare
 * Workers a promise belongs to the request that created it. If that request
 * has already answered (the feed and profiles answer after a time limit while
 * the build continues), a later request awaiting the same promise gets
 * "This promise was created by a request that has since ended, so it can
 * never settle" — and every profile on lassecash.com answered 500.
 *
 * `joinShared` awaits the shared work and, ONLY on that specific refusal,
 * runs `restart` — which should start a fresh build in this request and put
 * it in the cache in place of the dead one. Any other failure is passed on
 * unchanged, so real errors keep their meaning.
 */
export function isCrossRequestError(e: unknown): boolean {
  const msg = String((e as { message?: unknown })?.message ?? e);
  return /request that has since ended|different request/i.test(msg);
}

export async function joinShared<T>(shared: Promise<T>, restart: () => Promise<T>): Promise<T> {
  try {
    return await shared;
  } catch (e) {
    if (!isCrossRequestError(e)) throw e;
    return restart();
  }
}
