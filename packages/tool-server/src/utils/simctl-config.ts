/** Ceiling for any single `xcrun simctl spawn UDID …` invocation. A healthy
 * CoreSimulatorService answers in ~0.3s; 10s sits above any plausible legitimate
 * latency and below "hung indefinitely" — a wedged CoreSimulatorService blocking
 * simctl forever is the case this exists to catch. */
export const SIMCTL_SPAWN_TIMEOUT_MS = 10_000;

/** Kill signal for timed-out `xcrun simctl` invocations.
 *
 * `execFile`'s `timeout` sends its `killSignal` (default `SIGTERM`) once and
 * never escalates; a `simctl` blocked on a wedged CoreSimulatorService ignores
 * `SIGTERM`, so the promise never settles and the timeout never fires. Mirrors
 * `ADB_KILL_SIGNAL` in `adb.ts`.
 *
 * Killing the direct child suffices for the real `simctl`, a single-process
 * XPC client whose work runs under the simulator's `launchd_sim`. But `xcrun
 * simctl` first runs Xcode's bash wrapper (seen in 26.6 and 27.2), which can
 * hang in a child `xcodebuild -runFirstLaunch` that a direct-child kill
 * orphans; `execSimctl` in `simctl-exec.ts` kills the whole process group
 * instead. */
export const SIMCTL_KILL_SIGNAL = "SIGKILL" as const;
