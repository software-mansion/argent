import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { deflateRawSync, gzipSync } from "node:zlib";
import {
  ArchiveError,
  createTarGzArgs,
  createTarGzFile,
  extractZipArchive,
  safeExtractTarGz,
  safeExtractTarGzArchive,
} from "../src/index.js";

const execFileAsync = promisify(execFile);
let tmpDir: string;

interface TestZipEntry {
  name: string;
  data: Buffer;
  mode?: number;
  declaredSize?: number;
}

function makeTestZip(entries: TestZipEntry[]): Buffer {
  const localRecords: Buffer[] = [];
  const centralRecords: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.data);
    const declaredSize = entry.declaredSize ?? entry.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(declaredSize, 22);
    local.writeUInt16LE(name.length, 26);
    localRecords.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(declaredSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100644) * 0x10000) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralRecords.push(central, name);
    localOffset += local.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralRecords);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localRecords, centralDirectory, eocd]);
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "archive-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("createTarGzArgs", () => {
  it("archives the source's basename as the single top-level member", () => {
    expect(createTarGzArgs("/a/b/MyApp.app", "-")).toEqual([
      "-czf",
      "-",
      "-C",
      "/a/b",
      "MyApp.app",
    ]);
  });
});

describe("createTarGzFile", () => {
  it("removes the partial archive when tar fails", async () => {
    const tarPath = path.join(tmpDir, "fail.tar.gz");
    await expect(createTarGzFile(path.join(tmpDir, "does-not-exist"), tarPath)).rejects.toThrow();
    await expect(fs.stat(tarPath)).rejects.toThrow();
  });
});

describe("createTarGzFile + safeExtractTarGz round-trip", () => {
  async function extractInto(tarPath: string, expected: string): Promise<string> {
    const dest = path.join(tmpDir, `dest-${expected}`);
    await fs.mkdir(dest, { recursive: true });
    return safeExtractTarGz(tarPath, dest, expected);
  }

  it("tars a directory and extracts it back to its basename", async () => {
    const appDir = path.join(tmpDir, "MyApp.app");
    await fs.mkdir(appDir);
    await fs.writeFile(path.join(appDir, "Info.plist"), "<plist/>");
    const tarPath = path.join(tmpDir, "dir.tar.gz");
    await createTarGzFile(appDir, tarPath);

    const member = await extractInto(tarPath, "MyApp.app");
    expect(path.basename(member)).toBe("MyApp.app");
    expect(await fs.readFile(path.join(member, "Info.plist"), "utf8")).toBe("<plist/>");
  });

  it("tars a single file and extracts it back", async () => {
    const apk = path.join(tmpDir, "app.apk");
    await fs.writeFile(apk, "apk-bytes");
    const tarPath = path.join(tmpDir, "file.tar.gz");
    await createTarGzFile(apk, tarPath);

    const member = await extractInto(tarPath, "app.apk");
    expect(await fs.readFile(member, "utf8")).toBe("apk-bytes");
  });
});

