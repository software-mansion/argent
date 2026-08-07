import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface RichLogEntry {
  marker: string;
  id: number;
  timestamp: string;
  level: string;
  message: string;
  stackTrace?: {
    callFrames: Array<{
      functionName: string;
      scriptId: string;
      url: string;
      lineNumber: number;
      columnNumber: number;
    }>;
  };
}

export interface MessageCluster {
  message: string;
  count: number;
  level: string;
  firstId: number;
  lastId: number;
  sourceFile?: string;
  sourceLine?: number;
}

export interface LogStats {
  file: string;
  totalEntries: number;
  byLevel: Record<string, number>;
  fileSizeBytes: number;
}

interface ClusterState {
  message: string;
  count: number;
  level: string;
  firstId: number;
  lastId: number;
  sourceFile?: string;
  sourceLine?: number;
}

const MAX_ENTRIES = 50_000;
const CLUSTER_KEY_LENGTH = 80;
const SOURCE_EXT = /\.(tsx?|jsx?|mjs|cjs)$/;

const LEVEL_DISPLAY: Record<string, string> = {
  log: "LOG  ",
  warn: "WARN ",
  error: "ERROR",
  info: "INFO ",
  debug: "DEBUG",
};

// [L:<id>] <timestamp> <LEVEL> <source> | <message>
const LINE_RE = /^\[L:(\d+)\] (\S+) (\S+)\s+(\S+) \| (.*)$/;

export class LogFileWriter {
  private filePath: string;
  private fd: number | null = null;
  private writeBuffer: string[] = [];
  private bytesWritten = 0;
  private entryCount = 0;
  private levelCounts: Record<string, number> = {};
  private clusters = new Map<string, ClusterState>();
  private ready = false;
  private closed = false;

  constructor(port: number) {
    const timestamp = Date.now();
    const dir = path.join(os.homedir(), ".argent", "tmp");
    fs.mkdirSync(dir, { recursive: true });
    pruneStaleLogs(dir);
    this.filePath = path.join(dir, `argent-logs-${port}-${timestamp}.log`);
    this.open();
  }

  private open(): void {
    try {
      this.fd = fs.openSync(this.filePath, "w");
      this.ready = true;
      this.flushBuffer();
    } catch {
      // Will retry on next write or buffer until ready
    }
  }

  private flushBuffer(): void {
    if (!this.ready || this.fd === null) return;
    for (const line of this.writeBuffer) {
      const buf = Buffer.from(line);
      fs.writeSync(this.fd, buf);
    }
    this.writeBuffer = [];
  }

  write(entry: Omit<RichLogEntry, "marker">): RichLogEntry {
    if (this.closed) throw new Error("LogFileWriter is closed");
    if (this.entryCount >= MAX_ENTRIES) {
      return { ...entry, marker: `[L:${entry.id}]` };
    }

    const rich: RichLogEntry = {
      ...entry,
      marker: `[L:${entry.id}]`,
    };

    // Extract source from stackTrace at write time
    const sourceUrl = entry.stackTrace?.callFrames?.[0]?.url;
    const sourceLine = entry.stackTrace?.callFrames?.[0]?.lineNumber;
    const sourceFile = sourceUrl ? (cleanSourceUrl(sourceUrl) ?? undefined) : undefined;
    const source =
      sourceFile !== undefined && sourceLine !== undefined ? `${sourceFile}:${sourceLine}` : "-";

    // Collapse newlines in message for flat format
    const flatMessage = entry.message.replace(/\n/g, " ");
    // Pad to 5 for column alignment but NEVER truncate: the level must round-trip
    // exactly through parseFlatLine for levels of any length. CDP emits levels
    // longer than 5 chars (e.g. "warning" from console.warn, "assert" from
    // console.assert); slicing to 5 would persist "warni"/"asser" and break
    // readFiltered({ level: "warning" }). LINE_RE captures the level as \S+, so a
    // non-truncated, whitespace-free level survives the write→read round-trip.
    const levelDisplay = LEVEL_DISPLAY[entry.level] ?? entry.level.toUpperCase().padEnd(5);
    const line = `[L:${entry.id}] ${entry.timestamp} ${levelDisplay} ${source} | ${flatMessage}\n`;

    if (this.ready && this.fd !== null) {
      const buf = Buffer.from(line);
      fs.writeSync(this.fd, buf);
    } else {
      this.writeBuffer.push(line);
    }

    this.bytesWritten += Buffer.byteLength(line);
    this.entryCount++;

    // Update level counts
    this.levelCounts[entry.level] = (this.levelCounts[entry.level] || 0) + 1;

    // Update clusters (in-memory, uses full stackTrace for source attribution)
    const key = entry.message.slice(0, CLUSTER_KEY_LENGTH);
    const existing = this.clusters.get(key);
    if (existing) {
      existing.count++;
      existing.lastId = entry.id;
    } else {
      this.clusters.set(key, {
        message: entry.message.slice(0, 200),
        count: 1,
        level: entry.level,
        firstId: entry.id,
        lastId: entry.id,
        sourceFile,
        sourceLine,
      });
    }

    return rich;
  }

