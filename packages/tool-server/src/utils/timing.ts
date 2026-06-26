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
