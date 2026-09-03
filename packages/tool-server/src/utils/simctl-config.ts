/** Ceiling for any single `xcrun simctl spawn UDID …` invocation. A healthy
 * CoreSimulatorService answers in ~0.3s; 10s sits above any plausible legitimate
 * latency and below "hung indefinitely" — a wedged CoreSimulatorService blocking
 * simctl forever is the case this exists to catch. */
export const SIMCTL_SPAWN_TIMEOUT_MS = 10_000;

/** Ceiling for one `xcrun simctl list devices --json`, wherever it runs — the
 * simulator listing and the device-set probe both pay it. Exported so a tool
 * whose end-to-end budget is pinned by a test can sum the listings in. */
export const SIMCTL_LIST_TIMEOUT_MS = 10_000;

/** Kill signal for timed-out `xcrun simctl` invocations.
 *
 * `execFile`'s `timeout` sends its `killSignal` (default `SIGTERM`) once and
 * never escalates; a `simctl` blocked on a wedged CoreSimulatorService ignores
 * `SIGTERM`, so the promise never settles and the timeout never fires.
 *
 * Killing the direct child suffices: `simctl` is a single-process XPC client
 * whose real work runs under the simulator's `launchd_sim`, which reaps the
 * orphan. Mirrors `ADB_KILL_SIGNAL` in `adb.ts`. */
export const SIMCTL_KILL_SIGNAL = "SIGKILL" as const;
