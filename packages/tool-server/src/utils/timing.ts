export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const DEFAULT_INTER_STEP_DELAY_MS = 100;

// Resolves true if the full delay elapsed, false if `signal` aborted first.
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
  // `error` is `cause.message`; `cause` is the rejection's own Error, for a
  // caller that rethrows it rather than just quoting it.
  | { type: "error"; error: string; cause: Error }
  | { type: "timeout" }
  | { type: "aborted" };

// Race a promise against a time budget and an abort signal. The underlying work
// often isn't cancellable (no AbortSignal reaches adb / AXRuntime), so a hung
// operation would otherwise blow past its caller's deadline; we can't kill the
// orphaned work, only stop waiting on it.
//
// An undefined `ms` means no time budget: the abort is then the only thing that
// stops the wait, and `timeout` is never returned.
export function settleWithin<T>(
  p: Promise<T>,
  ms: number | undefined,
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
    // Attached up front so a settle from abandoned work is still consumed and
    // can't surface as an unhandled rejection.
    p.then(
      (value) => finish({ type: "value", value }),
      (err) => {
        const cause = err instanceof Error ? err : new Error(String(err));
        finish({ type: "error", error: cause.message, cause });
      }
    );
    if (signal?.aborted) return finish({ type: "aborted" });
    const onAbort = () => finish({ type: "aborted" });
    signal?.addEventListener("abort", onAbort, { once: true });
    teardown.push(() => signal?.removeEventListener("abort", onAbort));
    if (ms === undefined) return;
    const timer = setTimeout(() => finish({ type: "timeout" }), Math.max(0, ms));
    teardown.push(() => clearTimeout(timer));
  });
}
