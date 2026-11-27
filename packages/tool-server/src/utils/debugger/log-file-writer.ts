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

export interface RecentLogEntry {
  id: number;
  timestamp: string;
  level: string;
  message: string;
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
export const RECENT_PER_LEVEL = 100;
const RECENT_MESSAGE_CHARS = 300;

const liveLogFiles = new Set<string>();
// Two sessions on one Metro can start within the same millisecond.
let lastTimestamp = 0;

export class LogFileWriter {
  private filePath: string;
  private fd: number | null = null;
  private bytesWritten = 0;
  private entryCount = 0;
  private fileEntryCount = 0;
  private midLine = false;
  private levelCounts: Record<string, number> = {};
  private clusters = new Map<string, ClusterState>();
  private recent = new Map<string, RecentLogEntry[]>();
  private ready = false;
  private closed = false;

  constructor(port: number) {
    const timestamp = (lastTimestamp = Math.max(Date.now(), lastTimestamp + 1));
    const dir = path.join(os.homedir(), ".argent", "tmp");
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // Unwritable ~/.argent: open() fails too and the writer runs fileless.
    }
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

    // One line per entry: [L:<id>] <timestamp> <LEVEL> <source> | <message>
    const flatMessage = entry.message.replace(/\n/g, " ");
    // Pad for alignment but never truncate: CDP types such as "warning" and
    // "assert" exceed 5 chars, and a grep for the full level must find them.
    const levelDisplay = entry.level.toUpperCase().padEnd(5);
    const line = `[L:${entry.id}] ${entry.timestamp} ${levelDisplay} ${source} | ${flatMessage}\n`;

    // Nothing reopens the file, so a line with no open file is lost: the entry
    // survives only in memory (counts, clusters, getRecent).
    if (this.ready && this.fd !== null) {
      try {
        const bytes = Buffer.from(this.midLine ? `\n${line}` : line);
        // Positional, so a truncate below never leaves the fd offset past EOF.
        // Short of the whole line at a file-size limit or on a full disk.
        const written = fs.writeSync(this.fd, bytes, 0, bytes.length, this.bytesWritten);
        if (written === bytes.length) {
          this.bytesWritten += written;
          this.midLine = false;
          this.fileEntryCount++;
        } else {
          this.dropTornLine(this.fd, bytes, written);
        }
      } catch {
        // Past that limit it throws, and the entry is left to the counts and clusters.
      }
    }

    this.entryCount++;

    this.levelCounts[entry.level] = (this.levelCounts[entry.level] || 0) + 1;
    this.remember(entry);

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

  private remember(entry: Omit<RichLogEntry, "marker">): void {
    const ring = this.recent.get(entry.level) ?? [];
    ring.push({
      id: entry.id,
      timestamp: entry.timestamp,
      level: entry.level,
      message: cutMessage(entry.message),
    });
    if (ring.length > RECENT_PER_LEVEL) ring.shift();
    this.recent.set(entry.level, ring);
  }

  /** The newest `limit` entries, oldest first. Exact only up to RECENT_PER_LEVEL. */
  getRecent(limit: number, levels?: readonly string[]): RecentLogEntry[] {
    const wanted = levels ? new Set(levels) : null;
    const pool = [...this.recent]
      .filter(([level]) => !wanted || wanted.has(level))
      .flatMap(([, ring]) => ring);
    return pool.sort((a, b) => a.id - b.id).slice(-limit);
  }

  /** A torn line past " | " would parse as a whole entry with its message cut. */
  private dropTornLine(fd: number, bytes: Buffer, written: number): void {
    try {
      fs.ftruncateSync(fd, this.bytesWritten);
    } catch {
      // The torn line stays, so the next line must not continue it.
      this.bytesWritten += written;
      if (written > 0) this.midLine = bytes[written - 1] !== 0x0a; // "\n"
    }
  }

  getFilePath(): string {
    return this.filePath;
  }

  /** Entries whose whole line reached the file; `totalEntries` also counts the rest. */
  getFileEntryCount(): number {
    return this.fileEntryCount;
  }

  hasFile(): boolean {
    return fs.existsSync(this.filePath);
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

function cutMessage(message: string): string {
  if (message.length <= RECENT_MESSAGE_CHARS) return message;
  let end = RECENT_MESSAGE_CHARS - 1;
  if (isHighSurrogate(message.charCodeAt(end - 1))) end--;
  return detachedCopy(message.slice(0, end)) + "…";
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** A `slice` can keep the whole original string alive; a byte copy holds only the cut. */
function detachedCopy(text: string): string {
  return Buffer.from(text, "utf16le").toString("utf16le");
}
