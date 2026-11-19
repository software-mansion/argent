import { EventEmitter } from "node:events";
import { readdirSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import zlib from "node:zlib";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createArchiveFile, safeExtractArchive } from "../src/index.js";

const spawnFailure = vi.hoisted(() => ({ throws: false }));

// spawn out of file descriptors: no stdio streams, and `error` on the next tick.
// Other errors, like EBADF under fd pressure on macOS, throw.
vi.mock("node:child_process", () => ({
  spawn: () => {
    if (spawnFailure.throws) throw Object.assign(new Error("spawn EBADF"), { code: "EBADF" });
    const child = new EventEmitter();
    const err = Object.assign(new Error("spawn tar EMFILE"), { code: "EMFILE" });
    process.nextTick(() => child.emit("error", err));
    return child;
  },
}));

const openFds = () => readdirSync("/dev/fd").length;

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "archive-emfile-"));
});
afterEach(async () => {
  spawnFailure.throws = false;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("when spawn fails", () => {
  it.each([
    ["with EMFILE", false, "spawn tar EMFILE"],
    ["by throwing", true, "spawn EBADF"],
  ])(
    "createArchiveFile %s rejects, closing and removing the archive",
    async (_, throws, message) => {
      spawnFailure.throws = throws;
      const archivePath = path.join(tmpDir, "a.archive");
      const fds = openFds();
      for (let i = 0; i < 5; i++) {
        await expect(createArchiveFile(tmpDir, archivePath, "gzip")).rejects.toThrow(message);
      }
      await expect(fs.stat(archivePath)).rejects.toThrow();
      await vi.waitFor(() => expect(openFds()).toBe(fds));
    }
  );

  it("safeExtractArchive with EMFILE rejects with the spawn error", async () => {
    const archivePath = path.join(tmpDir, "a.archive");
    await fs.writeFile(archivePath, zlib.gzipSync(Buffer.alloc(10240)));
    await expect(safeExtractArchive(archivePath, tmpDir, "Bundle.app")).rejects.toThrow(
      "Could not read archive: spawn tar EMFILE"
    );
  });
});
