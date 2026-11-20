import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { promisify } from "node:util";
import zlib from "node:zlib";
import {
  ARCHIVE_FORMATS,
  ArchiveError,
  archiveFormatsFromAccept,
  createArchiveFile,
  createCompressor,
  createTarArgs,
  isContainedPath,
  pickArchiveFormat,
  safeExtractArchive,
  tarEnv,
  type ArchiveFormat,
} from "../src/index.js";

const execFileAsync = promisify(execFile);

// Absolute, so a `tar` shim on PATH can exec it without finding itself.
const gnuTar = ["gtar", "tar"]
  .map((bin) => {
    try {
      const resolved = execFileSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" }).trim();
      return execFileSync(resolved, ["--version"], { encoding: "utf8" }).includes("GNU tar")
        ? resolved
        : undefined;
    } catch {
      return undefined;
    }
  })
  .find(Boolean);

function compress(tar: Buffer, format: ArchiveFormat): Buffer {
  return format === "zstd" ? zlib.zstdCompressSync(tar) : zlib.gzipSync(tar);
}

function ustarHeader(name: string, type: string, size: number): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0);
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  h.write("00000000000\0", 136);
  h.write(type, 156);
  h.write("ustar\u000000", 257);
  h.fill(" ", 148, 156);
  const sum = h.reduce((a, b) => a + b, 0);
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return h;
}

/** A tar of empty files whose names (set by pax headers) can pass PATH_MAX. */
function paxTar(names: string[]): Buffer {
  const parts: Buffer[] = [];
  for (const name of names) {
    const body = ` path=${name}\n`;
    let len = body.length + 1;
    while (`${len}`.length + body.length !== len) len = `${len}`.length + body.length;
    const record = Buffer.from(`${len}${body}`);
    parts.push(ustarHeader("PaxHeader", "x", record.length), record);
    parts.push(Buffer.alloc((512 - (record.length % 512)) % 512), ustarHeader("f", "0", 0));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

let tmpDir: string;
const realPath = process.env.PATH;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "archive-test-"));
});

