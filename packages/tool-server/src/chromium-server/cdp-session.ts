import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FAILURE_CODES, FailureError } from "@argent/registry";
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
      throw new FailureError(
        `Chromium CDP on port ${port} has only devtools:// pages (the main BrowserWindow may be hidden or closed). ` +
          `Bring the app window to the foreground and retry.`,
        {
          error_code: FAILURE_CODES.CHROMIUM_CDP_NO_PAGE_TARGET,
          failure_stage: "chromium_cdp_discover_page_devtools_only",
          failure_area: "tool_server",
          error_kind: "not_found",
          failure_command: "cdp",
        }
      );
    }
    throw new FailureError(
      `Chromium CDP on port ${port} reported no page targets. Is the app started with --remote-debugging-port=${port}?`,
      {
        error_code: FAILURE_CODES.CHROMIUM_CDP_NO_PAGE_TARGET,
        failure_stage: "chromium_cdp_discover_page_none",
        failure_area: "tool_server",
        error_kind: "not_found",
        failure_command: "cdp",
      }
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
    throw new FailureError(
      `Chromium CDP on port ${port} did not report a browser webSocketDebuggerUrl in /json/version.`,
      {
        // The endpoint responded but its payload was incomplete — a malformed
        // response, not an unreachable port. Distinct code so telemetry doesn't
        // conflate "reached but malformed" with a genuinely down debug port.
        error_code: FAILURE_CODES.CHROMIUM_CDP_INVALID_RESPONSE,
        failure_stage: "chromium_cdp_browser_ws",
        failure_area: "tool_server",
        error_kind: "network",
        failure_command: "cdp",
        network_failure: "invalid_response",
      }
    );
  }
  return url;
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (err) {
    // A caller-driven abort is expected control flow, not a reachability
    // failure — let it surface untouched.
    if (err instanceof Error && err.name === "AbortError") throw err;
    // The common case: nothing is listening on the debug port (the app isn't
    // running, or was started without --remote-debugging-port). `fetch` rejects
    // before we ever get a response, so classify it here rather than letting a
    // raw system error bubble up unclassified. undici wraps the OS error: the
    // ECONN* code lives on err.cause, not err itself — check both and map the
    // well-known socket codes precisely (mirrors the Vega toolkit path) rather
    // than always reporting connection_refused.
    const code =
      (err as NodeJS.ErrnoException).code ?? (err as { cause?: NodeJS.ErrnoException }).cause?.code;
    const network_failure =
      code === "ECONNREFUSED"
        ? "connection_refused"
        : code === "ECONNRESET"
          ? "connection_reset"
          : "other";
    throw new FailureError(
      `Chromium CDP discovery: GET ${url} could not connect. ` +
        `Is the app running with --remote-debugging-port?`,
      {
        error_code: FAILURE_CODES.CHROMIUM_CDP_UNREACHABLE,
        failure_stage: "chromium_cdp_discovery_connect",
        failure_area: "tool_server",
        error_kind: "network",
        failure_command: "cdp",
        network_failure,
      },
      { cause: err instanceof Error ? err : new Error(String(err)) }
    );
  }
  if (!res.ok) {
    // The endpoint was reachable and answered — it just returned a non-2xx
    // status. That is a malformed/erroring response, not a down debug port, so
    // it gets INVALID_RESPONSE (matching browserWebSocketUrl above) rather than
    // UNREACHABLE — telemetry must not conflate the two.
    throw new FailureError(`Chromium CDP discovery: GET ${url} failed (HTTP ${res.status})`, {
      error_code: FAILURE_CODES.CHROMIUM_CDP_INVALID_RESPONSE,
      failure_stage: "chromium_cdp_discovery_fetch",
      failure_area: "tool_server",
      error_kind: "network",
      failure_command: "cdp",
      network_failure: "invalid_response",
    });
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
