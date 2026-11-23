import { STATUS_CODES } from "node:http";
import { z } from "zod";
import bytesUtil from "bytes";
import { canonicalDeviceId } from "../../utils/debugger/device-alias";
import type { ServiceRef, ToolDefinition } from "@argent/registry";
import {
  jsCapture,
  jsCapturePayload,
  jsCapturesOn,
  jsUnavailableOn,
  type JsCapture,
  type NetworkInspectorApi,
} from "../../blueprints/network-inspector";
import type { JsRuntimeDebuggerApi } from "../../blueprints/js-runtime-debugger";
import type { CDPClient } from "../../utils/debugger/cdp-client";
import { DEBUGGER_TOOL_CAPABILITY, debuggerServiceRef } from "../debugger/debugger-service-ref";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { resolveDevice } from "../../utils/device-info";
import type { NetworkRequestRecord } from "../../chromium-server";
import {
  NETWORK_INTERCEPTOR_SCRIPT,
  makeNetworkLogReadScript,
} from "../../utils/debugger/scripts/network-interceptor";
import { metroPort, metroPortField } from "../../utils/debugger/metro-port";

const ITEMS_PER_PAGE = 50;

/**
 * Vega installs the interceptor at each read, so it is missing only when that install failed or
 * the app's JS runtime reloaded in between.
 */
function notInstalled(installError: string | undefined): string {
  return installError
    ? `Network interceptor could not be installed in the app's JS runtime: ${installError}`
    : "Network interceptor not installed: the app's JS runtime reloaded, which clears captured requests. Call view-network-logs again to reinstall it, then repeat the action that sends the requests.";
}

const NOT_STARTED =
  "Network capture is not started for this app, so no requests are recorded. Call network-capture-start with udid and bundleId, repeat the action, then";

const PAUSED_BY_STOP =
  "JS runtime does not record new requests: an earlier stop paused it (network-capture-stop, stop-all-simulator-servers or the exit of a tool-server), and no network-capture-start reached it since";

/**
 * The Metro port a read uses. An explicit port wins. Otherwise, a capture that a start stored
 * for this device id on the port its provider publishes for the udid the start gave: a provider
 * claims no Metro logicalDeviceId, so the id alone finds only the default port.
 */
export function jsReadPort(params: { port?: number; device_id?: string }): number {
  if (params.port !== undefined) return params.port;
  const device = canonicalDeviceId(params.device_id);
  const provided = device
    ? jsCapturesOn(device).find(
        (capture) =>
          capture.physicalDeviceId !== undefined &&
          metroPort({ device_id: capture.physicalDeviceId }) === capture.port
      )
    : undefined;
  return provided?.port ?? metroPort(params);
}

/**
 * The debugger of a read of the capture. A start or stop opened it with the
 * device's udid, so a read that opens it again, after a disconnect, does too.
 */
export function jsCaptureDebuggerRef(
  params: { port?: number; device_id?: string },
  capture: JsCapture
): ServiceRef {
  const urn = debuggerServiceRef({ ...params, port: jsReadPort(params) });
  return capture.physicalDeviceId && typeof urn === "string"
    ? { urn, options: { physicalDeviceId: capture.physicalDeviceId } }
    : urn;
}

/**
 * The JS capture a read of `payload` reads, or undefined before any start. A runtime of another
 * app than the capture's has no capture of its own.
 */
export function jsCaptureForRead(
  payload: string,
  runtimeApp: JsRuntimeDebuggerApi["runtimeApp"]
): JsCapture | undefined {
  const capture = jsCapture(payload);
  if (!capture) return undefined;
  if (runtimeApp?.appId !== undefined && runtimeApp.appId !== capture.bundleId) return undefined;
  return capture;
}

/**
 * The not-started text, ending with `then`, and with the Metro ports the device's capture is on
 * instead. After a start that found the JS layer unavailable on the port, it gives that reason.
 */
export function jsNotStarted(
  device: string,
  port: number,
  then = "call view-network-logs again",
  lead = ""
): string {
  const elsewhere = jsCapturesOn(device)
    .filter((capture) => capture.port !== port)
    .map(
      (capture) =>
        ` This device has network capture for ${capture.bundleId} on Metro port ${capture.port}: pass port ${capture.port} to read it.`
    )
    .join("");
  const unavailable = jsUnavailableOn(jsCapturePayload(port, device));
  const head = unavailable
    ? `Network capture is not started on the JS layer: network-capture-start for ${unavailable.bundleId} found it unavailable (${unavailable.reason}). native-network-logs lists the requests of the native layer. Once the JS layer can start, call network-capture-start again, repeat the action, then`
    : NOT_STARTED;
  return `${lead}${head} ${then}.${elsewhere}`;
}

/**
 * What a read says when the app's JS context holds no log: a read never installs, so a started
 * capture stays without one until the next network-capture-start.
 */
