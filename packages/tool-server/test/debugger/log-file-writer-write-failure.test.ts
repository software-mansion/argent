import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import { LogFileWriter } from "../../src/utils/debugger/log-file-writer";
import { scopeTempHome } from "../helpers/temp-home";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, writeSync: vi.fn(actual.writeSync) };
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
  });

  it("counts only the bytes a short write stored", () => {
    w = new LogFileWriter(59241);
    vi.mocked(fs.writeSync).mockReturnValueOnce(7);
    w.write(entry(0));
    expect(w.getStats().fileSizeBytes).toBe(7);
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