  getFilePath(): string {
    return this.filePath;
  }

  getStats(): LogStats {
    return {
      file: this.filePath,
      totalEntries: this.entryCount,
      byLevel: { ...this.levelCounts },
      fileSizeBytes: this.bytesWritten,
    };
  }

  getClusters(limit = 20): MessageCluster[] {
    const sorted = [...this.clusters.values()].sort((a, b) => b.count - a.count);
    return sorted.slice(0, limit).map((c) => ({
      message: c.message,
      count: c.count,
      level: c.level,
      firstId: c.firstId,
      lastId: c.lastId,
      sourceFile: c.sourceFile,
      sourceLine: c.sourceLine,
    }));
  }

  readAll(): RichLogEntry[] {
    if (this.closed || !this.ready) return [];
    this.flushBuffer();
    try {
      const content = fs.readFileSync(this.filePath, "utf-8");
      return content
        .split("\n")
        .filter((line) => line.length > 0)
        .map(parseFlatLine)
        .filter((entry): entry is RichLogEntry => entry !== null);
    } catch {
      return [];
    }
  }

  readFiltered(opts: { level?: string; limit?: number }): {
    entries: RichLogEntry[];
    total: number;
  } {
    const all = this.readAll();
    let filtered = opts.level ? all.filter((e) => e.level === opts.level) : all;
    const total = filtered.length;
    if (opts.limit) {
      filtered = filtered.slice(-opts.limit);
    }
    return { entries: filtered, total };
  }

  /**
   * Flush and close the handle. `keepFile` leaves the log on disk: the caller
   * is shutting the writer down because the JS runtime died, and the entries
   * captured before it died are the reason a developer would look. Everything
   * kept this way is reclaimed by `pruneStaleLogs` on a later connect.
   */
  close(opts: { keepFile?: boolean } = {}): void {
    if (this.closed) return;
    this.closed = true;
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // ignore
      }
      this.fd = null;
    }
    if (opts.keepFile) return;
    try {
      fs.unlinkSync(this.filePath);
    } catch {
      // file may already be gone
    }
  }
}

const STALE_LOG_AGE_MS = 24 * 60 * 60 * 1000;
const LOG_NAME_RE = /^argent-logs-\d+-\d+\.log$/;

/**
 * Drop log files left behind by earlier sessions — the writer keeps its file
 * when the runtime dies, and a tool-server killed outright never closes its
 * writer at all, so without this the directory only grows. Age-based rather
 * than delete-all: several tool-servers can run at once, and 24h is far longer
 * than any debugger session, so a live writer's file is never a candidate.
 */
function pruneStaleLogs(dir: string): void {
  const cutoff = Date.now() - STALE_LOG_AGE_MS;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!LOG_NAME_RE.test(name)) continue;
    const full = path.join(dir, name);
    try {
      if (fs.statSync(full).mtimeMs >= cutoff) continue;
      fs.unlinkSync(full);
    } catch {
      // raced with another server, or not ours to remove
    }
  }
}

function cleanSourceUrl(url: string): string | null {
  try {
    const { pathname } = new URL(url);
    const clean = pathname.replace(/^\//, "");
    if (!SOURCE_EXT.test(clean)) return null;
    return clean;
  } catch {
    return null;
  }
}

function parseFlatLine(line: string): RichLogEntry | null {
  const match = LINE_RE.exec(line);
  if (!match) return null;
  const [, idStr, timestamp, levelRaw, , message] = match;
  const level = levelRaw.toLowerCase().trim();
  return {
    marker: `[L:${idStr}]`,
    id: parseInt(idStr, 10),
    timestamp,
    level,
    message,
    // stackTrace is not stored in the flat file
  };
}