describe("safeExtractTarGz hardening", () => {
  it("rejects the actual gzip output when it exceeds the configured limit", async () => {
    const tarPath = path.join(tmpDir, "bomb.tar.gz");
    await fs.writeFile(tarPath, gzipSync(Buffer.alloc(8 * 1024)));
    const dest = path.join(tmpDir, "dest-bomb");
    await fs.mkdir(dest);

    await expect(
      safeExtractTarGzArchive(tarPath, dest, { maxUncompressedBytes: 1024 })
    ).rejects.toThrow(/safety limit/i);
  });

  it("rejects an archive with an escaping (absolute) member path", async () => {
    const abs = path.join(tmpDir, "innocent.txt");
    await fs.writeFile(abs, "x");
    const tarPath = path.join(tmpDir, "slip.tar.gz");
    // -P keeps the absolute member name (portable across GNU and bsd tar); an
    // absolute path escapes the extract dir and must be rejected before extraction.
    await execFileAsync("tar", ["-c", "-z", "-P", "-f", tarPath, abs]);

    const dest = path.join(tmpDir, "dest");
    await fs.mkdir(dest);
    await expect(safeExtractTarGz(tarPath, dest, "innocent.txt")).rejects.toBeInstanceOf(
      ArchiveError
    );
  });

  it("rejects an empty archive", async () => {
    const tarPath = path.join(tmpDir, "empty.tar.gz");
    await execFileAsync("tar", ["-czf", tarPath, "-T", "/dev/null"]);
    const dest = path.join(tmpDir, "dest");
    await fs.mkdir(dest);
    await expect(safeExtractTarGz(tarPath, dest, "whatever")).rejects.toBeInstanceOf(ArchiveError);
  });

  it("rejects a symlink whose target escapes the extract dir", async () => {
    const src = path.join(tmpDir, "bundle");
    await fs.mkdir(src);
    await fs.symlink("/etc/passwd", path.join(src, "escape")); // absolute → escapes
    const tarPath = path.join(tmpDir, "evil.tar.gz");
    await createTarGzFile(src, tarPath);

    const dest = path.join(tmpDir, "dest-escape");
    await fs.mkdir(dest);
    await expect(safeExtractTarGz(tarPath, dest, "bundle")).rejects.toBeInstanceOf(ArchiveError);
  });

  it("allows an internal symlink (e.g. a .app-style relative link)", async () => {
    const app = path.join(tmpDir, "MyApp.app");
    await fs.mkdir(app);
    await fs.writeFile(path.join(app, "A"), "real");
    await fs.symlink("A", path.join(app, "Current")); // relative, stays inside
    const tarPath = path.join(tmpDir, "app.tar.gz");
    await createTarGzFile(app, tarPath);

    const dest = path.join(tmpDir, "dest-internal");
    await fs.mkdir(dest);
    const member = await safeExtractTarGz(tarPath, dest, "MyApp.app");
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
    await createTarGzFile(src, tarPath);

    const dest = path.join(tmpDir, "dest-confuse");
    await fs.mkdir(dest);
    await expect(safeExtractTarGz(tarPath, dest, "cfgbundle")).rejects.toBeInstanceOf(ArchiveError);
  });

  it("rejects a hardlink member", async () => {
    const src = path.join(tmpDir, "hlbundle");
    await fs.mkdir(src);
    await fs.writeFile(path.join(src, "real"), "data");
    await fs.link(path.join(src, "real"), path.join(src, "hard")); // hardlink
    const tarPath = path.join(tmpDir, "hard.tar.gz");
    await createTarGzFile(src, tarPath);

    const dest = path.join(tmpDir, "dest-hard");
    await fs.mkdir(dest);
    await expect(safeExtractTarGz(tarPath, dest, "hlbundle")).rejects.toBeInstanceOf(ArchiveError);
  });

  it("errors instead of guessing when the member can't be identified", async () => {
    // Two top-level entries, neither matching the expected name → ambiguous.
    await fs.mkdir(path.join(tmpDir, "one"));
    await fs.mkdir(path.join(tmpDir, "two"));
    const tarPath = path.join(tmpDir, "multi.tar.gz");
    await execFileAsync("tar", ["-czf", tarPath, "-C", tmpDir, "one", "two"]);

    const dest = path.join(tmpDir, "dest-multi");
    await fs.mkdir(dest);
    await expect(safeExtractTarGz(tarPath, dest, "expected.app")).rejects.toBeInstanceOf(
      ArchiveError
    );
  });

  it("can safely extract a multi-entry archive without selecting one member", async () => {
    await fs.writeFile(path.join(tmpDir, "app.apk"), "apk");
    await fs.writeFile(path.join(tmpDir, "output-metadata.json"), "{}");
    const tarPath = path.join(tmpDir, "gradle.tar.gz");
    await execFileAsync("tar", ["-czf", tarPath, "-C", tmpDir, "app.apk", "output-metadata.json"]);
    const dest = path.join(tmpDir, "dest-gradle");
    await fs.mkdir(dest);

    await safeExtractTarGzArchive(tarPath, dest, { maxUncompressedBytes: 1024 * 1024 });
    await expect(fs.readFile(path.join(dest, "app.apk"), "utf8")).resolves.toBe("apk");
    await expect(fs.readFile(path.join(dest, "output-metadata.json"), "utf8")).resolves.toBe("{}");
  });
});

describe("safe ZIP extraction", () => {
  it("bounds inflateRaw using the declared entry size", async () => {
    const zipPath = path.join(tmpDir, "lying-size.zip");
    await fs.writeFile(
      zipPath,
      makeTestZip([{ name: "payload.bin", data: Buffer.alloc(1024 * 1024), declaredSize: 1 }])
    );
    const dest = path.join(tmpDir, "dest-zip-bomb");
    await fs.mkdir(dest);

    await expect(extractZipArchive(zipPath, dest)).rejects.toBeInstanceOf(ArchiveError);
  });

  it("rejects entries nested below another archive-controlled symlink", async () => {
    const zipPath = path.join(tmpDir, "symlink-chain.zip");
    await fs.writeFile(
      zipPath,
      makeTestZip([
        // If `link -> .` is created first, writing `link/child` actually writes
        // at the extraction root. Its `../outside` target then escapes even
        // though a lexical check against `<root>/link/child` appears contained.
        { name: "link", data: Buffer.from("."), mode: 0o120777 },
        { name: "link/child", data: Buffer.from("../outside"), mode: 0o120777 },
      ])
    );
    const dest = path.join(tmpDir, "dest-symlink-chain");
    await fs.mkdir(dest);

    await expect(extractZipArchive(zipPath, dest)).rejects.toThrow(/nested below/i);
  });
});
