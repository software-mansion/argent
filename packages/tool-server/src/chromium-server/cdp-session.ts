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

interface CdpVersionInfo {
  "Browser"?: string;
  "webSocketDebuggerUrl"?: string;
  "Protocol-Version"?: string;
}

/** Liveness probe for a CDP endpoint (`/json/version`). */
export async function ensureCdpReachable(
  port: number,
  signal?: AbortSignal
): Promise<CdpVersionInfo> {
  return fetchJson<CdpVersionInfo>(`http://127.0.0.1:${port}/json/version`, signal);
}

/**
 * The drivable "page" targets — one per BrowserWindow / browser tab — minus
 * `devtools://` inspector pages. Order follows Chromium's `/json/list`, which
 * is roughly most-recently-focused first.
 */
export async function listPageTargets(port: number, signal?: AbortSignal): Promise<CdpTarget[]> {
  const targets = await fetchJson<CdpTarget[]>(`http://127.0.0.1:${port}/json/list`, signal);
  return targets.filter(
    (t) => t.type === "page" && !!t.webSocketDebuggerUrl && !t.url.startsWith("devtools://")
  );
}

/**
 * The renderer page we should drive on `port`.
 *
 * Throws when the only pages are `devtools://` — driving input into the
 * inspector instead of the real window is a hard-to-debug failure mode.
 */
export async function discoverPrimaryPage(port: number, signal?: AbortSignal): Promise<CdpTarget> {
  const pages = await listPageTargets(port, signal);
  if (pages.length === 0) {
    // Re-fetch unfiltered to tell "no pages" from "only devtools://".
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
 * Browser-level CDP WebSocket URL, needed for browser-scoped commands like
 * `Target.createTarget` / `Target.closeTarget`.
 */
export async function browserWebSocketUrl(port: number, signal?: AbortSignal): Promise<string> {
  const version = await ensureCdpReachable(port, signal);
  const url = version.webSocketDebuggerUrl;
  if (!url) {
    throw new FailureError(
      `Chromium CDP on port ${port} did not report a browser webSocketDebuggerUrl in /json/version.`,
      {
        // Reached but malformed — telemetry must not conflate this with a
        // genuinely down debug port.
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
    // A caller-driven abort is expected control flow, not a reachability failure.
    if (err instanceof Error && err.name === "AbortError") throw err;
    // undici wraps the OS error: the ECONN* code lives on err.cause, not on
    // err itself — check both, so the class is precise instead of always
    // connection_refused.
    const code =
      (err as NodeJS.ErrnoException).code ?? (err as { cause?: NodeJS.ErrnoException }).cause?.code;
    const network_failure =
      code === "ECONNREFUSED"
        ? "connection_refused"
        : code === "ECONNRESET"
          ? "connection_reset"
          : code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT"
            ? "timeout"
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
    // Reachable but non-2xx: "reached but malformed", not a down debug port.
    throw new FailureError(`Chromium CDP discovery: GET ${url} failed (HTTP ${res.status})`, {
      error_code: FAILURE_CODES.CHROMIUM_CDP_INVALID_RESPONSE,
      failure_stage: "chromium_cdp_discovery_fetch",
      failure_area: "tool_server",
      error_kind: "network",
      failure_command: "cdp",
      network_failure: "invalid_response",
    });
  }
  try {
    return (await res.json()) as T;
  } catch (err) {
    // An abort mid-body is expected control flow, like the fetch() catch above.
    if (err instanceof Error && err.name === "AbortError") throw err;
    // 200 with a non-JSON body — a non-CDP service squatting the debug port,
    // or a truncated one. Same "reached but malformed" class as !res.ok above.
    throw new FailureError(
      `Chromium CDP discovery: GET ${url} returned a body that is not valid JSON`,
      {
        error_code: FAILURE_CODES.CHROMIUM_CDP_INVALID_RESPONSE,
        failure_stage: "chromium_cdp_discovery_parse",
        failure_area: "tool_server",
        error_kind: "network",
        failure_command: "cdp",
        network_failure: "invalid_response",
      },
      { cause: err instanceof Error ? err : new Error(String(err)) }
    );
  }
}

/**
 * Open a CDP client against the primary page target on `port`. The Origin
 * header is suppressed because Chromium's devtools-target rejects WS upgrades
 * that carry one.
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
 * Best-effort priming of a (re)connected page session: domain enables plus
 * focus emulation. Every step is non-fatal — most CDP commands work without
 * the domain enabled, but Page.navigate / Input.* report better errors when
 * theirs is.
 *
 * Focus emulation makes the page believe it is focused even when the OS window
 * is not (`document.hasFocus()` → true, `document.visibilityState` pinned to
 * "visible", input unthrottled while the window is minimized). It dies with the
 * CDP session, so the tab manager's onActivated re-applies it after every
 * reconnect. Trade-off: while a session is attached the app can never observe a
 * real blur or hidden state.
 */
export async function primePageSession(cdp: CDPClient): Promise<void> {
  for (const domain of ["Page", "DOM", "Runtime", "Accessibility"]) {
    try {
      await cdp.send(`${domain}.enable`);
    } catch {
      /* ignore */
    }
  }
  try {
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  } catch {
    /* unsupported runtime: input still works, just unfocused */
  }
}

/** Staging directory for screenshot files. */
export function mediaDir(): string {
  const dir = path.join(os.tmpdir(), "argent-chromium-media");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
