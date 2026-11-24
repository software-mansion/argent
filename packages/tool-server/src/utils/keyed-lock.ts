/**
 * Keyed promise-chain mutex: `fn` runs once every earlier holder of `key` has
 * settled; different keys never queue behind each other. No timers, no entry
 * queue, just a promise chain per key. The caller owns the map (one per lock
 * domain), so what each domain locks, and why, stays documented at the map's
 * declaration; see runnerBuildLocks (runner-artifact.ts) and flowFileLocks
 * (flow-utils.ts).
 */
export async function withKeyedLock<T>(
  locks: Map<string, Promise<unknown>>,
  key: string,
  fn: () => Promise<T>
): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();

  // `previous` is always an already-swallowed promise, so a failed holder can
  // never wedge or reject the chain.
  const run = previous.then(() => fn());
  const held = run.catch(() => {});
  locks.set(key, held);

  // Drop the entry once this holder is the last one, so the map does not grow
  // by one permanent entry per key ever locked.
  void held.then(() => {
    if (locks.get(key) === held) locks.delete(key);
  });

  return run;
}
