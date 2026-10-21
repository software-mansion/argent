/**
 * Which devices a profiler is recording on. Read for the `profiling` flag of
 * the tool-call envelope (the MCP adapter skips its post-action capture on
 * it), and to switch the device's simulator-server to capture on demand
 * for the length of the profile.
 *
 * A start registers its session state; the run counts for as long as that
 * state's `profilingActive` is set. The sessions clear the flag on every way a
 * run ends (stop, the recording cap, an xctrace exit, a session teardown), so
 * nothing here needs clearing.
 */
interface ProfilingRun {
  profilingActive: boolean;
}

type CaptureOnDemandSender = (onDemand: boolean) => void;

const runs = new Map<string, Set<ProfilingRun>>();
const servers = new Map<string, { send: CaptureOnDemandSender; onDemand: boolean }>();

export function trackProfilingRun(deviceId: string, run: ProfilingRun): void {
  let set = runs.get(deviceId);
  if (!set) {
    set = new Set();
    runs.set(deviceId, set);
  }
  set.add(run);
  isProfiling(deviceId);
}

/** Also sets the capture_on_demand mode of the device's simulator-server to match. */
export function isProfiling(deviceId: string): boolean {
  const set = runs.get(deviceId);
  if (set) {
    for (const run of set) {
      if (!run.profilingActive) set.delete(run);
    }
    if (set.size === 0) runs.delete(deviceId);
  }
  const profiling = (set?.size ?? 0) > 0;
  const server = servers.get(deviceId);
  if (server && server.onDemand !== profiling) {
    server.onDemand = profiling;
    server.send(profiling);
  }
  return profiling;
}

/**
 * Registers a simulator-server, which starts with capture_on_demand off. Returns
 * the unregister call for its exit.
 */
export function registerCaptureOnDemandSender(
  deviceId: string,
  send: CaptureOnDemandSender
): () => void {
  const entry = { send, onDemand: false };
  servers.set(deviceId, entry);
  isProfiling(deviceId);
  return () => {
    if (servers.get(deviceId) === entry) servers.delete(deviceId);
  };
}

/** The next check sends the mode again, on a new connection. */
export function captureOnDemandDropped(deviceId: string): void {
  const server = servers.get(deviceId);
  if (server) server.onDemand = false;
}

export function __resetProfilingDevicesForTesting(): void {
  runs.clear();
  servers.clear();
}
