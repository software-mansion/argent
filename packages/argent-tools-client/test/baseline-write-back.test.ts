import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applyClientFileDirectives, CLIENT_FILE_MARKER } from "../src/file-inputs.js";

// The rename that puts a new baseline in place is the last step of a write.
// It runs for real unless a test makes it fail.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

let tmpDir: string;
let keyDir: string;
let baseline: string;

beforeEach(async () => {
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "baseline-write-back-")));
  // The run's baseline directory, beside its root flow; not created yet.
  keyDir = path.join(tmpDir, ".argent", "flows", "__baselines__", "login");
  baseline = path.join(keyDir, "home__ios-390x844.png");
  await fs.mkdir(path.dirname(path.dirname(keyDir)), { recursive: true });
});

afterEach(async () => {
  vi.mocked(fs.rename).mockClear();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function directive(file: string, bytes: Buffer) {
  return {
    [CLIENT_FILE_MARKER]: true,
    path: file,
    content: bytes.toString("base64"),
    encoding: "base64",
  };
}

async function writeBack(file: string, bytes = Buffer.from("new"), allowedDirs = [keyDir]) {
  return applyClientFileDirectives({ baselineWrites: [directive(file, bytes)] }, { allowedDirs });
}

describe("a baseline the result returns", () => {
  it("is written into the call's baseline directory, which it creates, and rewritten to its path", async () => {
    const applied = await writeBack(baseline, Buffer.from([0, 1, 2, 255]));

    expect(applied).toEqual({
      result: { baselineWrites: [baseline] },
      written: [baseline],
      failed: [],
    });
    expect(await fs.readFile(baseline)).toEqual(Buffer.from([0, 1, 2, 255]));
  });

  it("replaces an existing baseline, keeping its mode", async () => {
    await fs.mkdir(keyDir, { recursive: true });
    await fs.writeFile(baseline, "old");
    await fs.chmod(baseline, 0o640);

    expect((await writeBack(baseline)).failed).toEqual([]);
    expect(await fs.readFile(baseline, "utf8")).toBe("new");
    expect((await fs.stat(baseline)).mode & 0o777).toBe(0o640);
    expect(await fs.readdir(keyDir)).toEqual([path.basename(baseline)]);
  });

  it.each([
    ["outside the call's baseline directories", () => path.join(tmpDir, "home.png")],
    ["in another flow's directory", () => path.join(path.dirname(keyDir), "other", "home.png")],
    ["spelled with ..", () => `${keyDir}/../login/home.png`],
    ["not a .png", () => path.join(keyDir, "notes.txt")],
    ["relative", () => "home.png"],
  ])("is refused when %s, and reported", async (_what, file) => {
    const target = file();

    const applied = await writeBack(target);

    const error = `${target} is not a baseline of this call (${keyDir}/<name>.png)`;
    expect(applied.result).toEqual({ baselineWrites: [{ path: target, error }] });
    expect(applied.failed).toEqual([{ path: target, error }]);
    expect(applied.written).toEqual([]);
    await expect(fs.access(path.join(tmpDir, "home.png"))).rejects.toThrow();
  });

  it("is refused for a call that computed no baseline directory", async () => {
    const applied = await writeBack(baseline, Buffer.from("new"), []);

    expect(applied.failed).toEqual([{ path: baseline, error: "this call writes no baselines" }]);
    await expect(fs.access(keyDir)).rejects.toThrow();
  });

  it("is refused over a link to nothing, a .png link to another kind of file, and a link out of its directory", async () => {
    await fs.mkdir(keyDir, { recursive: true });
    const env = path.join(tmpDir, ".env");
    const elsewhere = path.join(tmpDir, "elsewhere.png");
    await fs.writeFile(env, "SECRET=1");
    await fs.writeFile(elsewhere, "png");
    const dangling = path.join(keyDir, "a.png");
    const toEnv = path.join(keyDir, "b.png");
    const out = path.join(keyDir, "c.png");
    await fs.symlink(path.join(tmpDir, "missing.png"), dangling);
    await fs.symlink(env, toEnv);
    await fs.symlink(elsewhere, out);

    const applied = await applyClientFileDirectives(
      [dangling, toEnv, out].map((file) => directive(file, Buffer.from("new"))),
      { allowedDirs: [keyDir] }
    );

    expect(applied.failed).toEqual([
      { path: dangling, error: `${dangling} is a symbolic link to a missing file` },
      { path: toEnv, error: `${toEnv} links to a file that is not a PNG file` },
      { path: out, error: `${out} links outside its baseline directory` },
    ]);
    await expect(fs.access(path.join(tmpDir, "missing.png"))).rejects.toThrow();
    expect(await fs.readFile(env, "utf8")).toBe("SECRET=1");
    expect(await fs.readFile(elsewhere, "utf8")).toBe("png");
  });

  it("writes through a .png link to a PNG in its own directory", async () => {
    await fs.mkdir(keyDir, { recursive: true });
    const real = path.join(keyDir, "real.png");
    await fs.writeFile(real, "old");
    await fs.symlink("real.png", baseline);

    expect((await writeBack(baseline)).failed).toEqual([]);
    expect(await fs.readFile(real, "utf8")).toBe("new");
    expect((await fs.lstat(baseline)).isSymbolicLink()).toBe(true);
  });

  it.runIf(process.platform !== "win32")(
    "is refused over a special file, which a write would block on",
    async () => {
      await fs.mkdir(keyDir, { recursive: true });
      execFileSync("mkfifo", [baseline]);

      const applied = await writeBack(baseline);

      expect(applied.failed).toEqual([
        { path: baseline, error: `${baseline} is not a regular file` },
      ]);
    }
  );

  it("that does not finish leaves the old baseline whole and no temporary file", async () => {
    await fs.mkdir(keyDir, { recursive: true });
    await fs.writeFile(baseline, "old");
    vi.mocked(fs.rename).mockRejectedValueOnce(
      Object.assign(new Error("EIO: i/o error, rename"), { code: "EIO" })
    );

    const applied = await writeBack(baseline);

    expect(applied.failed).toEqual([{ path: baseline, error: "EIO: i/o error, rename" }]);
    expect(fs.rename).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(baseline, "utf8")).toBe("old");
    expect(await fs.readdir(keyDir)).toEqual([path.basename(baseline)]);
  });

  it("leaves a text directive to the .argent/flows rule, whatever the allowed directories", async () => {
    const flowFile = path.join(tmpDir, ".argent", "flows", "rec.yaml");
    const outside = path.join(keyDir, "rec.yaml");

    const applied = await applyClientFileDirectives(
      [
        { [CLIENT_FILE_MARKER]: true, path: flowFile, content: "steps: []\n" },
        { [CLIENT_FILE_MARKER]: true, path: outside, content: "steps: []\n" },
      ],
      { allowedDirs: [keyDir] }
    );

    expect(applied).toEqual({ result: [flowFile, null], written: [flowFile], failed: [] });
  });
});
