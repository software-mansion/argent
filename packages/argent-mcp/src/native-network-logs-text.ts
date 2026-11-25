/**
 * How `native-network-logs` reaches an agent. The tool-server JSON stays as it
 * is for the SDK, CLI and tests.
 *
 * The agent gets the header plus one line per request, matching the compact
 * format of `view-network-logs` while keeping the full URL and every field
 * (`id`, `method`, `url`, `state`, `status`, `mimeType`, `durationMs`,
 * `errorText`, `rnRequestId`). Unrecognized shapes (such as precheck blocks
 * with `status: "restart_required"`) return `undefined` and fall back to JSON.
 */

type Entry = Record<string, unknown>;

const KNOWN_TOP_KEYS = new Set([
  "status",
  "header",
  "armed",
  "started",
  "stopped",
  "capture",
  "captureDetail",
  "count",
  "total",
  "requests",
]);

const KNOWN_REQUEST_KEYS = new Set([
  "id",
  "method",
  "url",
  "state",
  "status",
  "mimeType",
  "durationMs",
  "errorText",
  "rnRequestId",
]);

function isRecord(value: unknown): value is Entry {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRequestLine(value: unknown): value is Entry {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.method === "string" &&
    typeof value.url === "string" &&
    typeof value.state === "string"
  );
}

function quoteIfNeeded(value: string): string {
  return value === "" || /[\s"\\]/.test(value) ? JSON.stringify(value) : value;
}

function extraFields(record: Entry, known: Set<string>): string[] {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (known.has(key) || value === undefined || value === null) continue;
    if (value === true) parts.push(key);
    else if (typeof value === "string" || typeof value === "number") {
      parts.push(`${key}=${quoteIfNeeded(String(value))}`);
    } else {
      parts.push(`${key}=${JSON.stringify(value)}`);
    }
  }
  return parts;
}

function formatRequestLine(req: Entry): string {
  const id = req.id as string;
  const method = req.method as string;
  const url = req.url as string;
  const state = req.state as string;
  const status = typeof req.status === "number" ? req.status : undefined;
  const mimeType = typeof req.mimeType === "string" && req.mimeType ? req.mimeType : undefined;
  const durationMs = typeof req.durationMs === "number" ? req.durationMs : undefined;
  const errorText = typeof req.errorText === "string" && req.errorText ? req.errorText : undefined;
  const rnRequestId = typeof req.rnRequestId === "number" ? req.rnRequestId : undefined;

  let outcome: string;
  if (state === "failed") {
    outcome = [
      "failed",
      status !== undefined ? String(status) : "",
      errorText ? JSON.stringify(errorText) : "",
    ]
      .filter(Boolean)
      .join(" ");
  } else if (status !== undefined) {
    outcome = state === "complete" ? String(status) : `${status} (${state})`;
  } else {
    outcome = state;
  }

  const parts = [
    `{id: ${id}}`,
    JSON.stringify(`${method} ${url}`),
    outcome,
    mimeType ?? "",
    durationMs !== undefined ? `${durationMs}ms` : "",
    rnRequestId !== undefined ? `rnRequestId=${rnRequestId}` : "",
    ...extraFields(req, KNOWN_REQUEST_KEYS),
  ].filter(Boolean);

  return parts.join(" ");
}

/**
 * Compact text for a `native-network-logs` listing, or `undefined` for
 * precheck blocks and unknown shapes, which then go out via `toMcpContent`.
 */
export function nativeNetworkLogsText(result: unknown): string | undefined {
  if (
    !isRecord(result) ||
    result.status !== "ok" ||
    typeof result.header !== "string" ||
    typeof result.armed !== "boolean" ||
    typeof result.count !== "number" ||
    typeof result.total !== "number" ||
    !Array.isArray(result.requests) ||
    !result.requests.every(isRequestLine)
  ) {
    return undefined;
  }

  const lines: string[] = [result.header];

  if (typeof result.capture === "string" && !result.header.includes(`capture ${result.capture}`)) {
    const detail =
      typeof result.captureDetail === "string" && result.captureDetail
        ? ` (${result.captureDetail})`
        : "";
    lines.push(`Capture: ${result.capture}${detail}`);
  }

  if (result.count < result.total) {
    lines.push(
      `Showing ${result.count === 0 ? "0" : `last ${result.count}`} of ${result.total} requests.`
    );
  }

  const extras = extraFields(result, KNOWN_TOP_KEYS);
  if (extras.length > 0) lines.push(extras.join(" "));

  for (const req of result.requests) {
    lines.push(formatRequestLine(req));
  }

  return lines.join("\n");
}
