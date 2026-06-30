export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const DEFAULT_INTER_STEP_DELAY_MS = 100;

// Resolves true if the full delay elapsed, false if `signal` aborted first. Lets
// a poll loop or an inter-step delay stop promptly when the caller cancels the
// request instead of blocking out the remaining interval.
export function sleepOrAbort(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export type Settled<T> =
  | { type: "value"; value: T }
  | { type: "error"; error: string }
  | { type: "timeout" }
  | { type: "aborted" };

// Race a promise (typically a tree fetch) against a time budget and an abort
// signal. The underlying describe fetch isn't cancellable (no AbortSignal reaches
// adb / AXRuntime), so a slow or hung fetch — e.g. the Android `uiautomator dump`
// fallback, which allows up to 20s — would otherwise blow past the caller's
// deadline and ignore an abort that arrives mid-fetch. We can't kill the orphaned
// fetch, but we stop waiting on it; its eventual settle is consumed here (handlers
// attached up front) so it can't surface as an unhandled rejection.
export function settleWithin<T>(
  p: Promise<T>,
  ms: number,
  signal?: AbortSignal
): Promise<Settled<T>> {
  return new Promise((resolve) => {
    let done = false;
    const teardown: Array<() => void> = [];
    const finish = (r: Settled<T>) => {
      if (done) return;
      done = true;
      for (const fn of teardown) fn();
      resolve(r);
    };
    // Attach the settle handlers up front so a late settle from an abandoned
    // fetch is always consumed (no unhandled rejection) even after we've moved on.
    p.then(
      (value) => finish({ type: "value", value }),
      (err) => finish({ type: "error", error: err instanceof Error ? err.message : String(err) })
    );
    if (signal?.aborted) return finish({ type: "aborted" });
    const onAbort = () => finish({ type: "aborted" });
    signal?.addEventListener("abort", onAbort, { once: true });
    teardown.push(() => signal?.removeEventListener("abort", onAbort));
    const timer = setTimeout(() => finish({ type: "timeout" }), Math.max(0, ms));
    teardown.push(() => clearTimeout(timer));
  });
}
