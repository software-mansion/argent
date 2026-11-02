/**
 * Which devices a profiler is recording on. Read for the `profiling` flag of
 * the tool-call envelope (the MCP adapter skips its post-action capture on
 * it), and to switch the device's simulator-server to capture on demand
 * for the length of the profile.
 *
 * A start registers its session state; the run counts for as long as that
 * state's `profilingActive` is set. The sessions clear the flag on every way a
 * run ends (stop, the recording cap, an xctrace exit, a JS reload, a session
 * teardown), so nothing here needs clearing.
 */
interface ProfilingRun {
  profilingActive: boolean;
}

type CaptureOnDemandSender = (onDemand: boolean) => void;

const runs = new Map<string, Set<ProfilingRun>>();
const servers = new Map<
  string,
  { endpoint: string; send: CaptureOnDemandSender; onDemand: boolean }
>();

export function trackProfilingRun(deviceId: string, run: ProfilingRun): void {
  let set = runs.get(deviceId);
  if (!set) {
    set = new Set();
    runs.set(deviceId, set);
  }
  set.add(run);
  syncCaptureOnDemand();
}

/**
 * Also sets the capture_on_demand mode of every device's simulator-server to
 * match, not only this device's: a run can be registered under two ids (a React
 * profile keyed by Metro's logicalDeviceId, and the device's own id), and its
 * stop names only one of them.
 */
export function isProfiling(deviceId: string): boolean {
  syncCaptureOnDemand();
  return runs.has(deviceId);
}

function syncCaptureOnDemand(): void {
  for (const [deviceId, set] of runs) {
    for (const run of set) {
      if (!run.profilingActive) set.delete(run);
    }
    if (set.size === 0) runs.delete(deviceId);
  }
  for (const [deviceId, server] of servers) {
    const profiling = runs.has(deviceId);
    if (server.onDemand !== profiling) {
      server.onDemand = profiling;
      server.send(profiling);
    }
  }
}

/**
 * Registers a simulator-server, reached at `endpoint`, which starts with
 * capture_on_demand off. Returns the unregister call for its exit.
 */
export function registerCaptureOnDemandSender(
  deviceId: string,
  endpoint: string,
  send: CaptureOnDemandSender
): () => void {
  const entry = { endpoint, send, onDemand: false };
  servers.set(deviceId, entry);
  syncCaptureOnDemand();
  return () => {
    if (servers.get(deviceId) !== entry) return;
    servers.delete(deviceId);
    // The server holds the mode for as long as the WebSocket that set it. An
    // attached server's WebSocket outlives this instance, so release the hold
    // here. A spawned server is about to exit, which releases it anyway.
    if (entry.onDemand) entry.send(false);
  };
}

/**
 * The connection to `endpoint` closed, so that server dropped the mode. The next
 * check sends it again, on a new connection. The late close of a server that
 * was already replaced on the device changes nothing: the new server, at
 * another endpoint, still holds the mode.
 */
export function captureOnDemandDropped(deviceId: string, endpoint: string): void {
  const server = servers.get(deviceId);
  if (server?.endpoint === endpoint) server.onDemand = false;
}

export function __resetProfilingDevicesForTesting(): void {
  runs.clear();
  servers.clear();
}
