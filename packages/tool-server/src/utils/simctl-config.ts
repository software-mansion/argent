/** Ceiling for any single `xcrun simctl spawn UDID …` invocation.
 * Healthy CSS: ~0.3s. Under contention / Intel hosts / cold-start CSS: up to
 * a few seconds. 10s is well above any plausible legitimate latency and well
 * below "hung indefinitely" — the case the timeout exists to catch (degraded
 * CoreSimulatorService blocking simctl forever, so the watcher's backoff
 * would never fire). */
export const SIMCTL_SPAWN_TIMEOUT_MS = 10_000;

/** Ceiling for `xcrun simctl list devices --json`, the hot-path discovery call
 * used by list-devices, runtime-kind resolution, and the simulator watcher. */
export const SIMCTL_LIST_DEVICES_TIMEOUT_MS = 10_000;

/** Wait briefly for another argent process' simctl-list probe to finish instead
 * of spawning another one. This stays below list-devices' branch deadline when
 * combined with SIMCTL_LIST_DEVICES_TIMEOUT_MS. */
export const SIMCTL_LIST_DEVICES_LOCK_WAIT_MS = 12_000;

/** Recover from a crashed process that acquired the discovery lock but never
 * removed it. This is above the subprocess timeout so a healthy holder is not
 * treated as stale under normal load. */
export const SIMCTL_LIST_DEVICES_LOCK_STALE_MS = 15_000;

export const SIMCTL_LIST_DEVICES_LOCK_RETRY_MS = 50;
