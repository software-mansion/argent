import { describe, it, expect, afterEach } from "vitest";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { resolveOutPath, writeOutFile } from "../src/out-path.js";

describe("resolveOutPath", () => {
  const realHome = process.env.HOME;
  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
  });

  it("returns an absolute path, so a relative `out` is never handed onward as typed", () => {
    const r = resolveOutPath("shots/base.png");
    expect(r).toEqual({ path: resolve(process.cwd(), "shots/base.png") });
  });

  it("leaves an absolute path alone", () => {
    const abs = join(tmpdir(), "base.png");
    expect(resolveOutPath(abs)).toEqual({ path: abs });
  });

  it("trims, so a padded value is not read as a relative path", () => {
    const abs = join(tmpdir(), "base.png");
    expect(resolveOutPath(`  ${abs}\n`)).toEqual({ path: abs });
  });

  // No shell stands between an agent and this argument, so `~` arrives literal.
  it("expands `~`", () => {
    process.env.HOME = join(tmpdir(), "fake-home");
    expect(resolveOutPath("~/shots/base.png")).toEqual({
      path: join(homedir(), "shots", "base.png"),
    });
  });

  // The tilde expansion runs `join`, which drops a trailing separator and a `.`
  // segment, so each of these reaches `resolve` looking like a filename.
  it.each(["~", "~/", "~/shots/", "~/shots/.", "~/shots/.."])(
    "refuses the directory %j even though expansion would hide its shape",
    (out) => {
      process.env.HOME = join(tmpdir(), "fake-home");
      expect(resolveOutPath(out)).toEqual({
        refusal: "out names the file to write, not a directory.",
      });
    }
  );

  it("does not expand a `~` that is not the whole first segment", () => {
    expect(resolveOutPath("~user/base.png")).toEqual({
      path: resolve(process.cwd(), "~user/base.png"),
    });
  });

  // `resolve` collapses all three, which would turn a directory the caller named
  // into a regular file of that name and block every later write underneath it.
  it.each([`${sep}`, `${sep}.`, `${sep}..`])("refuses a path ending in %j", (tail) => {
    expect(resolveOutPath(join(tmpdir(), "shots") + tail)).toEqual({
      refusal: "out names the file to write, not a directory.",
    });
  });

  it("refuses an empty or whitespace-only path", () => {
    expect(resolveOutPath("")).toEqual({ refusal: "out names no path." });
    expect(resolveOutPath("   ")).toEqual({ refusal: "out names no path." });
  });

  it("accepts a name that merely contains a dot", () => {
    expect(resolveOutPath(join(tmpdir(), "..base.png"))).toEqual({
      path: join(tmpdir(), "..base.png"),
    });
  });
});

