/**
 * How `debugger-log-registry` reaches an agent when connected. The tool-server
 * JSON stays as it is for the SDK, CLI and tests.
 *
 * The agent gets a compact summary header, the log file path and size, an
 * optional note, one line per message cluster, and one line per recent entry
 * (matching the on-disk `[L:<id>]` log format). `not_connected` and unknown
 * shapes return `undefined` and fall back to `toMcpContent`.
 */

type Entry = Record<string, unknown>;

const KNOWN_TOP_KEYS = new Set([
  "status",
  "file",
  "totalEntries",
  "byLevel",
  "fileSizeBytes",
  "clusters",
  "entries",
  "deviceName",
  "appName",
  "logicalDeviceId",
  "note",
]);

function isRecord(value: unknown): value is Entry {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCluster(value: unknown): value is Entry {
  return (
    isRecord(value) &&
    typeof value.message === "string" &&
    typeof value.count === "number" &&
    typeof value.level === "string" &&
    typeof value.firstId === "number" &&
    typeof value.lastId === "number"
  );
}

function isRecentEntry(value: unknown): value is Entry {
  return (
    isRecord(value) &&
    typeof value.id === "number" &&
    typeof value.timestamp === "string" &&
    typeof value.level === "string" &&
    typeof value.message === "string"
  );
}

function quoteIfNeeded(value: string): string {
  return value === "" || /[\s"\\]/.test(value) ? JSON.stringify(value) : value;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}

function formatMessage(message: string): string {
  return message.includes("\n") ? message.replace(/\r?\n/g, "\n  ") : message;
}

function extraFields(record: Entry): string[] {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (KNOWN_TOP_KEYS.has(key) || value === undefined || value === null) continue;
    if (value === true) parts.push(key);
    else if (typeof value === "string" || typeof value === "number") {
      parts.push(`${key}=${quoteIfNeeded(String(value))}`);
    } else {
      parts.push(`${key}=${JSON.stringify(value)}`);
    }
  }
  return parts;
}

function formatClusterLine(cluster: Entry): string {
  const count = cluster.count as number;
  const level = cluster.level as string;
  const firstId = cluster.firstId as number;
  const lastId = cluster.lastId as number;
  const message = cluster.message as string;
  const idRange = firstId === lastId ? `#${firstId}` : `#${firstId}..#${lastId}`;
  const sourceFile =
    typeof cluster.sourceFile === "string" && cluster.sourceFile ? cluster.sourceFile : undefined;
  const sourceLine = typeof cluster.sourceLine === "number" ? cluster.sourceLine : undefined;
  const source = sourceFile
    ? ` ${sourceFile}${sourceLine !== undefined ? `:${sourceLine}` : ""}`
    : "";
  return `[x${count}] ${level} ${idRange}${source} | ${formatMessage(message)}`;
}

function formatEntryLine(entry: Entry): string {
  const id = entry.id as number;
  const timestamp = entry.timestamp as string;
  const level = entry.level as string;
  const message = entry.message as string;
  return `[L:${id}] ${timestamp} ${level} | ${formatMessage(message)}`;
}

/**
 * Compact text for a connected `debugger-log-registry` response, or
 * `undefined` for `not_connected` and unknown shapes.
 */
export function debuggerLogRegistryText(result: unknown): string | undefined {
  if (
    !isRecord(result) ||
    result.status !== "connected" ||
    typeof result.file !== "string" ||
    typeof result.totalEntries !== "number" ||
    !isRecord(result.byLevel) ||
    typeof result.fileSizeBytes !== "number" ||
    !Array.isArray(result.clusters) ||
    !result.clusters.every(isCluster) ||
    !Array.isArray(result.entries) ||
    !result.entries.every(isRecentEntry)
  ) {
    return undefined;
  }

  const total = result.totalEntries;
  const noun = total === 1 ? "entry" : "entries";
  const levelParts = Object.entries(result.byLevel)
    .filter(([, count]) => typeof count === "number" && count > 0)
    .map(([level, count]) => `${level}=${count}`);
  const levelsSuffix = levelParts.length > 0 ? ` (${levelParts.join(", ")})` : "";

  const metaParts: string[] = [];
  if (typeof result.appName === "string" && result.appName) {
    metaParts.push(`app=${quoteIfNeeded(result.appName)}`);
  }
  if (typeof result.deviceName === "string" && result.deviceName) {
    metaParts.push(`device=${quoteIfNeeded(result.deviceName)}`);
  }
  if (typeof result.logicalDeviceId === "string" && result.logicalDeviceId) {
    metaParts.push(`id=${quoteIfNeeded(result.logicalDeviceId)}`);
  }
  const metaSuffix = metaParts.length > 0 ? ` | ${metaParts.join(" ")}` : "";

  const lines: string[] = [
    `JS console logs (connected): ${total} ${noun}${levelsSuffix}${metaSuffix}`,
    `File: ${result.file} (${formatBytes(result.fileSizeBytes)})`,
  ];

  if (typeof result.note === "string" && result.note) {
    lines.push(`Note: ${result.note}`);
  }

  const extras = extraFields(result);
  if (extras.length > 0) lines.push(extras.join(" "));

  if (result.clusters.length > 0) {
    lines.push("", `Clusters (${result.clusters.length}):`);
    for (const cluster of result.clusters) {
      lines.push(formatClusterLine(cluster));
    }
  }

  if (result.entries.length > 0) {
    lines.push("", `Recent entries (${result.entries.length}, oldest first):`);
    for (const entry of result.entries) {
      lines.push(formatEntryLine(entry));
    }
  } else if (total > 0) {
    lines.push("", "Recent entries: none");
  }

  return lines.join("\n");
}
