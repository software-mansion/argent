import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  ArchiveError,
  createTarGzArgs,
  createTarGzFile,
  safeExtractTarGz,
} from "../src/index.js";

const execFileAsync = promisify(execFile);
let tmpDir: string;

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
  it("rejects an archive containing a tar-slip path", async () => {
    await fs.writeFile(path.join(tmpDir, "innocent.txt"), "x");
    const tarPath = path.join(tmpDir, "slip.tar.gz");
    // bsdtar `-s ,^,../../,` rewrites each member to escape the extract dir.
    await execFileAsync("tar", ["-czf", tarPath, "-s", ",^,../../,", "-C", tmpDir, "innocent.txt"]);

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
});