describe("writeOutFile", () => {
  let root: string;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("creates missing parents and reports the absolute path", async () => {
    root = await mkdtemp(join(tmpdir(), "outwrite-"));
    const out = join(root, "a", "b", "shot.png");

    const r = await writeOutFile(out, Buffer.from("png"));

    expect(r).toEqual({ wrote: out });
    expect(await readFile(out, "utf8")).toBe("png");
  });

  it("leaves no staging file behind on success", async () => {
    root = await mkdtemp(join(tmpdir(), "outwrite-"));
    await writeOutFile(join(root, "shot.png"), Buffer.from("png"));
    expect(await readdir(root)).toEqual(["shot.png"]);
  });

  // The destination is a baseline the caller diffs against later, so a write that
  // cannot complete must not leave a truncated PNG there. Staging is what makes
  // this hold: a read-only parent still permits opening the existing file with
  // O_TRUNC, so a direct write would empty it before failing.
  it.skipIf(process.getuid?.() === 0)(
    "leaves the file already at `out` untouched when the write fails",
    async () => {
      root = await mkdtemp(join(tmpdir(), "outwrite-"));
      const dir = join(root, "locked");
      await mkdir(dir);
      const out = join(dir, "baseline.png");
      await writeFile(out, "yesterday's baseline");
      await chmod(dir, 0o555);

      try {
        const r = await writeOutFile(out, Buffer.from("a fresh capture"));

        expect(r).toMatchObject({ failure: expect.stringContaining("Could not save to") });
        expect(await readFile(out, "utf8")).toBe("yesterday's baseline");
      } finally {
        await chmod(dir, 0o755);
      }
    }
  );

  it("removes the staging file when the rename cannot be completed", async () => {
    root = await mkdtemp(join(tmpdir(), "outwrite-"));
    // A non-empty directory standing where the file should go: staging succeeds,
    // the rename onto it does not.
    const out = join(root, "occupied");
    await mkdir(out);
    await writeFile(join(out, "keep"), "keep");

    const r = await writeOutFile(out, Buffer.from("png"));

    expect("failure" in r).toBe(true);
    expect((await readdir(root)).filter((n) => n.includes(".part"))).toEqual([]);
    expect(await readdir(out)).toEqual(["keep"]);
  });

  // `rename` does not follow a symlink and does not care what it unlinks, so
  // without a check `out: ~/shots` where shots -> a directory destroys the link
  // and reports a save. A truncating write refused this with EISDIR.
  it("refuses a symlink at `out` rather than replacing it", async () => {
    root = await mkdtemp(join(tmpdir(), "outwrite-"));
    const realDir = join(root, "real");
    await mkdir(realDir);
    const linkToDir = join(root, "shots");
    await symlink(realDir, linkToDir);
    const vault = join(root, "vault.png");
    await writeFile(vault, "yesterday");
    const linkToFile = join(root, "latest.png");
    await symlink(vault, linkToFile);

    for (const target of [linkToDir, linkToFile]) {
      const r = await writeOutFile(target, Buffer.from("png"));
      expect(r).toEqual({
        failure: `Could not save to ${target}: a symbolic link is already there, and only a regular file is replaced.`,
      });
      expect((await lstat(target)).isSymbolicLink()).toBe(true);
    }
    expect(await readFile(vault, "utf8")).toBe("yesterday");
  });

  // rename's own errno names the `.part` sibling the caller never mentioned.
  it("names the directory at `out`, not the staging file", async () => {
    root = await mkdtemp(join(tmpdir(), "outwrite-"));
    const dir = join(root, "shots");
    await mkdir(dir);

    const r = await writeOutFile(dir, Buffer.from("png"));

    expect(r).toEqual({
      failure: `Could not save to ${dir}: a directory is already there, and only a regular file is replaced.`,
    });
    expect(await readdir(root)).toEqual(["shots"]);
  });

  it("replaces a regular file already at `out`", async () => {
    root = await mkdtemp(join(tmpdir(), "outwrite-"));
    const out = join(root, "baseline.png");
    await writeFile(out, "yesterday");

    expect(await writeOutFile(out, Buffer.from("today"))).toEqual({ wrote: out });
    expect(await readFile(out, "utf8")).toBe("today");
  });

  // The staging suffix must not push a filename the caller may legally use over
  // NAME_MAX, failing a write the target path alone permits.
  it("writes a basename at the length limit", async () => {
    root = await mkdtemp(join(tmpdir(), "outwrite-"));
    const out = join(root, `${"x".repeat(251)}.png`);

    expect(await writeOutFile(out, Buffer.from("png"))).toEqual({ wrote: out });
    expect(await readFile(out, "utf8")).toBe("png");
  });

  it("propagates a refusal instead of writing", async () => {
    root = await mkdtemp(join(tmpdir(), "outwrite-"));
    const r = await writeOutFile(join(root, "shots") + "/", Buffer.from("png"));
    expect(r).toEqual({
      failure: `Could not save to ${join(root, "shots")}/: out names the file to write, not a directory.`,
    });
    expect(await readdir(root)).toEqual([]);
  });
});
