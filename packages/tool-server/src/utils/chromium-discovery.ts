import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CHROMIUM_ID_PREFIX, chromiumIdFromPort } from "./device-info";
import { ensureCdpReachable, discoverPrimaryPage } from "../blueprints/chromium-cdp";

export interface ChromiumDevice {
  platform: "chromium";
  /** Device id, e.g. "chromium-cdp-19222". */
  id: string;
  /** CDP debugging port. */
  port: number;
  /** Title of the primary page target. */
  title: string;
  /** URL of the primary page target. */
  url: string;
  /** Browser version string from /json/version. */
  browser: string | null;
  /** Always "Running": only ports whose CDP endpoint answers with a drivable page are listed. */
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

// Chromium CDP ports this process booted. The kernel assigns them, so they
// cannot be rediscovered by scanning — only ports recorded here (or named by
// 9222 / the env list / the persisted file) are ever probed.
const TRACKED_PORTS = new Set<number>();

/**
 * Tracked ports are mirrored to a file: booted apps are detached and outlive
 * the tool-server (which auto-exits on idle), so without persistence a restart
 * hides running apps from `list-devices` and the agent boots a duplicate.
 * Failed probes prune the file, so it self-heals after the app quits.
 */
function portsFilePath(): string {
  return (
    process.env.ARGENT_CHROMIUM_PORTS_FILE ??
    path.join(os.homedir(), ".argent", "chromium-cdp-ports.json")
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
export function trackChromiumPort(port: number): void {
  TRACKED_PORTS.add(port);
  persistPorts((ports) => ports.add(port));
}

/** Remove a port. Optional: a failed probe prunes it anyway. */
export function untrackChromiumPort(port: number): void {
  TRACKED_PORTS.delete(port);
  persistPorts((ports) => ports.delete(port));
}

/**
 * Ports to probe: 9222 (Chromium's default), `ARGENT_CHROMIUM_PORTS`
 * (comma-separated), ports booted in this process, and ports persisted by
 * earlier tool-server processes.
 */
export function getCandidateChromiumPorts(): number[] {
  const fromEnv = parsePortList(process.env.ARGENT_CHROMIUM_PORTS);
  return Array.from(new Set([9222, ...fromEnv, ...TRACKED_PORTS, ...loadPersistedPorts()]));
}

async function probePort(port: number, timeoutMs: number): Promise<ChromiumDevice | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const version = await ensureCdpReachable(port, ctrl.signal);
    const target = await discoverPrimaryPage(port, ctrl.signal);
    return {
      platform: "chromium",
      id: chromiumIdFromPort(port),
      port,
      title: target.title ?? "",
      url: target.url ?? "",
      browser: version.Browser ?? null,
      state: "Running",
    };
  } catch {
    // Drop dead tracked ports so list-devices stops probing a closed app.
    TRACKED_PORTS.delete(port);
    // Only touch the file when this port was persisted — a failed probe of
    // 9222 or an env port must not create or rewrite it.
    if (loadPersistedPorts().includes(port)) {
      persistPorts((ports) => ports.delete(port));
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe candidate CDP ports in parallel; ports that fail to answer with a
 * usable page target are silently omitted.
 */
export async function discoverChromiumDevices(options?: {
  timeoutMs?: number;
  ports?: number[];
}): Promise<ChromiumDevice[]> {
  const ports = options?.ports ?? getCandidateChromiumPorts();
  const timeoutMs = options?.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const probes = await Promise.all(ports.map((p) => probePort(p, timeoutMs)));
  return probes.filter((d): d is ChromiumDevice => d !== null);
}

export { CHROMIUM_ID_PREFIX, chromiumIdFromPort };
