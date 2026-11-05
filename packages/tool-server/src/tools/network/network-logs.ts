import { STATUS_CODES } from "node:http";
import { z } from "zod";
import bytesUtil from "bytes";
import { canonicalDeviceId } from "../../utils/debugger/device-alias";
import type { ServiceRef, ToolDefinition } from "@argent/registry";
import type { NetworkInspectorApi } from "../../blueprints/network-inspector";
import { DEBUGGER_TOOL_CAPABILITY } from "../debugger/debugger-service-ref";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { resolveDevice } from "../../utils/device-info";
import type { NetworkRequestRecord } from "../../chromium-server";
import {
  NETWORK_INTERCEPTOR_SCRIPT,
  makeNetworkLogReadScript,
} from "../../utils/debugger/scripts/network-interceptor";
import { metroPort, metroPortField } from "../../utils/debugger/metro-port";

const ITEMS_PER_PAGE = 50;

// Each call installs the interceptor first, so it is missing only when that install failed or the
// app's JS runtime reloaded in between.
function notInstalled(installError: string | undefined): string {
  return installError
    ? `Network interceptor could not be installed in the app's JS runtime: ${installError}`
    : "Network interceptor not installed: the app's JS runtime reloaded, which clears captured requests. Call view-network-logs again to reinstall it, then repeat the action that sends the requests.";
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
      "Device id from list-devices (iOS simulator UDID or Android serial), the same id used with debugger-connect."
    ),
  pageIndex: z
    .union([z.coerce.number().int().nonnegative(), z.literal("latest")])
    .default("latest")
    .describe(
      'Page index (0-based) or "latest" for the most recent page. Each page contains up to 50 entries.'
    ),
});

export const networkLogsTool: ToolDefinition<z.infer<typeof zodSchema>, string> = {
  id: "view-network-logs",
  interaction: {
    startedMsg: () => "Reading network activity",
    completedMsg: () => "Read network activity",
    failedMsg: ({ failureSignal }) =>
      `Failed to read network activity: ${failureSignal.error_code}`,
  },
  description: `Retrieve captured network (HTTP) requests from the running app.
Returns a paginated list of requests with method, URL, status, resource type, size, and duration.
A size with "~" is estimated from the body's length in characters; on React Native, "→ <url>" is the final URL after a redirect.
Each entry includes a requestId that can be passed to view-network-request-details for full details.
On React Native (iOS / Android / Vega) interception is injected into the JS runtime: it records each request once: XMLHttpRequest (axios included), React Native's fetch, Expo's fetch, and a fetch library that sends through React Native's network module itself, such as react-native-fetch-api (found in a Metro development build). Capture starts at the first network-tool call; a reload clears it. On Chromium it reads the browser's native CDP Network domain (the active tab; all request types).
Use when inspecting outbound HTTP traffic or debugging API calls in the running app.
Fails if the app is not connected (RN) or the device is not reachable (Chromium).`,
  readOnly: true,
  zodSchema,
  capability: DEBUGGER_TOOL_CAPABILITY,
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.device_id);
    if (device.platform === "chromium") {
      return { chromium: chromiumCdpRef(device) };
    }
    return {
      inspector: `NetworkInspector:${metroPort(params)}:${canonicalDeviceId(params.device_id)}`,
    };
  },
  async execute(services, params) {
    if (resolveDevice(params.device_id).platform === "chromium") {
      const chromium = services.chromium as ChromiumCdpApi;
      return renderChromiumPage(chromium.server.network.requests(), params.pageIndex);
    }

    const api = services.inspector as NetworkInspectorApi;

    // Idempotent: a second install is a no-op.
    const installError = await api.cdp.evaluate(NETWORK_INTERCEPTOR_SCRIPT).then(
      () => undefined,
      (err: unknown) => (err instanceof Error ? err.message : String(err))
    );

    // Zero-length slice: reuses the read script's Metro filtering just to get the total.
    const countRaw = await api.cdp.evaluate(makeNetworkLogReadScript(0, 0, api.port));
    const { total, interceptorInstalled } = JSON.parse(countRaw as string) as {
      total: number;
      interceptorInstalled: boolean;
    };

    if (!interceptorInstalled) return notInstalled(installError);

    if (total === 0) {
      return "No network traffic captured. Make sure the app is running and making HTTP requests. Network interception is active: it records XMLHttpRequest (axios included), React Native's fetch, Expo's fetch, and a fetch library that sends through React Native's network module, but not requests sent before capture started (at the first network-tool call).";
    }

    const pageCount = Math.ceil(total / ITEMS_PER_PAGE);
    const pageIndex = params.pageIndex === "latest" ? pageCount - 1 : (params.pageIndex as number);

    if (pageIndex < 0 || pageIndex >= pageCount) {
      return `Page index out of range. Valid range: 0-${pageCount - 1} (${pageCount} pages, ${total} total requests).`;
    }

    const start = pageIndex * ITEMS_PER_PAGE;
    const readScript = makeNetworkLogReadScript(start, ITEMS_PER_PAGE, api.port);
    const raw = await api.cdp.evaluate(readScript);
    const data = JSON.parse(raw as string) as {
      entries: LogEntry[];
      total: number;
      interceptorInstalled: boolean;
    };

    if (!data.interceptorInstalled) return notInstalled(installError);

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

    return `=== NETWORK LOGS (page ${pageIndex + 1}/${pageCount}, ${data.total} total) ===\n\n${lines.join("\n")}`;
  },
};
