import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface RichLogEntry {
  marker: string;
  id: number;
  timestamp: string;
  level: string;
  message: string;
  args: Array<{ type: string; value?: unknown; description?: string }>;
  stackTrace?: {
    callFrames: Array<{
      functionName: string;
      scriptId: string;
      url: string;
      lineNumber: number;
      columnNumber: number;
    }>;
  };
  byteOffset: number;
}

export interface MessageCluster {
  message: string;
  count: number;
  level: string;
  firstId: number;
  lastId: number;
  grepPattern: string;
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
    this.filePath = path.join(
      os.tmpdir(),
      `argent-logs-${port}-${timestamp}.jsonl`,
    );
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

  write(entry: Omit<RichLogEntry, "marker" | "byteOffset">): RichLogEntry {
    if (this.closed) throw new Error("LogFileWriter is closed");
    if (this.entryCount >= MAX_ENTRIES) {
      // Safety valve: stop writing but keep stats
      return { ...entry, marker: `[L:${entry.id}]`, byteOffset: -1 };
    }

    const rich: RichLogEntry = {
      ...entry,
      marker: `[L:${entry.id}]`,
      byteOffset: this.bytesWritten,
    };

    const line = JSON.stringify(rich) + "\n";

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

    // Update clusters
    const key = entry.message.slice(0, CLUSTER_KEY_LENGTH);
    const existing = this.clusters.get(key);
    if (existing) {
      existing.count++;
      existing.lastId = entry.id;
    } else {
      const sourceFile = entry.stackTrace?.callFrames?.[0]?.url;
      const sourceLine = entry.stackTrace?.callFrames?.[0]?.lineNumber;
      this.clusters.set(key, {
        message: entry.message.slice(0, 200),
        count: 1,
        level: entry.level,
        firstId: entry.id,
        lastId: entry.id,
        sourceFile: sourceFile ? cleanSourceUrl(sourceFile) : undefined,
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
    const sorted = [...this.clusters.values()].sort(
      (a, b) => b.count - a.count,
    );
    return sorted.slice(0, limit).map((c) => ({
      message: c.message,
      count: c.count,
      level: c.level,
      firstId: c.firstId,
      lastId: c.lastId,
      grepPattern: escapeGrepPattern(c.message.slice(0, 60)),
      sourceFile: c.sourceFile,
      sourceLine: c.sourceLine,
    }));
  }

  readAll(): RichLogEntry[] {
    if (this.closed || !this.ready) return [];
    // Flush pending writes first
    this.flushBuffer();
    try {
      const content = fs.readFileSync(this.filePath, "utf-8");
      return content
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as RichLogEntry);
    } catch {
      return [];
    }
  }

  readFiltered(opts: {
    level?: string;
    limit?: number;
  }): { entries: RichLogEntry[]; total: number } {
    const all = this.readAll();
    let filtered = opts.level
      ? all.filter((e) => e.level === opts.level)
      : all;
    const total = filtered.length;
    if (opts.limit) {
      filtered = filtered.slice(-opts.limit);
    }
    return { entries: filtered, total };
  }

  close(): void {
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
    try {
      fs.unlinkSync(this.filePath);
    } catch {
      // file may already be gone
    }
  }
}

function cleanSourceUrl(url: string): string {
  // Strip bundler prefix, keep relative path
  const match = url.match(/\/([^/]+\/[^?]+)/);
  return match ? match[1] : url;
}

function escapeGrepPattern(str: string): string {
  // Escape regex special chars for use in grep
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