afterEach(async () => {
  process.env.PATH = realPath;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Put a `tar` running `script` first on PATH. */
async function tarOnPath(script: string): Promise<void> {
  const bin = await fs.mkdtemp(path.join(tmpDir, "bin-"));
  await fs.writeFile(path.join(bin, "tar"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${realPath}`;
}

// Lists and extracts `Bundle.app/` without reading its stdin.
const UNREADING_TAR = [
  'case "$1" in',
  "  -t) echo Bundle.app/ ;;",
  '  -tv) echo "drwxr-xr-x  0 u g 0 Jan  1 00:00 Bundle.app/" ;;',
  '  -x) mkdir "$3/Bundle.app" ;;',
  "esac",
].join("\n");

/** `mib` MiB of zeros in RLE blocks of 128 KiB, ending in a wrong checksum. */
function zerosWithBadChecksum(mib: number): Buffer {
  const blocks = mib * 8;
  const frame = Buffer.alloc(6 + blocks * 4 + 4);
  frame.writeUInt32LE(0xfd2fb528, 0);
  frame[4] = 1 << 2; // content checksum
  frame[5] = 7 << 3; // 128 KiB window
  for (let i = 0; i < blocks; i++) {
    frame.writeUIntLE(((128 << 10) << 3) | (1 << 1) | +(i === blocks - 1), 6 + i * 4, 3);
  }
  return frame;
}

describe("createTarArgs", () => {
  it("archives the source's basename as the single top-level member", () => {
    expect(createTarArgs("/a/b/MyApp.app")).toEqual(["-cf", "-", "-C", "/a/b", "MyApp.app"]);
  });

  // `./` would archive the whole disk.
  it("leaves the root's empty name for tar to refuse", () => {
    expect(createTarArgs("/")).toEqual(["-cf", "-", "-C", "/", ""]);
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

  it("reads an Accept header by whole content types and their q-values", () => {
    // `q=0` says the sender cannot read the type.
    expect(archiveFormatsFromAccept("application/gzip, application/zstd;q=0")).toEqual(["gzip"]);
    expect(archiveFormatsFromAccept("Application/ZSTD; q=0.5")).toEqual(
      ARCHIVE_FORMATS.filter((f) => f === "zstd")
    );
    expect(archiveFormatsFromAccept("application/zstd-compressed, text/gzip")).toEqual([]);
  });
});

describe("the locale tar runs in", () => {
  it("leaves a UTF-8 locale as it is", () => {
    // An older Linux has no C.UTF-8: forced there, tar would fall to the C
    // locale although the host's own UTF-8 locale works.
    for (const env of [
      { LANG: "en_US.UTF-8" },
      { LANG: "C", LC_CTYPE: "ja_JP.utf8" },
      { LANG: "C", LC_ALL: "en_US.UTF-8" },
    ]) {
      expect(tarEnv(env)).toBe(env);
    }
  });

  it("sets a UTF-8 locale where the character type is not UTF-8", () => {
    for (const env of [{}, { LANG: "C" }, { LANG: "en_US.UTF-8", LC_ALL: "C" }, { LC_ALL: "" }]) {
      expect(tarEnv(env).LC_ALL).toMatch(/UTF-8$/);
    }
    // The variables tar needs besides the locale stay.
    expect(tarEnv({ PATH: "/usr/bin" }).PATH).toBe("/usr/bin");
  });
});

describe("a path inside the extract directory", () => {
  it("refuses an absolute path, a drive path and a `..` segment on every receiver", () => {
    for (const windows of [true, false]) {
      for (const unsafe of ["/etc", "\\Windows", "C:/Windows", "C:\\Windows", "a/../b", ".."]) {
        expect(isContainedPath(unsafe, windows), unsafe).toBe(false);
      }
      expect(isContainedPath("Bundle.app/a..b/c", windows)).toBe(true);
    }
  });

  it("reads a drive with no separator as a path only on a Windows receiver", () => {
    // `C:x` is a path on drive C to Windows. Elsewhere it is a file name:
    // macOS stores the Finder name `A/B.app` as `A:B.app`.
    for (const name of ["C:x", "A:B.app", "C:escaped"]) {
      expect(isContainedPath(name, true), name).toBe(false);
      expect(isContainedPath(name, false), name).toBe(true);
    }
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

  // bsdtar reads `-C<dir>` and `@<archive>` among the names after `--`.
  it.each(["-v.apk", "-Cdir.apk", "@list.apk"])("archives a source named %s", async (name) => {
    const src = path.join(tmpDir, name);
    await fs.writeFile(src, "apk");
    const archivePath = path.join(tmpDir, "named.archive");
    await createArchiveFile(src, archivePath, format);
    const dest = await fs.mkdtemp(path.join(tmpDir, "dest-"));
    expect(await fs.readFile(await safeExtractArchive(archivePath, dest, name), "utf8")).toBe(
      "apk"
    );
  });

  it("rejects with the abort reason and leaves no archive when aborted before archiving", async () => {
    const src = path.join(tmpDir, "a.txt");
    await fs.writeFile(src, "x");
    const archivePath = path.join(tmpDir, "aborted.archive");
    const reason = new Error("gave up");
    await expect(
      createArchiveFile(src, archivePath, format, AbortSignal.abort(reason))
    ).rejects.toBe(reason);
    await expect(fs.stat(archivePath)).rejects.toThrow();
  });

  it.skipIf(!existsSync("/dev/full"))("reports a failed write over tar's exit", async () => {
    const src = path.join(tmpDir, "random.bin");
    await fs.writeFile(src, randomBytes(1 << 20));
    const archivePath = path.join(tmpDir, "full.archive");
    await fs.symlink("/dev/full", archivePath);
    await expect(createArchiveFile(src, archivePath, format)).rejects.toMatchObject({
      code: "ENOSPC",
    });
  });

  describe("with a stand-in tar", () => {
    let src: string;
    beforeEach(async () => {
      src = path.join(tmpDir, "a.txt");
      await fs.writeFile(src, "x");
    });

    it("stops tar and removes the archive when aborted while archiving", async () => {
      await tarOnPath("head -c 4096 /dev/zero\nexec sleep 30");
      const archivePath = path.join(tmpDir, "aborted.archive");
      const started = performance.now();
      await expect(
        createArchiveFile(src, archivePath, format, AbortSignal.timeout(200))
      ).rejects.toMatchObject({ name: "TimeoutError" });
      expect(performance.now() - started).toBeLessThan(5_000);
      await expect(fs.stat(archivePath)).rejects.toThrow();
    });

    it("fails without starting tar when the archive can't be created", async () => {
      const ran = path.join(tmpDir, "ran");
      await tarOnPath(`touch "${ran}"`);
      await expect(
        createArchiveFile(src, path.join(tmpDir, "missing", "a.archive"), format)
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(existsSync(ran)).toBe(false);
    });

    // GNU tar prints a line per unreadable member and goes on.
    it("keeps a bounded error", async () => {
      await tarOnPath('yes "tar: x: Cannot open: Permission denied" | head -c 1000000 >&2\nexit 2');
      const err: Error = await createArchiveFile(src, path.join(tmpDir, "l.archive"), format).then(
        () => new Error("archived"),
        (e: Error) => e
      );
      expect(err.message).toMatch(/^tar exited with code 2: tar: x: Cannot open/);
      expect(err.message.length).toBeLessThan(20_000);
      expect(err.message.endsWith("…")).toBe(true);
    });
  });
});

describe("safeExtractArchive input", () => {
  it("rejects with the original reason before extraction", async () => {
    const reason = new Error("cancelled");
    await expect(
      safeExtractArchive(
        path.join(tmpDir, "missing"),
        tmpDir,
        "Bundle.app",
        AbortSignal.abort(reason)
      )
    ).rejects.toBe(reason);
    await expect(fs.stat(path.join(tmpDir, "Bundle.app"))).rejects.toThrow();
  });

  it.each(["-t", "-tv"])(
    "stops tar on %s without starting -x or removing an existing member",
    async (pass) => {
      const archivePath = path.join(tmpDir, "small.archive");
      await fs.writeFile(archivePath, compress(Buffer.alloc(10240), "zstd"));
      const dest = await fs.mkdtemp(path.join(tmpDir, "dest-"));
      await fs.mkdir(path.join(dest, "Bundle.app"));
      await fs.writeFile(path.join(dest, "Bundle.app", "cached"), "keep");
      const listed = path.join(tmpDir, "listed");
      const extracted = path.join(tmpDir, "extracted");
      await tarOnPath(
        [
          `[ "$1" = -x ] && touch "${extracted}"`,
          `if [ "$1" = ${pass} ]; then touch "${listed}"; exec sleep 30; fi`,
          UNREADING_TAR,
        ].join("\n")
      );
      const started = performance.now();
      await expect(
        safeExtractArchive(archivePath, dest, "Bundle.app", AbortSignal.timeout(300))
      ).rejects.toMatchObject({ name: "TimeoutError" });
      expect(performance.now() - started).toBeLessThan(5_000);
      expect(existsSync(listed)).toBe(true);
      expect(existsSync(extracted)).toBe(false);
      expect(await fs.readFile(path.join(dest, "Bundle.app", "cached"), "utf8")).toBe("keep");
    }
  );

  it("waits for tar to close before rejecting an interrupted extraction", async () => {
    const archivePath = path.join(tmpDir, "small.archive");
    await fs.writeFile(archivePath, compress(Buffer.alloc(10240), "gzip"));
    const ready = path.join(tmpDir, "extracting");
    const stopped = path.join(tmpDir, "stopped");
    await tarOnPath(
      [
        UNREADING_TAR,
        'if [ "$1" = -x ]; then',
        `  trap 'sleep 0.2; touch "${stopped}"; exit 0' TERM`,
        `  touch "${ready}"`,
        "  while :; do sleep 0.05; done",
        "fi",
      ].join("\n")
    );

    const controller = new AbortController();
    const reason = new Error("cancelled during extraction");
    const extraction = safeExtractArchive(archivePath, tmpDir, "Bundle.app", controller.signal);
    try {
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true));
    } finally {
      controller.abort(reason);
      await expect(extraction).rejects.toBe(reason);
    }
    expect(existsSync(stopped)).toBe(true);
  });

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

  it("rejects a listing past 32 MiB, stopping before extraction", async () => {
    const names = Array.from({ length: 4400 }, (_, i) => `Big.app/${"a".repeat(8000)}${i}`);
    const archivePath = path.join(tmpDir, "long.archive");
    await fs.writeFile(archivePath, compress(paxTar(names), "zstd"));
    const dest = await fs.mkdtemp(path.join(tmpDir, "dest-"));
    await expect(safeExtractArchive(archivePath, dest, "Big.app")).rejects.toThrow(
      "Could not read archive: tar -t listed more than 262144 members or 32 MiB"
    );
    expect(await fs.readdir(dest)).toEqual([]);
  });

  it("accepts a listing of exactly 262144 members and 32 MiB", async () => {
    const archivePath = path.join(tmpDir, "small.archive");
    await fs.writeFile(archivePath, compress(Buffer.alloc(10240), "zstd"));
    // 128-byte lines.
    await tarOnPath(
      UNREADING_TAR.replace(
        "echo Bundle.app/",
        `yes "Bundle.app/${"f".repeat(116)}" | head -n 262144`
      )
    );
    expect(path.basename(await safeExtractArchive(archivePath, tmpDir, "Bundle.app"))).toBe(
      "Bundle.app"
    );
  });

  it("applies the limits to the verbose listing too", async () => {
    const archivePath = path.join(tmpDir, "small.archive");
    await fs.writeFile(archivePath, compress(Buffer.alloc(10240), "zstd"));
    await tarOnPath(
      UNREADING_TAR.replace(/echo "drwx.*"/, `yes "${"d".repeat(127)}" | head -n 262145`)
    );
    await expect(safeExtractArchive(archivePath, tmpDir, "Bundle.app")).rejects.toThrow(
      "Could not read archive: tar -tv listed more than 262144 members or 32 MiB"
    );
  });

  // Killing tar leaves the rest to decode, up to the bad checksum.
  it("reports a listing past the limit over the decoding it cut short", async () => {
    const archivePath = path.join(tmpDir, "bad.archive");
    await fs.writeFile(archivePath, zerosWithBadChecksum(1));
    await tarOnPath("yes Bundle.app/f | head -n 262145");
    await expect(safeExtractArchive(archivePath, tmpDir, "Bundle.app")).rejects.toThrow(
      "Could not read archive: tar -t listed more than 262144 members or 32 MiB"
    );
  });

  // A listing of 3.4 MB, under the byte limit; without the kill, the second
  // would list forever.
  it.each([
    ["262144 members", "yes Bundle.app/f | head -n 262145"],
    ["32 MiB", `exec yes "Bundle.app/${"f".repeat(300)}"`],
  ])("stops tar once its listing passes %s", async (_, script) => {
    const archivePath = path.join(tmpDir, "small.archive");
    await fs.writeFile(archivePath, compress(Buffer.alloc(10240), "zstd"));
    await tarOnPath(script);
    await expect(safeExtractArchive(archivePath, tmpDir, "Bundle.app")).rejects.toThrow(
      "Could not read archive: tar -t listed more than 262144 members or 32 MiB"
    );
  });

  it("keeps a bounded error when every member fails to extract", async () => {
    // A name component past NAME_MAX (255) can't be created.
    const names = Array.from({ length: 1000 }, (_, i) => `Bundle.app/${"n".repeat(300)}${i}`);
    const archivePath = path.join(tmpDir, "unextractable.archive");
    await fs.writeFile(archivePath, compress(paxTar(names), "zstd"));
    const dest = await fs.mkdtemp(path.join(tmpDir, "dest-"));
    const err: Error = await safeExtractArchive(archivePath, dest, "Bundle.app").then(
      () => new Error("extracted"),
      (e: Error) => e
    );
    expect(err.message).toMatch(/^tar -x -C .* exited with code [1-9]/);
    expect(err.message.length).toBeLessThan(20_000);
    expect(err.message.endsWith("…")).toBe(true);
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

describe.each(ARCHIVE_FORMATS)("safeExtractArchive integrity (%s)", (format) => {
  it("rejects a flipped payload byte by the format's checksum", async () => {
    const dir = path.join(tmpDir, "C.app");
    await fs.mkdir(dir);
    // Incompressible, so the payload is stored verbatim and only a checksum
    // notices a flipped byte.
    await fs.writeFile(path.join(dir, "random.bin"), randomBytes(4 * 1024 * 1024));
    const archivePath = path.join(tmpDir, "c.archive");
    await createArchiveFile(dir, archivePath, format);
    const bytes = await fs.readFile(archivePath);
    bytes[bytes.length >> 1] ^= 1;
    await fs.writeFile(archivePath, bytes);
    await expect(
      safeExtractArchive(archivePath, await fs.mkdtemp(path.join(tmpDir, "dest-")), "C.app")
    ).rejects.toThrow(/doesn't match checksum|incorrect data check/);
  });

  it("rejects a flipped payload byte when tar exits without reading", async () => {
    const dir = path.join(tmpDir, "C.app");
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "random.bin"), randomBytes(4 * 1024 * 1024));
    const archivePath = path.join(tmpDir, "c.archive");
    await createArchiveFile(dir, archivePath, format);
    const bytes = await fs.readFile(archivePath);
    bytes[bytes.length >> 1] ^= 1;
    await fs.writeFile(archivePath, bytes);
    await tarOnPath(UNREADING_TAR);
    await expect(
      safeExtractArchive(archivePath, await fs.mkdtemp(path.join(tmpDir, "dest-")), "Bundle.app")
    ).rejects.toThrow(/doesn't match checksum|incorrect data check/);
  });
});

// bsdtar's `tar -czf -`, which older tool-servers stream, pads the gzip data
// with zeros to whole 10240-byte records.
describe.each([
  ["the system tar", undefined],
  ["GNU tar", gnuTar],
])("safeExtractArchive of zero-padded gzip with %s", (_, tarBin) => {
  it.skipIf(tarBin === undefined && _ === "GNU tar")("extracts it", async () => {
    await fs.mkdir(path.join(tmpDir, "P.app"));
    await fs.writeFile(path.join(tmpDir, "P.app", "f"), "padded");
    const tar = await execFileAsync("tar", ["-cf", "-", "-C", tmpDir, "P.app"], {
      encoding: "buffer",
    });
    const archivePath = path.join(tmpDir, "padded.tar.gz");
    await fs.writeFile(archivePath, Buffer.concat([zlib.gzipSync(tar.stdout), Buffer.alloc(9000)]));
    if (tarBin) await tarOnPath(`exec "${tarBin}" "$@"`);
    const dest = await fs.mkdtemp(path.join(tmpDir, "dest-"));
    const member = await safeExtractArchive(archivePath, dest, "P.app");
    expect(await fs.readFile(path.join(member, "f"), "utf8")).toBe("padded");
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

  it("walks a frame of a million one-byte blocks quickly", { timeout: 4_000 }, async () => {
    const n = 1_000_000;
    const blocks = Buffer.alloc(n * 4);
    for (let i = 0; i < n; i++) {
      // RLE block of size 1; the last one ends the frame.
      blocks.writeUIntLE((1 << 3) | (1 << 1) | (i === n - 1 ? 1 : 0), i * 4, 3);
    }
    const header = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x58]);
    await expect(extract(Buffer.concat([header, blocks]))).rejects.toThrow(ArchiveError);
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

  it("rejects bytes after the frame that aren't a frame", async () => {
    const bytes = Buffer.concat([
      zlib.zstdCompressSync(await plainTar()),
      Buffer.from("JUNKJUNK!"),
    ]);
    await expect(extract(bytes)).rejects.toThrow("Could not read archive: bad zstd frame");
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

  describe("when tar closes its stdin before the data ends", () => {
    async function longArchive(): Promise<Buffer> {
      return zlib.zstdCompressSync(Buffer.concat([await plainTar(), Buffer.alloc(20 << 20)]));
    }

    it("extracts when tar exits without reading", async () => {
      const bytes = await longArchive();
      await tarOnPath(UNREADING_TAR);
      expect(path.basename(await extract(bytes))).toBe("Bundle.app");
    });

    it("decodes no more than 16 MiB that tar didn't read", async () => {
      await tarOnPath(UNREADING_TAR);
      // Decoding up to the checksum would fail.
      expect(path.basename(await extract(zerosWithBadChecksum(20)))).toBe("Bundle.app");
    });

    it("holds decoded data back while tar isn't reading", async () => {
      // 256 MiB of zeros, compressed a MiB at a time.
      const zeros = Buffer.alloc(1 << 20);
      const frame = await buffer(
        Readable.from(Array(256).fill(zeros)).pipe(createCompressor("zstd"))
      );
      await tarOnPath(`[ "$1" = -t ] && sleep 1\n${UNREADING_TAR}`);
      const before = process.memoryUsage().arrayBuffers;
      let peak = 0;
      const sampler = setInterval(() => {
        peak = Math.max(peak, process.memoryUsage().arrayBuffers - before);
      }, 5);
      try {
        await extract(frame);
      } finally {
        clearInterval(sampler);
      }
      expect(peak).toBeLessThan(64 << 20);
    });

    it.runIf(gnuTar)(
      "extracts with GNU tar, which reads only up to the marker",
      async () => {
        const bytes = await longArchive();
        await tarOnPath(`exec "${gnuTar}" "$@"`);
        // Whether the closed pipe surfaces as EPIPE or ENOTCONN (macOS) is a race.
        for (let i = 0; i < 30; i++) await extract(bytes);
      },
      60_000
    );
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
  /** `tar -c <args>`, compressed in `format`, at `archivePath`. */
  async function writeTar(archivePath: string, args: string[]): Promise<void> {
    const { stdout } = await execFileAsync("tar", ["-cf", "-", ...args], { encoding: "buffer" });
    await fs.writeFile(archivePath, compress(stdout, format));
  }

  it("rejects an archive with an escaping (absolute) member path", async () => {
    const abs = path.join(tmpDir, "innocent.txt");
    await fs.writeFile(abs, "x");
    const tarPath = path.join(tmpDir, "slip.archive");
    // -P keeps the absolute member name (portable across GNU and bsd tar); an
    // absolute path escapes the extract dir and must be rejected before extraction.
    await writeTar(tarPath, ["-P", abs]);

    const dest = path.join(tmpDir, "dest");
    await fs.mkdir(dest);
    await expect(safeExtractArchive(tarPath, dest, "innocent.txt")).rejects.toThrow(
      `Archive contains an unsafe path "${abs}"`
    );
    expect(await fs.readdir(dest)).toEqual([]);
  });

  it("rejects an empty archive", async () => {
    const tarPath = path.join(tmpDir, "empty.archive");
    await writeTar(tarPath, ["-T", "/dev/null"]);
    const dest = path.join(tmpDir, "dest");
    await fs.mkdir(dest);
    await expect(safeExtractArchive(tarPath, dest, "whatever")).rejects.toThrow(
      "Archive is empty."
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
    await fs.symlink("A..B", path.join(app, "Dotted")); // `..` inside a name isn't a segment
    const tarPath = path.join(tmpDir, "app.tar.gz");
    await createArchiveFile(app, tarPath, format);

    const dest = path.join(tmpDir, "dest-internal");
    await fs.mkdir(dest);
    const member = await safeExtractArchive(tarPath, dest, "MyApp.app");
    expect(path.basename(member)).toBe("MyApp.app");
    expect(await fs.readlink(path.join(member, "Current"))).toBe("A");
    expect(await fs.readlink(path.join(member, "Dotted"))).toBe("A..B");
  });

  // `a/../../escaped` normalizes to `escaped`; `./././` is the extract dir.
  it.each(["../escaped", "Bundle.app/a/../../escaped", "C:/escaped", "./././"])(
    "rejects a member named %s before extracting anything",
    async (name) => {
      const tar = Buffer.concat([
        ustarHeader("Bundle.app/", "5", 0),
        ustarHeader("Bundle.app/ok", "0", 0),
        ustarHeader(name, name.endsWith("/") ? "5" : "0", 0),
        Buffer.alloc(1024),
      ]);
      const archivePath = path.join(tmpDir, "slip.archive");
      await fs.writeFile(archivePath, compress(tar, format));
      const dest = await fs.mkdtemp(path.join(tmpDir, "dest-"));
      await expect(safeExtractArchive(archivePath, dest, "Bundle.app")).rejects.toThrow(
        "Archive contains an unsafe path"
      );
      expect(await fs.readdir(dest)).toEqual([]);
    }
  );

  // Absolute or outside the bundle on a Windows receiver.
  it.each(["..\\..\\Windows", "C:\\Windows", "\\Windows"])(
    "rejects a symlink to %s",
    async (target) => {
      const src = path.join(tmpDir, "winlink");
      await fs.mkdir(src);
      await fs.symlink(target, path.join(src, "l"));
      const tarPath = path.join(tmpDir, "winlink.archive");
      await createArchiveFile(src, tarPath, format);

      const dest = await fs.mkdtemp(path.join(tmpDir, "dest-"));
      await expect(safeExtractArchive(tarPath, dest, "winlink")).rejects.toThrow(
        "Archive contains a symlink whose target could not be confirmed safe"
      );
    }
  );

  it.skipIf(process.platform === "win32")(
    "extracts a bundle whose name starts with a letter and a colon",
    async () => {
      const app = path.join(tmpDir, "A:B.app");
      await fs.mkdir(app);
      await fs.writeFile(path.join(app, "f"), "x");
      await fs.symlink("C:x", path.join(app, "l"));
      const tarPath = path.join(tmpDir, "colon.archive");
      await createArchiveFile(app, tarPath, format);

      const dest = await fs.mkdtemp(path.join(tmpDir, "dest-"));
      const member = await safeExtractArchive(tarPath, dest, "A:B.app");
      // bsdtar extracts the bundle as `B.app`: it drops what it reads as a
      // drive letter from a member's name. GNU tar keeps the name.
      expect(path.basename(member)).toMatch(/^(A:)?B\.app$/);
      expect(await fs.readFile(path.join(member, "f"), "utf8")).toBe("x");
      expect(await fs.readlink(path.join(member, "l"))).toBe("C:x");
    }
  );

  it("extracts a bundle whose name tar escapes outside a UTF-8 locale", async () => {
    const app = path.join(tmpDir, "日記.app");
    await fs.mkdir(app);
    await fs.writeFile(path.join(app, "f"), "x");
    const tarPath = path.join(tmpDir, "cjk.archive");
    await createArchiveFile(app, tarPath, format);
    const locale = process.env.LC_ALL;
    process.env.LC_ALL = "C";
    try {
      const dest = await fs.mkdtemp(path.join(tmpDir, "dest-"));
      expect(path.basename(await safeExtractArchive(tarPath, dest, "日記.app"))).toBe("日記.app");
    } finally {
      if (locale === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = locale;
    }
  });

  it("rejects a fifo member", async () => {
    const src = path.join(tmpDir, "fifobundle");
    await fs.mkdir(src);
    execFileSync("mkfifo", [path.join(src, "Info.plist")]);
    const tarPath = path.join(tmpDir, "fifo.archive");
    await createArchiveFile(src, tarPath, format);

    const dest = await fs.mkdtemp(path.join(tmpDir, "dest-"));
    await expect(safeExtractArchive(tarPath, dest, "fifobundle")).rejects.toThrow(
      'Archive contains an unsupported member type "p"'
    );
  });

  // Each target normalizes to `.`, but `b` resolves to the extract dir and `c` above it.
  it("rejects a chain of symlinks that climbs out through '..'", async () => {
    const src = path.join(tmpDir, "chain");
    await fs.mkdir(src);
    await fs.symlink(".", path.join(src, "a"));
    await fs.symlink("a/..", path.join(src, "b"));
    await fs.symlink("b/..", path.join(src, "c"));
    const tarPath = path.join(tmpDir, "chain.archive");
    await createArchiveFile(src, tarPath, format);

    const dest = await fs.mkdtemp(path.join(tmpDir, "dest-"));
    await expect(safeExtractArchive(tarPath, dest, "chain")).rejects.toThrow(
      "Archive contains a symlink whose target could not be confirmed safe"
    );
    expect(await fs.readdir(dest)).toEqual([]);
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

  it("rejects a symlink whose target contains ' -> '", async () => {
    const src = path.join(tmpDir, "arrowtarget");
    await fs.mkdir(src);
    // Read after the last ` -> `, the target would be `x`.
    await fs.symlink("/tmp/ -> x", path.join(src, "l"));
    const tarPath = path.join(tmpDir, "arrowtarget.archive");
    await createArchiveFile(src, tarPath, format);

    const dest = await fs.mkdtemp(path.join(tmpDir, "dest-"));
    await expect(safeExtractArchive(tarPath, dest, "arrowtarget")).rejects.toThrow(
      "Archive contains a symlink whose target could not be confirmed safe"
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
    const tarPath = path.join(tmpDir, "multi.archive");
    await writeTar(tarPath, ["-C", tmpDir, "one", "two"]);

    const dest = path.join(tmpDir, "dest-multi");
    await fs.mkdir(dest);
    await expect(safeExtractArchive(tarPath, dest, "expected.app")).rejects.toBeInstanceOf(
      ArchiveError
    );
  });
});
