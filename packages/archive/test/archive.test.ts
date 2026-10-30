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
  trackTarEnd,
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
    expect(archiveFormatsFromAccept("application/gzip")).toEqual(["gzip"]);
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

describe("createArchiveFile (zstd)", () => {
  it("writes a checksum, so extraction reports corruption", async () => {
    const dir = path.join(tmpDir, "C.app");
    await fs.mkdir(dir);
    // Incompressible, so the payload is stored verbatim and only a checksum
    // notices a flipped byte.
    await fs.writeFile(path.join(dir, "random.bin"), randomBytes(4 * 1024 * 1024));
    const archivePath = path.join(tmpDir, "c.archive");
    await createArchiveFile(dir, archivePath, "zstd");
    const bytes = await fs.readFile(archivePath);
    bytes[bytes.length >> 1] ^= 1;
    await fs.writeFile(archivePath, bytes);
    await expect(
      safeExtractArchive(archivePath, await fs.mkdtemp(path.join(tmpDir, "dest-")), "C.app")
    ).rejects.toThrow(/checksum|corruption/);
  });
});

describe("trackTarEnd", () => {
  async function zeroFileTar(): Promise<{ tar: Buffer; dataEnd: number }> {
    // Data that ends in 8 KiB of zeros, behind a marker byte that locates it.
    await fs.writeFile(
      path.join(tmpDir, "z.bin"),
      Buffer.concat([Buffer.from("x"), Buffer.alloc(8191)])
    );
    const tarPath = path.join(tmpDir, "z.tar");
    await execFileAsync("tar", ["-cf", tarPath, "-C", tmpDir, "z.bin"]);
    const tar = await fs.readFile(tarPath);
    let dataStart = 0;
    while (tar[dataStart] !== 0x78 || tar.subarray(dataStart + 1, dataStart + 512).some((b) => b)) {
      dataStart += 512;
    }
    return { tar, dataEnd: dataStart + 8192 };
  }

  function ended(bytes: Buffer, chunkSize = bytes.length): boolean {
    const tracker = trackTarEnd();
    for (let i = 0; i < bytes.length; i += chunkSize)
      tracker.push(bytes.subarray(i, i + chunkSize));
    return tracker.ended();
  }

  it("needs both zero blocks where a header is due", async () => {
    const { tar, dataEnd } = await zeroFileTar();
    expect(ended(tar)).toBe(true);
    expect(ended(tar.subarray(0, dataEnd))).toBe(false);
    expect(ended(tar.subarray(0, dataEnd + 512))).toBe(false);
    expect(ended(tar.subarray(0, dataEnd + 1024))).toBe(true);
  });

  it("follows headers split across chunks", async () => {
    const { tar, dataEnd } = await zeroFileTar();
    expect(ended(tar, 7)).toBe(true);
    expect(ended(tar.subarray(0, dataEnd), 7)).toBe(false);
  });

  it("skips the sparse-map blocks of a GNU sparse member", () => {
    const header = Buffer.alloc(512);
    header.write("sparse", 0);
    header.write("00000001000\0", 124); // 512 bytes of data
    header[156] = 0x53; // 'S'
    header[482] = 1; // a sparse-map block follows
    const map = Buffer.alloc(512);
    map.write("00000000000\0", 0); // one region; byte 504 is 0, so the last block
    const tar = Buffer.concat([header, map, Buffer.alloc(512), Buffer.alloc(1024)]);
    expect(ended(tar.subarray(0, 512 * 3))).toBe(false);
    expect(ended(tar.subarray(0, 512 * 4))).toBe(false);
    expect(ended(tar)).toBe(true);
  });

  it("reads a base-256 size field", () => {
    const header = Buffer.alloc(512);
    header.write("big", 0);
    header[124] = 0x80;
    header.writeUInt32BE(1024, 132);
    const tar = Buffer.concat([
      header,
      Buffer.alloc(1024),
      Buffer.alloc(512, 1),
      Buffer.alloc(1024),
    ]);
    expect(ended(tar.subarray(0, 512 + 1024 + 512))).toBe(false);
    expect(ended(tar)).toBe(true);
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

  it("rejects a complete frame around a cut tar", async () => {
    const cut = (await plainTar()).subarray(0, 3072);
    const bytes = zlib.zstdCompressSync(cut, {
      params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
    });
    await expect(extract(bytes)).rejects.toThrow(
      /^Could not read archive: tar -t exited with code [1-9]/
    );
  });

  // One raw block (RFC 8878 §3.1.1.2) behind a header with the given field sizes.
  function rawFrame(
    content: Buffer,
    singleSegment: 0 | 1,
    fcsFlag: number,
    dictFlag: number
  ): Buffer {
    const fcs = Buffer.alloc([singleSegment, 2, 4, 8][fcsFlag]!);
    if (fcs.length === 2) fcs.writeUInt16LE(content.length - 256);
    else if (fcs.length > 0) fcs.writeUIntLE(content.length, 0, Math.min(fcs.length, 6));
    const block = Buffer.alloc(3);
    block.writeUIntLE(1 | (content.length << 3), 0, 3);
    return Buffer.concat([
      Buffer.from([0x28, 0xb5, 0x2f, 0xfd, (fcsFlag << 6) | (singleSegment << 5) | dictFlag]),
      Buffer.from(singleSegment ? [] : [0x50]), // window descriptor: 1 MiB
      Buffer.alloc([0, 1, 2, 4][dictFlag]!), // dictionary id 0: none
      fcs,
      block,
      content,
    ]);
  }

  it.each([
    [0, 0, 0],
    [0, 0, 1],
    [0, 0, 2],
    [0, 0, 3],
    [0, 1, 0],
    [0, 2, 0],
    [0, 3, 0],
    [1, 1, 0],
    [1, 2, 0],
    [1, 3, 0],
  ] as const)(
    "walks a header (single segment %i, content size flag %i, dictionary flag %i)",
    async (single, fcsFlag, dictFlag) => {
      const dir = path.join(tmpDir, "Bundle.app");
      await fs.mkdir(dir);
      await fs.writeFile(path.join(dir, "f.txt"), "raw");
      const tarPath = path.join(tmpDir, "small.tar");
      await execFileAsync("tar", ["-cf", tarPath, "-C", tmpDir, "Bundle.app"]);
      const member = await extract(rawFrame(await fs.readFile(tarPath), single, fcsFlag, dictFlag));
      expect(await fs.readFile(path.join(member, "f.txt"), "utf8")).toBe("raw");
    }
  );

  it("rejects a second frame carrying data", async () => {
    const tar = await plainTar();
    const bytes = Buffer.concat([zlib.zstdCompressSync(tar), zlib.zstdCompressSync(tar)]);
    await expect(extract(bytes)).rejects.toThrow("Could not read archive: multi-frame zstd");
  });

  it("rejects a data frame after an empty one", async () => {
    const tar = await plainTar();
    const bytes = Buffer.concat([
      zlib.zstdCompressSync(Buffer.alloc(0)),
      zlib.zstdCompressSync(tar),
    ]);
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

  it("extracts a frame whose data runs on past the tar's end-of-archive marker", async () => {
    // tar stops reading at the marker, closing its stdin while data is still due.
    const tar = Buffer.concat([await plainTar(), Buffer.alloc(20 << 20)]);
    const member = await extract(zlib.zstdCompressSync(tar));
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

    it("extracts a bundle whose member listing passes 1 MiB", async () => {
      let deep = path.join(tmpDir, "Big.app");
      for (const c of "abcd") deep = path.join(deep, c.repeat(200));
      await fs.mkdir(deep, { recursive: true });
      for (let i = 0; i < 1300; i++)
        await fs.writeFile(path.join(deep, `${i}`.padStart(40, "f")), "");
      const tarPath = path.join(tmpDir, "big.archive");
      await createArchiveFile(path.join(tmpDir, "Big.app"), tarPath, format);

      const member = await extractInto(tarPath, "Big.app");
      expect(
        await fs.readdir(
          path.join(member, "a".repeat(200), ...["b", "c", "d"].map((c) => c.repeat(200)))
        )
      ).toHaveLength(1300);
    }, 30_000);
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
