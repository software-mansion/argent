import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CDPClient } from "../utils/debugger/cdp-client";

interface CdpTarget {
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
 * Probe a CDP endpoint for the renderer page we should drive. Chromium
 * typically exposes one "page" target per BrowserWindow plus a few
 * service_worker / shared_worker entries we don't care about.
 *
 * Throws loudly when the only pages are devtools:// URLs — driving input into
 * the inspector instead of the real window is a hard-to-debug failure mode.
 */
export async function discoverPrimaryPage(port: number, signal?: AbortSignal): Promise<CdpTarget> {
  const targets = await fetchJson<CdpTarget[]>(`http://127.0.0.1:${port}/json/list`, signal);
  const pages = targets.filter((t) => t.type === "page" && !!t.webSocketDebuggerUrl);
  if (pages.length === 0) {
    throw new Error(
      `Chromium CDP on port ${port} reported no page targets. Is the app started with --remote-debugging-port=${port}?`
    );
  }
  const primary = pages.find((p) => !p.url.startsWith("devtools://"));
  if (!primary) {
    throw new Error(
      `Chromium CDP on port ${port} has only devtools:// pages (the main BrowserWindow may be hidden or closed). ` +
        `Bring the app window to the foreground and retry.`
    );
  }
  return primary;
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
