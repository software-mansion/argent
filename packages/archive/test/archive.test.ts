import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import zlib from "node:zlib";
import {
  ARCHIVE_FORMATS,
  ArchiveError,
  archiveFormatsFromAccept,
  createArchiveFile,
  createTarArgs,
  pickArchiveFormat,
  safeExtractArchive,
  type ArchiveFormat,
} from "../src/index.js";

const execFileAsync = promisify(execFile);
let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "archive-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("createTarArgs", () => {
  it("archives the source's basename as the single top-level member", () => {
    expect(createTarArgs("/a/b/MyApp.app")).toEqual(["-cf", "-", "-C", "/a/b", "MyApp.app"]);
  });
});

describe("format negotiation", () => {
  it("prefers zstd and supports both formats", () => {
    expect(ARCHIVE_FORMATS).toEqual(["zstd", "gzip"]);
  });

  it("picks zstd only when the peer lists it", () => {
    expect(pickArchiveFormat(["gzip", "zstd"])).toBe("zstd");
    expect(pickArchiveFormat(["gzip"])).toBe("gzip");
    expect(pickArchiveFormat(["brotli"])).toBe("gzip");
    expect(pickArchiveFormat(undefined)).toBe("gzip");
  });

  it("reads formats from an Accept header by content type", () => {
    expect(archiveFormatsFromAccept("application/zstd, application/gzip")).toEqual([
      "zstd",
      "gzip",
    ]);
    expect(archiveFormatsFromAccept("Application/ZSTD;q=0.9")).toEqual(["zstd"]);
    expect(archiveFormatsFromAccept("*/*")).toEqual([]);
    expect(archiveFormatsFromAccept(undefined)).toEqual([]);
  });
});

const MAGIC: Record<ArchiveFormat, string> = { zstd: "28b52ffd", gzip: "1f8b" };

describe.each(ARCHIVE_FORMATS)("createArchiveFile (%s)", (format) => {
  it("writes the format's magic bytes", async () => {
    const src = path.join(tmpDir, "a.txt");
    await fs.writeFile(src, "x");
    const archivePath = path.join(tmpDir, "a.archive");
    await createArchiveFile(src, archivePath, format);
    const head = (await fs.readFile(archivePath)).subarray(0, 4).toString("hex");
    expect(head.startsWith(MAGIC[format])).toBe(true);
  });

  it("removes the partial archive when tar fails", async () => {
    const tarPath = path.join(tmpDir, "fail.archive");
    await expect(
      createArchiveFile(path.join(tmpDir, "does-not-exist"), tarPath, format)
    ).rejects.toThrow();
    await expect(fs.stat(tarPath)).rejects.toThrow();
  });
});

describe("safeExtractArchive input", () => {
  it("extracts a gzipped tar written by the system tar", async () => {
    await fs.mkdir(path.join(tmpDir, "Legacy.app"));
    await fs.writeFile(path.join(tmpDir, "Legacy.app", "Info.plist"), "<plist/>");
    const tarPath = path.join(tmpDir, "legacy.tar.gz");
    await execFileAsync("tar", ["-czf", tarPath, "-C", tmpDir, "Legacy.app"]);

    const dest = path.join(tmpDir, "dest-legacy");
    await fs.mkdir(dest);
    const member = await safeExtractArchive(tarPath, dest, "Legacy.app");
    expect(await fs.readFile(path.join(member, "Info.plist"), "utf8")).toBe("<plist/>");
  });

  it("rejects an uncompressed tar without extracting it", async () => {
    await fs.writeFile(path.join(tmpDir, "f"), "x");
    const tarPath = path.join(tmpDir, "plain.tar");
    await execFileAsync("tar", ["-cf", tarPath, "-C", tmpDir, "f"]);

    const dest = path.join(tmpDir, "dest-plain");
    await fs.mkdir(dest);
    await expect(safeExtractArchive(tarPath, dest, "f")).rejects.toThrow(
      "Could not read archive: unrecognized compression"
    );
    expect(await fs.readdir(dest)).toEqual([]);
  });

  it("rejects a truncated archive", async () => {
    const src = path.join(tmpDir, "big.bin");
    await fs.writeFile(src, Buffer.alloc(256 * 1024, 7));
    const archivePath = path.join(tmpDir, "big.archive");
    await createArchiveFile(src, archivePath, "zstd");
    const bytes = await fs.readFile(archivePath);
    await fs.writeFile(archivePath, bytes.subarray(0, bytes.length - 8));

    const dest = path.join(tmpDir, "dest-trunc");
    await fs.mkdir(dest);
    await expect(safeExtractArchive(archivePath, dest, "big.bin")).rejects.toBeInstanceOf(
      ArchiveError
    );
  });
});

