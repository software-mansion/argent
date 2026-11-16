import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import zlib from "node:zlib";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createArchiveFile, safeExtractArchive } from "../src/index.js";

// spawn out of file descriptors: no stdio streams, and `error` on the next tick.
vi.mock("node:child_process", () => ({
  spawn: () => {
    const child = new EventEmitter();
    const err = Object.assign(new Error("spawn tar EMFILE"), { code: "EMFILE" });
    process.nextTick(() => child.emit("error", err));
    return child;
  },
}));

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "archive-emfile-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("when spawn runs out of file descriptors", () => {
  it("createArchiveFile rejects with the spawn error", async () => {
    const archivePath = path.join(tmpDir, "a.archive");
    await expect(createArchiveFile(tmpDir, archivePath, "gzip")).rejects.toThrow(
      "spawn tar EMFILE"
    );
    await expect(fs.stat(archivePath)).rejects.toThrow();
  });

  it("safeExtractArchive rejects with the spawn error", async () => {
    const archivePath = path.join(tmpDir, "a.archive");
    await fs.writeFile(archivePath, zlib.gzipSync(Buffer.alloc(10240)));
    await expect(safeExtractArchive(archivePath, tmpDir, "Bundle.app")).rejects.toThrow(
      "Could not read archive: spawn tar EMFILE"
    );
  });
});
