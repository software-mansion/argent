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
const STALE_LOG_MS = 24 * 60 * 60 * 1000;
const CLUSTER_KEY_LENGTH = 80;
const SOURCE_EXT = /\.(tsx?|jsx?|mjs|cjs)$/;

// [L:<id>] <timestamp> <LEVEL> <source> | <message>
const LINE_RE = /^\[L:(\d+)\] (\S+) (\S+)\s+(\S+) \| (.*)$/;
// CDP console types that lowercasing the uppercase LEVEL column cannot restore
const CAMEL_LEVELS = ["startGroup", "startGroupCollapsed", "endGroup", "profileEnd", "timeEnd"];

const liveLogFiles = new Set<string>();

export class LogFileWriter {
  private filePath: string;
  private fd: number | null = null;
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
    this.filePath = path.join(dir, `argent-logs-${port}-${timestamp}-p${process.pid}.log`);
    liveLogFiles.add(this.filePath);
    this.open();
  }

  private open(): void {
    try {
      this.fd = fs.openSync(this.filePath, "w");
      this.ready = true;
    } catch {
      // ignore
    }
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

    const sourceUrl = entry.stackTrace?.callFrames?.[0]?.url;
    const sourceLine = entry.stackTrace?.callFrames?.[0]?.lineNumber;
    const sourceFile = sourceUrl ? (cleanSourceUrl(sourceUrl) ?? undefined) : undefined;
    const source =
      sourceFile !== undefined && sourceLine !== undefined ? `${sourceFile}:${sourceLine}` : "-";

    // The flat format is one line per entry
    const flatMessage = entry.message.replace(/\n/g, " ");
    // Pad for alignment but never truncate: CDP types such as "warning" and
    // "assert" exceed 5 chars and must round-trip back through parseFlatLine.
    const levelDisplay = entry.level.toUpperCase().padEnd(5);
    const line = `[L:${entry.id}] ${entry.timestamp} ${levelDisplay} ${source} | ${flatMessage}\n`;

    // Nothing reopens the file, and readAll() serves it alone, so a line with
    // no file has no reader: the entry lives on only in the counts and clusters.
    if (this.ready && this.fd !== null) {
      const buf = Buffer.from(line);
      fs.writeSync(this.fd, buf);
    }

    this.bytesWritten += Buffer.byteLength(line);
    this.entryCount++;

    this.levelCounts[entry.level] = (this.levelCounts[entry.level] || 0) + 1;

    // Clusters are in-memory only, never persisted to the log file
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

  /** `keepFile` leaves the log to the sweep, 24h after the close. */
  close({ keepFile = false }: { keepFile?: boolean } = {}): void {
    if (this.closed) return;
    this.closed = true;
    liveLogFiles.delete(this.filePath);
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // ignore
      }
      this.fd = null;
    }
    if (keepFile) {
      try {
        const now = new Date();
        fs.utimesSync(this.filePath, now, now);
      } catch {
        // no file
      }
      return;
    }
    try {
      fs.unlinkSync(this.filePath);
    } catch {
      // file may already be gone
    }
  }
}

function pruneStaleLogs(dir: string): void {
  const cutoff = Date.now() - STALE_LOG_MS;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const pid = Number(/^argent-logs-.*-p(\d+)\.log$/.exec(name)?.[1]);
    if (!pid) continue;
    const file = path.join(dir, name);
    if (pid === process.pid ? liveLogFiles.has(file) : isAlive(pid)) continue;
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    } catch {
      // already gone
    }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
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
  const level = CAMEL_LEVELS.find((l) => l.toUpperCase() === levelRaw) ?? levelRaw.toLowerCase();
  return {
    marker: `[L:${idStr}]`,
    id: parseInt(idStr, 10),
    timestamp,
    level,
    message,
    // stackTrace is not stored in the flat file
  };
}