describe("safeExtractArchive zstd framing", () => {
  // A tar of incompressible + compressible data, so the frame spans several
  // blocks of different types.
  async function plainTar(): Promise<Buffer> {
    const dir = path.join(tmpDir, "Bundle.app");
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "random.bin"), randomBytes(300 * 1024));
    await fs.writeFile(path.join(dir, "zeros.bin"), Buffer.alloc(300 * 1024));
    const tarPath = path.join(tmpDir, "bundle.tar");
    await execFileAsync("tar", ["-cf", tarPath, "-C", tmpDir, "Bundle.app"]);
    return fs.readFile(tarPath);
  }

  async function extract(bytes: Buffer): Promise<string> {
    const archivePath = path.join(tmpDir, "in.archive");
    await fs.writeFile(archivePath, bytes);
    const dest = await fs.mkdtemp(path.join(tmpDir, "dest-"));
    return safeExtractArchive(archivePath, dest, "Bundle.app");
  }

  it("rejects a frame cut at any point, before extracting anything", async () => {
    const frame = zlib.zstdCompressSync(await plainTar());
    const cuts = new Set<number>([1, 4, 5, 6, frame.length - 1, frame.length - 4]);
    for (let cut = 7; cut < frame.length; cut += 997) cuts.add(cut);
    for (const cut of cuts) {
      await expect(extract(frame.subarray(0, cut)), `cut at ${cut}`).rejects.toThrow(
        /^Could not read archive: (truncated zstd frame|unrecognized compression)$/
      );
    }
  });

  it("rejects a second frame carrying data", async () => {
    const tar = await plainTar();
    const bytes = Buffer.concat([zlib.zstdCompressSync(tar), zlib.zstdCompressSync(tar)]);
    await expect(extract(bytes)).rejects.toThrow("Could not read archive: multi-frame zstd");
  });

  it("accepts an empty trailing frame and a content checksum", async () => {
    const tar = await plainTar();
    const bytes = Buffer.concat([
      zlib.zstdCompressSync(tar, { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }),
      zlib.zstdCompressSync(Buffer.alloc(0)),
    ]);
    const member = await extract(bytes);
    expect((await fs.readFile(path.join(member, "zeros.bin"))).length).toBe(300 * 1024);
  });
});

describe.each(ARCHIVE_FORMATS)(
  "createArchiveFile + safeExtractArchive round-trip (%s)",
  (format) => {
    async function extractInto(tarPath: string, expected: string): Promise<string> {
      const dest = path.join(tmpDir, `dest-${expected}`);
      await fs.mkdir(dest, { recursive: true });
      return safeExtractArchive(tarPath, dest, expected);
    }

    it("tars a directory and extracts it back to its basename", async () => {
      const appDir = path.join(tmpDir, "MyApp.app");
      await fs.mkdir(appDir);
      await fs.writeFile(path.join(appDir, "Info.plist"), "<plist/>");
      const tarPath = path.join(tmpDir, "dir.tar.gz");
      await createArchiveFile(appDir, tarPath, format);

      const member = await extractInto(tarPath, "MyApp.app");
      expect(path.basename(member)).toBe("MyApp.app");
      expect(await fs.readFile(path.join(member, "Info.plist"), "utf8")).toBe("<plist/>");
    });

    it("tars a single file and extracts it back", async () => {
      const apk = path.join(tmpDir, "app.apk");
      await fs.writeFile(apk, "apk-bytes");
      const tarPath = path.join(tmpDir, "file.tar.gz");
      await createArchiveFile(apk, tarPath, format);

      const member = await extractInto(tarPath, "app.apk");
      expect(await fs.readFile(member, "utf8")).toBe("apk-bytes");
    });
  }
);

