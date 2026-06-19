import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CDPClient } from "../utils/debugger/cdp-client";

export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export interface CdpVersionInfo {
  "Browser"?: string;
  "webSocketDebuggerUrl"?: string;
  "Protocol-Version"?: string;
}

/** GET `/json/version` — used by discovery to confirm CDP is alive. */
export async function ensureCdpReachable(
  port: number,
  signal?: AbortSignal
): Promise<CdpVersionInfo> {
  return fetchJson<CdpVersionInfo>(`http://127.0.0.1:${port}/json/version`, signal);
}

/**
 * List the drivable "page" targets a CDP endpoint exposes — one per
 * BrowserWindow / browser tab — excluding `devtools://` inspector pages and any
 * target without a WebSocket URL (service/shared workers, etc.). Order matches
 * Chromium's `/json/list`, which is roughly most-recently-focused first.
 */
export async function listPageTargets(port: number, signal?: AbortSignal): Promise<CdpTarget[]> {
  const targets = await fetchJson<CdpTarget[]>(`http://127.0.0.1:${port}/json/list`, signal);
  return targets.filter(
    (t) => t.type === "page" && !!t.webSocketDebuggerUrl && !t.url.startsWith("devtools://")
  );
}

/**
 * Probe a CDP endpoint for the renderer page we should drive. Chromium
 * typically exposes one "page" target per BrowserWindow plus a few
 * service_worker / shared_worker entries we don't care about.
 *
 * Throws loudly when the only pages are devtools:// URLs — driving input into
 * the inspector instead of the real window is a hard-to-debug failure mode.
 */
export async function discoverPrimaryPage(port: number, signal?: AbortSignal): Promise<CdpTarget> {
  const pages = await listPageTargets(port, signal);
  if (pages.length === 0) {
    // Distinguish "no pages at all" from "only devtools://" for a clearer hint.
    const all = await fetchJson<CdpTarget[]>(`http://127.0.0.1:${port}/json/list`, signal);
    if (all.some((t) => t.type === "page")) {
      throw new Error(
        `Chromium CDP on port ${port} has only devtools:// pages (the main BrowserWindow may be hidden or closed). ` +
          `Bring the app window to the foreground and retry.`
      );
    }
    throw new Error(
      `Chromium CDP on port ${port} reported no page targets. Is the app started with --remote-debugging-port=${port}?`
    );
  }
  return pages[0]!;
}

/**
 * The browser-level CDP WebSocket URL (from `/json/version`). Used for
 * `Target.createTarget` / `Target.closeTarget`, which operate on the browser
 * rather than a single page.
 */
export async function browserWebSocketUrl(port: number, signal?: AbortSignal): Promise<string> {
  const version = await ensureCdpReachable(port, signal);
  const url = version.webSocketDebuggerUrl;
  if (!url) {
    throw new Error(
      `Chromium CDP on port ${port} did not report a browser webSocketDebuggerUrl in /json/version.`
    );
  }
  return url;
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`Chromium CDP discovery: GET ${url} failed (HTTP ${res.status})`);
  }
  return (await res.json()) as T;
}

/**
 * Open a CDP client against the primary page target on `port`. Suppresses the
 * Origin header (Chromium's devtools-target rejects WS upgrades that carry
 * one — it's meant for IDE clients, not browser pages).
 */
export async function connectCdp(port: number): Promise<{
  cdp: CDPClient;
  wsUrl: string;
  target: CdpTarget;
}> {
  await ensureCdpReachable(port);
  const target = await discoverPrimaryPage(port);
  const wsUrl = target.webSocketDebuggerUrl!;
  const cdp = new CDPClient(wsUrl, { sendOrigin: false });
  await cdp.connect();
  return { cdp, wsUrl, target };
}

/**
 * Best-effort domain enables. Failure is non-fatal — most CDP commands work
 * without the corresponding domain enabled, but Page.navigate / Input.* return
 * more useful errors when their domains are primed.
 */
export async function enableCoreDomains(cdp: CDPClient): Promise<void> {
  for (const domain of ["Page", "DOM", "Runtime", "Accessibility"]) {
    try {
      await cdp.send(`${domain}.enable`);
    } catch {
      /* ignore */
    }
  }
}

/** Working directory for screenshots / video / clipboard staging. */
export function mediaDir(): string {
  const dir = path.join(os.tmpdir(), "argent-chromium-media");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
