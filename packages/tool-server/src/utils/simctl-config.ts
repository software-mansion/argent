/** Ceiling for any single `xcrun simctl spawn UDID …` invocation.
 * Healthy CSS: ~0.3s. Under contention / Intel hosts / cold-start CSS: up to
 * a few seconds. 10s is well above any plausible legitimate latency and well
 * below "hung indefinitely" — the case the timeout exists to catch (degraded
 * CoreSimulatorService blocking simctl forever, so the watcher's backoff
 * would never fire). */
export const SIMCTL_SPAWN_TIMEOUT_MS = 10_000;

/** Kill signal for timed-out `xcrun simctl` invocations.
 *
 * Node's `execFile` `timeout` sends its `killSignal` (default `SIGTERM`) once and
 * never escalates. A `simctl` process blocked on a wedged CoreSimulatorService
 * ignores `SIGTERM`, so the parent keeps awaiting past the deadline and the
 * timeout that `SIMCTL_SPAWN_TIMEOUT_MS` promises never actually fires (observed:
 * a `describe` call hung ~24 min against a stuck simulator until the tool-server
 * was killed). `SIGKILL` reaps the child at the timeout boundary so callers'
 * budgets hold.
 *
 * `simctl` is a single-process XPC client — the real work runs under the
 * simulator's `launchd_sim`, not as a child of `simctl` — so killing the direct
 * child settles the promise; the orphaned in-sim process is the simulator's to
 * reap. Mirrors `ADB_KILL_SIGNAL` in `adb.ts`, which fixed the same class of
 * hang for the Android surface. */
export const SIMCTL_KILL_SIGNAL = "SIGKILL" as const;