export function jsNoLog(capture: JsCapture): string {
  if (capture.intent === "stopped") {
    return capture.installed
      ? `Network capture is stopped for ${capture.bundleId} (network-capture-stop), and the app's JS runtime reloaded since, which cleared its requests. Call network-capture-start to capture again, then repeat the action.`
      : `Network capture is stopped for ${capture.bundleId} (network-capture-stop), and nothing was recorded in the app's current JS runtime. Call network-capture-start to capture again, then repeat the action.`;
  }
  // The native layer records on, so these texts speak for the JS layer only.
  const native = "native-network-logs lists the requests of the native layer.";
  return capture.installed
    ? `The JS layer of network capture for this app stopped recording at a JavaScript reload, so it recorded no requests since the reload. ${native} To record the app's JavaScript requests again, call network-capture-start, repeat the action, then read again.`
    : `Network capture for this app is started, but the app's JavaScript runtime was not ready at the start, so the JS layer recorded no requests. ${native} To record the app's JavaScript requests, call network-capture-start again, repeat the action, then read again.`;
}

// Auto-scaled base-1024 units: a big download reads `1.4 GB`, not `1433.6 MB`.
function formatBytes(bytes: number): string {
  return bytesUtil(bytes, { decimalPlaces: 1, unitSeparator: " " }) ?? `${bytes} B`;
}

interface LogEntry {
  id: number;
  requestId: string;
  state: string;
  request?: { url: string; method: string };
  /** `url` is the final URL, after redirects. */
  response?: { url?: string; status: number; statusText: string; mimeType: string };
  resourceType?: string;
  encodedDataLength?: number;
  /** The full length, in characters, of a text body the interceptor cut without a byte size. */
  bodyLength?: number;
  timestamp?: number;
  durationMs?: number;
  errorText?: string;
}

/**
 * The standard reason phrase of a status ("OK", "Not Found"), or "" for a status without one. The JS
 * runtime records whatever text the platform gives: none from React Native's XHR and fetch, a
 * localised description from iOS for Expo ("no error"), so the tools show this phrase for all.
 */
export function reasonPhrase(status: number): string {
  return STATUS_CODES[status] ?? "";
}

/**
 * A URL in the form two URLs are compared in: without its fragment, which is never sent, and with
 * its percent-encoding undone. The native layer can encode the URL the app gave again (iOS encodes
 * the "%" of a URL that holds a space) or write a space in a query as "+" instead of "%20".
 * decodeURI keeps the escapes that change what a URL means ("%2F", "%3F", "%26", "%2B").
 */
function comparableUrl(url: string): string {
  let text = url;
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    text = parsed.search ? parsed.href : parsed.href.replace(/\?$/, "");
  } catch {
    // Compared as it is written.
  }
  text = text.replace(/\+/g, " ");
  for (let i = 0; i < 4; i++) {
    let decoded: string;
    try {
      decoded = decodeURI(text);
    } catch {
      break;
    }
    if (decoded === text) break;
    text = decoded;
  }
  return text.replace(/%[0-9a-f]{2}/gi, (escape) => escape.toUpperCase());
}

/** Whether a response's final URL is another than the request URL, not the same one written differently. */
export function isRedirect(requestUrl: string | undefined, finalUrl: string | undefined): boolean {
  if (!finalUrl || requestUrl === undefined || finalUrl === requestUrl) return false;
  return comparableUrl(finalUrl) !== comparableUrl(requestUrl);
}

// The path of a URL, or its host for the root. With `from`, the host too when it differs from that one's.
function shortName(url: string, from?: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    let sameHost = true;
    try {
      sameHost = from === undefined || new URL(from).host === parsed.host;
    } catch {
      sameHost = false;
    }
    if (sameHost) return path || parsed.hostname;
    return parsed.host + path;
  } catch {
    return url;
  }
}

function formatEntry(entry: LogEntry): string {
  const method = entry.request?.method ?? "???";
  const url = entry.request?.url ?? "unknown";
  const name = shortName(url);
  const finalUrl = entry.response?.url;
  const redirect = finalUrl && isRedirect(url, finalUrl) ? `→ ${shortName(finalUrl, url)}` : "";

  let status: string;
  if (entry.state === "failed") {
    status = entry.errorText ?? "failed";
  } else if (entry.response) {
    // A response whose body has not completed.
    status = [
      entry.response.status,
      entry.response.statusText,
      entry.state === "pending" ? "(pending)" : "",
    ]
      .filter((part) => part !== "")
      .join(" ");
  } else {
    status = "pending";
  }

  const type = entry.resourceType ?? "";
  // A length in characters is close to the size in bytes, and never more than it.
  const size =
    entry.encodedDataLength != null
      ? formatBytes(entry.encodedDataLength)
      : entry.bodyLength != null
        ? `~${formatBytes(entry.bodyLength)}`
        : "";
  const duration = entry.durationMs != null ? `${entry.durationMs} ms` : "";

  return [`{id: ${entry.requestId}}`, `"${method} ${name}"`, status, type, size, duration, redirect]
    .filter(Boolean)
    .join(" ");
}