describe.each(ARCHIVE_FORMATS)("safeExtractArchive hardening (%s)", (format) => {
  it("rejects an archive with an escaping (absolute) member path", async () => {
    const abs = path.join(tmpDir, "innocent.txt");
    await fs.writeFile(abs, "x");
    const tarPath = path.join(tmpDir, "slip.tar.gz");
    // -P keeps the absolute member name (portable across GNU and bsd tar); an
    // absolute path escapes the extract dir and must be rejected before extraction.
    await execFileAsync("tar", ["-c", "-z", "-P", "-f", tarPath, abs]);

    const dest = path.join(tmpDir, "dest");
    await fs.mkdir(dest);
    await expect(safeExtractArchive(tarPath, dest, "innocent.txt")).rejects.toBeInstanceOf(
      ArchiveError
    );
  });

  it("rejects an empty archive", async () => {
    const tarPath = path.join(tmpDir, "empty.tar.gz");
    await execFileAsync("tar", ["-czf", tarPath, "-T", "/dev/null"]);
    const dest = path.join(tmpDir, "dest");
    await fs.mkdir(dest);
    await expect(safeExtractArchive(tarPath, dest, "whatever")).rejects.toBeInstanceOf(
      ArchiveError
    );
  });

  it("rejects a symlink whose target escapes the extract dir", async () => {
    const src = path.join(tmpDir, "bundle");
    await fs.mkdir(src);
    await fs.symlink("/etc/passwd", path.join(src, "escape")); // absolute → escapes
    const tarPath = path.join(tmpDir, "evil.tar.gz");
    await createArchiveFile(src, tarPath, format);

    const dest = path.join(tmpDir, "dest-escape");
    await fs.mkdir(dest);
    await expect(safeExtractArchive(tarPath, dest, "bundle")).rejects.toBeInstanceOf(ArchiveError);
  });

  it("allows an internal symlink (e.g. a .app-style relative link)", async () => {
    const app = path.join(tmpDir, "MyApp.app");
    await fs.mkdir(app);
    await fs.writeFile(path.join(app, "A"), "real");
    await fs.symlink("A", path.join(app, "Current")); // relative, stays inside
    const tarPath = path.join(tmpDir, "app.tar.gz");
    await createArchiveFile(app, tarPath, format);

    const dest = path.join(tmpDir, "dest-internal");
    await fs.mkdir(dest);
    const member = await safeExtractArchive(tarPath, dest, "MyApp.app");
    expect(path.basename(member)).toBe("MyApp.app");
    expect(await fs.readlink(path.join(member, "Current"))).toBe("A");
  });

  it("rejects a symlink whose name contains ' -> ' (parser-confusion bypass)", async () => {
    const src = path.join(tmpDir, "cfgbundle");
    await fs.mkdir(src);
    // Symlink NAME embeds " -> " while the real target is an absolute escape;
    // a naive first-` -> ` parse would read "safe" and wave it through.
    await fs.symlink("/etc/passwd", path.join(src, "inner -> safe"));
    const tarPath = path.join(tmpDir, "confuse.tar.gz");
    await createArchiveFile(src, tarPath, format);

    const dest = path.join(tmpDir, "dest-confuse");
    await fs.mkdir(dest);
    await expect(safeExtractArchive(tarPath, dest, "cfgbundle")).rejects.toBeInstanceOf(
      ArchiveError
    );
  });

  it("rejects a hardlink member", async () => {
    const src = path.join(tmpDir, "hlbundle");
    await fs.mkdir(src);
    await fs.writeFile(path.join(src, "real"), "data");
    await fs.link(path.join(src, "real"), path.join(src, "hard")); // hardlink
    const tarPath = path.join(tmpDir, "hard.tar.gz");
    await createArchiveFile(src, tarPath, format);

    const dest = path.join(tmpDir, "dest-hard");
    await fs.mkdir(dest);
    await expect(safeExtractArchive(tarPath, dest, "hlbundle")).rejects.toBeInstanceOf(
      ArchiveError
    );
  });

  it("errors instead of guessing when the member can't be identified", async () => {
    // Two top-level entries, neither matching the expected name → ambiguous.
    await fs.mkdir(path.join(tmpDir, "one"));
    await fs.mkdir(path.join(tmpDir, "two"));
    const tarPath = path.join(tmpDir, "multi.tar.gz");
    await execFileAsync("tar", ["-czf", tarPath, "-C", tmpDir, "one", "two"]);

    const dest = path.join(tmpDir, "dest-multi");
    await fs.mkdir(dest);
    await expect(safeExtractArchive(tarPath, dest, "expected.app")).rejects.toBeInstanceOf(
      ArchiveError
    );
  });
});
