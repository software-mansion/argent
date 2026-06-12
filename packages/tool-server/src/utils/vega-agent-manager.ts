import { adbShell, runAdb } from "./adb";
import { emulatorSerial } from "./vega-automation";
import { agentManifest } from "./vega-agent-assets";
import { ensureVegaAgentDeployed } from "./vega-agent-install";
import { createVegaAgentClient, type VegaAgentClient } from "./vega-agent-client";

/**
 * Lifecycle for the on-device Vega agent — a module-level singleton (one handle
 * per Vega udid), not a registry blueprint. The registry resolves a tool's
 * declared services *before* `execute`; keeping the agent here lets us deploy +
 * start it lazily on first use and restart it transparently when it dies, with
 * no fallback transport. Teardown is wired into `stop-all-simulator-servers`
 * via `disposeAllVegaAgents`.
 */

export interface VegaAgentHandle {
  client: VegaAgentClient;
  emuSerial: string;
  hostPort: number;
}

const ADB_FORWARD_PORT_MARKER = /^(\d+)\s*$/;
const START_POLL_ATTEMPTS = 12;
const START_POLL_INTERVAL_MS = 150;

interface Entry {
  handle?: VegaAgentHandle;
  promise?: Promise<VegaAgentHandle>;
}

const entries = new Map<string, Entry>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Return a ready agent handle for `udid`, deploying + starting it on first use.
 * Throws if the agent cannot be brought up — there is no fallback backend.
 */
export async function getOrStartVegaAgent(udid: string): Promise<VegaAgentHandle> {
  const existing = entries.get(udid);
  if (existing?.handle) return existing.handle;
  if (existing?.promise) return existing.promise;

  const promise = startAgent(udid)
    .then((handle) => {
      entries.set(udid, { handle });
      return handle;
    })
    .catch((err) => {
      entries.delete(udid);
      throw err;
    });
  entries.set(udid, { promise });
  return promise;
}

async function startAgent(udid: string): Promise<VegaAgentHandle> {
  const manifest = agentManifest();
  const { serial: emuSerial } = await emulatorSerial();
  await ensureVegaAgentDeployed(emuSerial);

  const hostPort = await setupForward(emuSerial, manifest.devicePort);
  const client = createVegaAgentClient(hostPort);

  // It may already be running (a prior process, or a previous session) — reuse.
  if (await pingOk(client)) return { client, emuSerial, hostPort };

  // Start detached; setsid + redirect + </dev/null so it survives this shell.
  await adbShell(
    emuSerial,
    `setsid ${manifest.deviceBinPath} --port ${manifest.devicePort} ` +
      `>${manifest.deviceBinPath}.log 2>&1 </dev/null &`,
    { timeoutMs: 10_000 }
  );

  for (let i = 0; i < START_POLL_ATTEMPTS; i++) {
    await sleep(START_POLL_INTERVAL_MS);
    if (await pingOk(client)) return { client, emuSerial, hostPort };
  }
  client.close();
  throw new Error(`Vega agent on ${emuSerial} did not become ready after start`);
}

async function setupForward(serial: string, devicePort: number): Promise<number> {
  const { stdout } = await runAdb(["-s", serial, "forward", "tcp:0", `tcp:${devicePort}`], {
    timeoutMs: 5_000,
  });
  const match = ADB_FORWARD_PORT_MARKER.exec(stdout.trim());
  if (!match) throw new Error(`adb forward returned unexpected output: ${stdout.trim()}`);
  return parseInt(match[1]!, 10);
}

async function pingOk(client: VegaAgentClient): Promise<boolean> {
  try {
    const p = await client.ping(1_500);
    return p.ok;
  } catch {
    return false;
  }
}

/** Drop a (presumed dead) agent so the next call re-deploys/re-starts it. */
export function invalidateVegaAgent(udid: string): void {
  const entry = entries.get(udid);
  if (entry?.handle) {
    try {
      entry.handle.client.close();
    } catch {
      /* ignore */
    }
  }
  entries.delete(udid);
}

/** Best-effort shutdown of all agents + removal of their adb forwards. */
export async function disposeAllVegaAgents(): Promise<string[]> {
  const disposed: string[] = [];
  for (const [udid, entry] of entries) {
    // Skip agents still mid-start (only `promise`, no `handle` yet): we can't
    // tear down a connection that doesn't exist, and awaiting the start could
    // hang teardown. Its adb forward may leak, but leftover forwards are
    // harmless and get reused on the next deploy to the same device.
    if (!entry.handle) continue;
    const { client, emuSerial, hostPort } = entry.handle;
    try {
      await client.shutdown(1_000);
    } catch {
      /* ignore */
    }
    try {
      client.close();
    } catch {
      /* ignore */
    }
    try {
      await runAdb(["-s", emuSerial, "forward", "--remove", `tcp:${hostPort}`], { timeoutMs: 5_000 });
    } catch {
      /* ignore — leftover forwards are harmless */
    }
    disposed.push(udid);
  }
  entries.clear();
  return disposed;
}
