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

const ITEMS_PER_PAGE = 50;

// `bytes` (base-1024) so a download above 1 GB shows `1.4 GB`, not `1433.6 MB`.
function formatBytes(bytes: number): string {
  return bytesUtil(bytes, { decimalPlaces: 1, unitSeparator: " " }) ?? `${bytes} B`;
}

interface LogEntry {
  id: number;
  requestId: string;
  state: string;
  request?: { url: string; method: string };
  response?: { status: number; statusText: string; mimeType: string };
  resourceType?: string;
  encodedDataLength?: number;
  timestamp?: number;
  durationMs?: number;
  errorText?: string;
}

function formatEntry(entry: LogEntry): string {
  const method = entry.request?.method ?? "???";
  const url = entry.request?.url ?? "unknown";

  let name: string;
  try {
    const parsed = new URL(url);
    name = parsed.pathname === "/" ? parsed.hostname : parsed.pathname;
  } catch {
    name = url;
  }

  let status: string;
  if (entry.state === "failed") {
    status = entry.errorText ?? "failed";
  } else if (entry.response) {
    status = `${entry.response.status} ${entry.response.statusText}`;
  } else {
    status = "pending";
  }

  const type = entry.resourceType ?? "";
  const size = entry.encodedDataLength != null ? formatBytes(entry.encodedDataLength) : "";
  const duration = entry.durationMs != null ? `${entry.durationMs} ms` : "";

  return `{id: ${entry.requestId}} "${method} ${name}" ${status} ${type} ${size} ${duration}`.trim();
}

/** Map a Chromium CDP record into the shared LogEntry shape used by formatEntry. */
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

/** Render one page of Chromium records in the same format as the RN path. */
function renderChromiumPage(
  records: NetworkRequestRecord[],
  pageIndexParam: number | "latest"
): string {
  const total = records.length;
  if (total === 0) {
    return "No network traffic captured. Recording is active on the active tab — navigate or reload the page to populate it (requests made before the device was attached are not captured).";
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
  port: z.coerce
    .number()
    .default(8081)
    .describe("Metro server port (RN only; ignored on Chromium)"),
  device_id: z
    .string()
    .describe(
      "Device id from list-devices (iOS simulator UDID or Android serial) — the same id used with debugger-connect."
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
  description: `Retrieve captured network (HTTP) requests from the running app.
Returns a paginated list of requests with method, URL, status, resource type, size, and duration.
Each entry includes a requestId that can be passed to view-network-request-details for full details.
On React Native (iOS / Android / Vega) interception is injected into the JS runtime — it captures fetch() calls. On Chromium it reads the browser's native CDP Network domain (the active tab; all request types).
Use when inspecting outbound HTTP traffic or debugging API calls in the running app.
Fails if the app is not connected (RN) or the device is not reachable (Chromium).`,
  zodSchema,
  // Works on RN (Metro-injected interceptor) and Chromium (native CDP Network
  // domain), dispatched on the device id in `services` / `execute`.
  capability: DEBUGGER_TOOL_CAPABILITY,
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.device_id);
    if (device.platform === "chromium") {
      return { chromium: chromiumCdpRef(device) };
    }
    return { inspector: `NetworkInspector:${params.port}:${canonicalDeviceId(params.device_id)}` };
  },
  async execute(services, params) {
    // Chromium: read the server-side CDP Network recording (no in-app injection).
    if (resolveDevice(params.device_id).platform === "chromium") {
      const chromium = services.chromium as ChromiumCdpApi;
      return renderChromiumPage(chromium.server.network.requests(), params.pageIndex);
    }

    const api = services.inspector as NetworkInspectorApi;

    // Ensure the interceptor is installed (idempotent).
    await api.cdp.evaluate(NETWORK_INTERCEPTOR_SCRIPT).catch(() => {});

    // First get the total count for pagination by running the read script with a
    // zero-length slice — same filtering logic, no duplication.
    const countRaw = await api.cdp.evaluate(makeNetworkLogReadScript(0, 0, api.port));
    const { total } = JSON.parse(countRaw as string) as { total: number };

    if (total === 0) {
      return "No network traffic captured. Make sure the app is running and making HTTP requests. Network interception is active — it captures fetch() calls.";
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

    if (!data.interceptorInstalled) {
      return "Network interceptor not installed. Try reconnecting with network-inspector-connect.";
    }

    const lines = data.entries.map(formatEntry);

    return `=== NETWORK LOGS (page ${pageIndex + 1}/${pageCount}, ${data.total} total) ===\n\n${lines.join("\n")}`;
  },
};
