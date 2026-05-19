/** Ceiling for any single `xcrun simctl spawn UDID …` invocation.
 * Healthy CSS: ~0.3s. Under contention / Intel hosts / cold-start CSS: up to
 * a few seconds. 10s is well above any plausible legitimate latency and well
 * below "hung indefinitely" — the case the timeout exists to catch (degraded
 * CoreSimulatorService blocking simctl forever, so the watcher's backoff
 * would never fire). */
export const SIMCTL_SPAWN_TIMEOUT_MS = 10_000;
