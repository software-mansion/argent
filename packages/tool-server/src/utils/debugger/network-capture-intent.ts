/**
 * Devices whose network traffic an agent has asked to see (a NetworkInspector
 * was created for them), keyed "port:deviceId".
 *
 * The interceptor lives in the app's JS runtime, so an app restart drops it,
 * and the NetworkInspector service only reinstalls it on the agent's next
 * view-network-logs, long after the app's launch requests have gone out. The
 * debugger reads this at connect and installs the interceptor first thing, so
 * a relaunch (restart-app re-attaches the debugger) captures its startup
 * traffic.
 */
const wanted = new Set<string>();

export function rememberNetworkCaptureIntent(key: string): void {
  wanted.add(key);
}

export function wantsNetworkCapture(key: string): boolean {
  return wanted.has(key);
}