function recordToLogEntry(r: NetworkRequestRecord, id: number): LogEntry {
  return {
    id,
    requestId: r.requestId,
    state: r.failed ? "failed" : r.status != null ? "complete" : "pending",
    request: { url: r.url, method: r.method },
    response:
      r.status != null
        ? { status: r.status, statusText: r.statusText ?? "", mimeType: r.mimeType ?? "" }
        : undefined,
    resourceType: r.resourceType,
    encodedDataLength: r.encodedDataLength,
    durationMs: r.durationMs != null ? Math.round(r.durationMs) : undefined,
    errorText: r.errorText,
  };
}

/** Same output format as the RN path. */
function renderChromiumPage(
  records: NetworkRequestRecord[],
  pageIndexParam: number | "latest"
): string {
  const total = records.length;
  if (total === 0) {
    return "No network traffic captured. Recording is active on the active tab. Navigate or reload the page to populate it (requests made before the device was attached are not captured).";
  }
  const pageCount = Math.ceil(total / ITEMS_PER_PAGE);
  const pageIndex = pageIndexParam === "latest" ? pageCount - 1 : pageIndexParam;
  if (pageIndex < 0 || pageIndex >= pageCount) {
    return `Page index out of range. Valid range: 0-${pageCount - 1} (${pageCount} pages, ${total} total requests).`;
  }
  const start = pageIndex * ITEMS_PER_PAGE;
  const lines = records
    .slice(start, start + ITEMS_PER_PAGE)
    .map((r, i) => formatEntry(recordToLogEntry(r, start + i)));
  return `=== NETWORK LOGS (page ${pageIndex + 1}/${pageCount}, ${total} total) ===\n\n${lines.join("\n")}`;
}

const zodSchema = z.object({
  port: metroPortField,
  device_id: z
    .string()
    .describe(
      "Device id from list-devices (iOS simulator UDID<flag:macos-apps>, Mac app id</flag:macos-apps> or Android serial), the same id used with debugger-connect."
    ),
  // `.default` covers only an omitted param, and `z.coerce.number()` reads null as 0, so
  // null would return the oldest page. Agents send null for "not set": read it as "latest".
  pageIndex: z
    .union([z.coerce.number().int().nonnegative(), z.literal("latest")])
    .nullable()
    .default("latest")
    .transform((value) => value ?? "latest")
    .describe(
      'Page index (0-based) or "latest" for the most recent page. Each page contains up to 50 entries.'
    ),
});

