import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { JsRuntimeDebuggerApi } from "../../blueprints/js-runtime-debugger";
import {
  NETWORK_INTERCEPTOR_SCRIPT,
  makeNetworkLogReadScript,
} from "../../utils/debugger/scripts/network-interceptor";

const ITEMS_PER_PAGE = 50;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
  const size =
    entry.encodedDataLength != null ? formatBytes(entry.encodedDataLength) : "";
  const duration = entry.durationMs != null ? `${entry.durationMs} ms` : "";

  return `{id: ${entry.requestId}} "${method} ${name}" ${status} ${type} ${size} ${duration}`.trim();
}

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port"),
  pageIndex: z
    .union([z.coerce.number().int().nonnegative(), z.literal("latest")])
    .default("latest")
    .describe(
      'Page index (0-based) or "latest" for the most recent page. Each page contains up to 50 entries.'
    ),
});

export const debuggerNetworkLogsTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  string
> = {
  id: "view-network-logs",
  description: `View captured network (HTTP) requests from the running React Native app.
Returns a paginated list of requests with method, URL, status, resource type, size, and duration.
Each entry includes a requestId that can be passed to view-network-request-details for full details.
The app must be connected via debugger-connect first (auto-connects if needed).
Network interception is injected into the JS runtime — it captures fetch() and XMLHttpRequest calls.`,
  zodSchema,
  services: (params) => ({
    debugger: `JsRuntimeDebugger:${params.port}`,
  }),
  async execute(services, params) {
    const api = services.debugger as JsRuntimeDebuggerApi;

    // Ensure the interceptor is installed (idempotent).
    await api.cdp.evaluate(NETWORK_INTERCEPTOR_SCRIPT).catch(() => {});

    // First get the total count for pagination by running the read script with a
    // zero-length slice — same filtering logic, no duplication.
    const countRaw = await api.cdp.evaluate(
      makeNetworkLogReadScript(0, 0, api.port),
    );
    const { total } = JSON.parse(countRaw as string) as { total: number };

    if (total === 0) {
      return "No network traffic captured. Make sure the app is running and making HTTP requests. Network interception is active — it captures fetch() and XMLHttpRequest calls.";
    }

    const pageCount = Math.ceil(total / ITEMS_PER_PAGE);
    const pageIndex =
      params.pageIndex === "latest"
        ? pageCount - 1
        : (params.pageIndex as number);

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
      return "Network interceptor not installed. Try reconnecting with debugger-connect.";
    }

    const lines = data.entries.map(formatEntry);

    return `=== NETWORK LOGS (page ${pageIndex + 1}/${pageCount}, ${data.total} total) ===\n\n${lines.join("\n")}`;
  },
};
