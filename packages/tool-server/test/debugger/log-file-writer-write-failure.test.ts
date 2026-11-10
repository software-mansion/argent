import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import { LogFileWriter } from "../../src/utils/debugger/log-file-writer";
import { scopeTempHome } from "../helpers/temp-home";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeSync: vi.fn(actual.writeSync),
    ftruncateSync: vi.fn(actual.ftruncateSync),
  };
});

scopeTempHome("argent-log-write-failure-home-");

const entry = (id: number) => ({
  id,
  timestamp: new Date(1710000000000).toISOString(),
  level: "error",
  message: "boom",
});

/** A file-size limit or a full disk: a write falls short, then each one throws. */
describe("LogFileWriter past a file-size limit or on a full disk", () => {
  let w: LogFileWriter;
  afterEach(() => {
    w.close();
    vi.mocked(fs.writeSync).mockReset();
    vi.mocked(fs.ftruncateSync).mockReset();
  });

  /** Stores the first `keep(length)` bytes of the next line, as a file-size limit does. */
  async function tearNextWrite(keep: (length: number) => number) {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(fs.writeSync).mockImplementationOnce(((
      fd: number,
      buf: Buffer,
      _offset?: number,
      _length?: number,
      position?: number | null
    ) => {
      const kept = keep(buf.length);
      return actual.writeSync(fd, buf.subarray(0, kept), 0, kept, position ?? null);
    }) as typeof fs.writeSync);
  }

  it("drops a short write's bytes from the file and its size", async () => {
    w = new LogFileWriter(59241);
    w.write(entry(0));
    const whole = fs.statSync(w.getFilePath()).size;
    await tearNextWrite(() => 7);
    w.write(entry(1));
    expect(fs.statSync(w.getFilePath()).size).toBe(whole);
    expect(w.getStats().fileSizeBytes).toBe(whole);
  });

  it("counts an entry as in the file only when its whole line was written", () => {
    w = new LogFileWriter(59243);
    w.write(entry(0));
    vi.mocked(fs.writeSync).mockReturnValueOnce(7);
    w.write(entry(1));
    expect(w.getStats().totalEntries).toBe(2);
    expect(w.getFileEntryCount()).toBe(1);
  });

  it("holds only the counted entries when a line tears inside its message", async () => {
    w = new LogFileWriter(59245);
    w.write(entry(0));
    await tearNextWrite((length) => length - 3);
    w.write(entry(1));
    w.write(entry(2));
    const read = w.readAll();
    expect(read.map((e) => e.id)).toEqual([0, 2]);
    expect(read).toHaveLength(w.getFileEntryCount());
    expect(read.map((e) => e.message)).toEqual(["boom", "boom"]);
    expect(fs.readFileSync(w.getFilePath(), "utf-8").split("\n")).toHaveLength(3);
    expect(w.getStats().fileSizeBytes).toBe(fs.statSync(w.getFilePath()).size);
  });

  it("starts the first entry written after a torn line it cannot remove on its own line", async () => {
    w = new LogFileWriter(59244);
    w.write(entry(0));
    await tearNextWrite(() => 7);
    vi.mocked(fs.ftruncateSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("EIO: i/o error, ftruncate"), { code: "EIO" });
    });
    vi.mocked(fs.writeSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("ENOSPC: no space left on device, write"), {
        code: "ENOSPC",
      });
    });
    w.write(entry(1));
    w.write(entry(2));
    w.write(entry(3));
    w.write(entry(4));
    const lines = fs.readFileSync(w.getFilePath(), "utf-8").split("\n");
    expect(lines.map((l) => l.slice(0, 7))).toEqual([
      "[L:0] 2",
      "[L:1] 2",
      "[L:3] 2",
      "[L:4] 2",
      "",
    ]);
    expect(w.readAll().map((e) => e.id)).toEqual([0, 3, 4]);
    expect(w.getFileEntryCount()).toBe(3);
    expect(w.getStats().fileSizeBytes).toBe(fs.statSync(w.getFilePath()).size);
  });

  it("keeps counting and clustering the entries it can no longer store", () => {
    w = new LogFileWriter(59242);
    vi.mocked(fs.writeSync).mockImplementation(() => {
      throw Object.assign(new Error("EFBIG: file too large, write"), { code: "EFBIG" });
    });
    expect(w.write(entry(0)).marker).toBe("[L:0]");
    w.write(entry(1));
    const stats = w.getStats();
    expect(stats.totalEntries).toBe(2);
    expect(stats.byLevel).toEqual({ error: 2 });
    expect(stats.fileSizeBytes).toBe(0);
    expect(w.getClusters()[0]).toMatchObject({ message: "boom", count: 2, firstId: 0, lastId: 1 });
  });
});
