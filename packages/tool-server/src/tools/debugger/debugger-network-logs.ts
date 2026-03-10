import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type {
  JsRuntimeDebuggerApi,
  NetworkLogEntry,
} from "../../blueprints/js-runtime-debugger";

const ITEMS_PER_PAGE = 50;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatEntry(entry: NetworkLogEntry): string {
  const method = entry.request?.method ?? "???";
  const url = entry.request?.url ?? "unknown";

  // Show just the pathname (or hostname if no path)
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
  const duration =
    entry.durationMs != null ? `${entry.durationMs} ms` : "";

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
  id: "debugger-network-logs",
  description: `View captured network (HTTP) requests from the running React Native app.
Returns a paginated list of requests with method, URL, status, resource type, size, and duration.
Each entry includes a requestId that can be passed to debugger-network-request for full details.
The app must be connected via debugger-connect first (auto-connects if needed).
Note: Network capture requires the CDP Network domain to be supported by the runtime.`,
  zodSchema,
  services: (params) => ({
    debugger: `JsRuntimeDebugger:${params.port}`,
  }),
  async execute(services, params) {
    const api = services.debugger as JsRuntimeDebuggerApi;
    const logs = api.networkLogs;

    if (logs.length === 0) {
      return "No network traffic captured. Make sure the app is running and making HTTP requests. Network capture starts when the debugger connects.";
    }

    const pageCount = Math.ceil(logs.length / ITEMS_PER_PAGE);
    const pageIndex =
      params.pageIndex === "latest"
        ? pageCount - 1
        : (params.pageIndex as number);

    if (pageIndex < 0 || pageIndex >= pageCount) {
      return `Page index out of range. Valid range: 0-${pageCount - 1} (${pageCount} pages, ${logs.length} total requests).`;
    }

    const start = pageIndex * ITEMS_PER_PAGE;
    const end = Math.min(start + ITEMS_PER_PAGE, logs.length);

    const lines = logs.slice(start, end).map(formatEntry);

    return `=== NETWORK LOGS (page ${pageIndex + 1}/${pageCount}, ${logs.length} total) ===\n\n${lines.join("\n")}`;
  },
};
