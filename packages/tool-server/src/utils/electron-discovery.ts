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

/** Register a port the tool-server spawned. Boot-device calls this. */
export function trackElectronPort(port: number): void {
  TRACKED_PORTS.add(port);
}

/** Remove a port. Optional — list-devices auto-prunes ports that fail to probe. */
export function untrackElectronPort(port: number): void {
  TRACKED_PORTS.delete(port);
}

/**
 * Candidate ports to probe for a running Electron CDP endpoint.
 * - Always includes 9222 (the Chromium default).
 * - Honours `ARGENT_ELECTRON_PORTS` (comma-separated list) so users can register custom ports.
 * - Includes ports `boot-device` opened in this server process via `trackElectronPort`.
 */
export function getCandidateElectronPorts(): number[] {
  const fromEnv = parsePortList(process.env.ARGENT_ELECTRON_PORTS);
  return Array.from(new Set([9222, ...fromEnv, ...TRACKED_PORTS]));
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
