import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ELECTRON_ID_PREFIX, electronIdFromPort } from "./device-info";
import { ensureCdpReachable, discoverPrimaryPage } from "../blueprints/electron-cdp";

export interface ElectronDevice {
  platform: "electron";
  /** Canonical Argent device id, e.g. "electron-cdp-19222". */
  id: string;
  /** CDP debugging port the Electron process exposed. */
  port: number;
  /** Title of the primary page target. */
  title: string;
  /** URL the primary page is showing. */
  url: string;
  /** Browser version string from /json/version. */
  browser: string | null;
  /** Always "Running" — list-devices only surfaces Electron processes whose CDP endpoint is responsive. */
  state: "Running";
}

const DEFAULT_PROBE_TIMEOUT_MS = 800;

function parsePortList(raw: string | undefined): number[] {
  if (!raw) return [];
  const out: number[] = [];
  for (const piece of raw.split(",")) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const n = Number.parseInt(trimmed, 10);
    if (Number.isFinite(n) && n > 0 && n <= 65535) out.push(n);
  }
  return out;
}

// Process-local set of Electron CDP ports the tool-server has booted. The
// kernel hands out arbitrary high ports, so we cannot rediscover them by
// blind scanning without producing a lot of spurious probes against unrelated
// services. `list-devices` always probes whatever lives in this set plus the
// well-known 9222 and the user-provided env list.
const TRACKED_PORTS = new Set<number>();

/**
 * Tracked ports are also mirrored to a small file so they survive tool-server
 * restarts. Booted Electron apps are detached and deliberately outlive the
 * tool-server (which auto-exits on idle), so without persistence every
 * restart makes running apps invisible to `list-devices` — the agent then
 * boots a duplicate instance. Dead ports are pruned on probe failure, so the
 * file self-heals after the app quits.
 */
function portsFilePath(): string {
  return (
    process.env.ARGENT_ELECTRON_PORTS_FILE ??
    path.join(os.homedir(), ".argent", "electron-cdp-ports.json")
  );
}

function loadPersistedPorts(): number[] {
  try {
    const raw = JSON.parse(fs.readFileSync(portsFilePath(), "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((p): p is number => typeof p === "number" && p > 0 && p <= 65535);
  } catch {
    return [];
  }
}

function persistPorts(mutate: (ports: Set<number>) => void): void {
  // Best-effort: a persistence failure must never break boot or discovery.
  try {
    const file = portsFilePath();
    const merged = new Set(loadPersistedPorts());
    mutate(merged);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(Array.from(merged)));
  } catch {
    // ignore
  }
}

/** Register a port the tool-server spawned. Boot-device calls this. */
export function trackElectronPort(port: number): void {
  TRACKED_PORTS.add(port);
  persistPorts((ports) => ports.add(port));
}

/** Remove a port. Optional — list-devices auto-prunes ports that fail to probe. */
export function untrackElectronPort(port: number): void {
  TRACKED_PORTS.delete(port);
  persistPorts((ports) => ports.delete(port));
}

/**
 * Candidate ports to probe for a running Electron CDP endpoint.
 * - Always includes 9222 (the Chromium default).
 * - Honours `ARGENT_ELECTRON_PORTS` (comma-separated list) so users can register custom ports.
 * - Includes ports `boot-device` opened in this server process via `trackElectronPort`.
 * - Includes ports persisted by previous tool-server processes (apps outlive the server).
 */
export function getCandidateElectronPorts(): number[] {
  const fromEnv = parsePortList(process.env.ARGENT_ELECTRON_PORTS);
  return Array.from(new Set([9222, ...fromEnv, ...TRACKED_PORTS, ...loadPersistedPorts()]));
}

async function probePort(port: number, timeoutMs: number): Promise<ElectronDevice | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const version = await ensureCdpReachable(port, ctrl.signal);
    const target = await discoverPrimaryPage(port, ctrl.signal);
    return {
      platform: "electron",
      id: electronIdFromPort(port),
      port,
      title: target.title ?? "",
      url: target.url ?? "",
      browser: version.Browser ?? null,
      state: "Running",
    };
  } catch {
    // Drop dead tracked ports so list-devices doesn't keep probing a closed app.
    TRACKED_PORTS.delete(port);
    // Only touch the file when this port was actually persisted — failed
    // probes of 9222 / env ports must not create or rewrite it.
    if (loadPersistedPorts().includes(port)) {
      persistPorts((ports) => ports.delete(port));
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe known Electron CDP ports in parallel. Returns one entry per port that
 * responded with a usable page target. Failures are silent — non-responsive
 * ports are simply not in the result.
 */
export async function discoverElectronDevices(options?: {
  timeoutMs?: number;
  ports?: number[];
}): Promise<ElectronDevice[]> {
  const ports = options?.ports ?? getCandidateElectronPorts();
  const timeoutMs = options?.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const probes = await Promise.all(ports.map((p) => probePort(p, timeoutMs)));
  return probes.filter((d): d is ElectronDevice => d !== null);
}

export { ELECTRON_ID_PREFIX, electronIdFromPort };