export const networkLogsTool: ToolDefinition<z.infer<typeof zodSchema>, string> = {
  id: "view-network-logs",
  description: `Retrieve captured network (HTTP) requests from the running app.
Returns a paginated list of requests with method, URL, status, resource type, size, and duration.
A size with "~" is estimated from the body's length in characters; on React Native, "→ <url>" is the final URL after a redirect.
Pass an entry's requestId to view-network-request-details for full details.
On React Native (iOS / Android / Vega<flag:macos-apps> / Mac apps</flag:macos-apps>) an interceptor injected into the JS runtime records each request once, from XMLHttpRequest (axios included), React Native's fetch, Expo's fetch, and, in a Metro development build, a fetch library that sends through React Native's network module itself, such as react-native-fetch-api. On iOS and Android this tool only reads: call network-capture-start first, then repeat the action; until then it says capture is not started. A reload clears the requests and stops recording until network-capture-start runs again, which the answer says. On Vega<flag:macos-apps> and on a Mac app</flag:macos-apps> capture starts at the first network-tool call.<flag:macos-apps> On a Mac app, native-network-logs records the same fetch requests again from NSURLSession.</flag:macos-apps> On Chromium it reads the CDP Network domain of the active tab (all request types).
Use when inspecting outbound HTTP traffic or debugging API calls in the running app.
Fails if the app is not connected (RN) or the device is not reachable (Chromium).`,
  zodSchema,
  readOnly: true,
  interaction: {
    startedMsg: () => "Reading network activity",
    completedMsg: () => "Read network activity",
    failedMsg: ({ failureSignal }) =>
      `Failed to read network activity: ${failureSignal.error_code}`,
  },
  capability: DEBUGGER_TOOL_CAPABILITY,
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.device_id);
    if (device.platform === "chromium") {
      return { chromium: chromiumCdpRef(device) };
    }
    const payload = jsCapturePayload(jsReadPort(params), canonicalDeviceId(params.device_id)!);
    // Vega and Mac apps have no network-capture-start, so their read still installs the interceptor.
    if (device.platform === "vega" || device.platform === "macos")
      return { inspector: `NetworkInspector:${payload}` };
    // A read never starts capture: before a start it reaches nothing in the app.
    const capture = jsCapture(payload);
    return capture ? { debugger: jsCaptureDebuggerRef(params, capture) } : {};
  },
  async execute(services, params) {
    const device = resolveDevice(params.device_id);
    if (device.platform === "chromium") {
      const chromium = services.chromium as ChromiumCdpApi;
      return renderChromiumPage(chromium.server.network.requests(), params.pageIndex);
    }
    const port = jsReadPort(params);

    if (device.platform === "vega" || device.platform === "macos") {
      const api = services.inspector as NetworkInspectorApi;
      // Idempotent: a second install is a no-op.
      const installError = await api.cdp.evaluate(NETWORK_INTERCEPTOR_SCRIPT).then(
        () => undefined,
        (err: unknown) => (err instanceof Error ? err.message : String(err))
      );
      return renderJsLog(api.cdp, port, params.pageIndex, {
        noLog: () => notInstalled(installError),
        empty:
          "No network traffic captured. Make sure the app is running and making HTTP requests. Network interception is active: it records XMLHttpRequest (axios included), React Native's fetch, Expo's fetch, and a fetch library that sends through React Native's network module, but not requests sent before capture started (at the first network-tool call).",
      });
    }

    const deviceId = canonicalDeviceId(params.device_id)!;
    const dbg = services.debugger as JsRuntimeDebuggerApi | undefined;
    const capture = dbg && jsCaptureForRead(jsCapturePayload(port, deviceId), dbg.runtimeApp);
    if (!dbg || !capture) return jsNotStarted(deviceId, port);
    const stopped = capture.intent === "stopped";
    return renderJsLog(dbg.cdp, port, params.pageIndex, {
      noLog: () => jsNoLog(capture),
      empty: stopped
        ? `No network traffic captured: network capture is stopped for ${capture.bundleId} (network-capture-stop). Call network-capture-start to capture again, then repeat the action.`
        : "No network traffic captured. Make sure the app is running and making HTTP requests. Network interception is active: it records XMLHttpRequest (axios included), React Native's fetch, Expo's fetch, and a fetch library that sends through React Native's network module, but not requests sent before network-capture-start.",
      headerNote: stopped ? "capture stopped" : undefined,
      // A start that does not reach the app's JS context keeps the pause of an earlier stop there.
      paused: stopped
        ? undefined
        : {
            empty: `No network traffic captured. The app's ${PAUSED_BY_STOP}. Call network-capture-start, then repeat the action.`,
            headerNote: `the app's ${PAUSED_BY_STOP}, so call network-capture-start, then repeat the action`,
          },
    });
  },
};

async function renderJsLog(
  cdp: CDPClient,
  port: number,
  pageIndexParam: number | "latest",
  texts: {
    noLog: () => string;
    empty: string;
    headerNote?: string;
    /** The texts to show instead while a stop's pause stays in the app's JS context. */
    paused?: { empty: string; headerNote: string };
  }
): Promise<string> {
  // Zero-length slice: reuses the read script's Metro filtering just to get the total.
  const countRaw = await cdp.evaluate(makeNetworkLogReadScript(0, 0, port));
  const { total, interceptorInstalled, paused } = JSON.parse(countRaw as string) as {
    total: number;
    interceptorInstalled: boolean;
    paused?: boolean;
  };

  if (!interceptorInstalled) return texts.noLog();
  const shown = (paused === true && texts.paused) || texts;
  if (total === 0) return shown.empty;

  const pageCount = Math.ceil(total / ITEMS_PER_PAGE);
  const pageIndex = pageIndexParam === "latest" ? pageCount - 1 : pageIndexParam;

  if (pageIndex < 0 || pageIndex >= pageCount) {
    return `Page index out of range. Valid range: 0-${pageCount - 1} (${pageCount} pages, ${total} total requests).`;
  }

  const start = pageIndex * ITEMS_PER_PAGE;
  const raw = await cdp.evaluate(makeNetworkLogReadScript(start, ITEMS_PER_PAGE, port));
  const data = JSON.parse(raw as string) as {
    entries: LogEntry[];
    total: number;
    interceptorInstalled: boolean;
  };

  if (!data.interceptorInstalled) return texts.noLog();

  const lines = data.entries.map((entry) =>
    formatEntry(
      entry.response
        ? {
            ...entry,
            response: { ...entry.response, statusText: reasonPhrase(entry.response.status) },
          }
        : entry
    )
  );

  const note = shown.headerNote ? `; ${shown.headerNote}` : "";
  return `=== NETWORK LOGS (page ${pageIndex + 1}/${pageCount}, ${data.total} total${note}) ===\n\n${lines.join("\n")}`;
}
