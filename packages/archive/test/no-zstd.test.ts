import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ARCHIVE_FORMATS, safeExtractArchive } from "../src/index.js";

// A runtime without zstd in zlib, as Node 23.0-23.7 is.
vi.mock("node:zlib", async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof import("node:zlib") }>();
  const zlib: Partial<typeof actual.default> = { ...actual.default };
  delete zlib.createZstdCompress;
  delete zlib.createZstdDecompress;
  return { default: zlib };
});

describe("without zstd in zlib", () => {
  it("offers gzip only", () => {
    expect(ARCHIVE_FORMATS).toEqual(["gzip"]);
  });

  it("refuses a zstd archive as unrecognized", async () => {
    const { zstdCompressSync } = await vi.importActual<typeof import("node:zlib")>("node:zlib");
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "archive-no-zstd-"));
    try {
      const archivePath = path.join(tmpDir, "in.archive");
      await fs.writeFile(archivePath, zstdCompressSync(Buffer.alloc(10240)));
      await expect(safeExtractArchive(archivePath, tmpDir, "Bundle.app")).rejects.toThrow(
        /^Could not read archive: unrecognized compression$/
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
