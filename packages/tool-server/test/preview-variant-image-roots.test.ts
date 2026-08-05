import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { previewImageRoots } from "../src/preview";

/**
 * The `/variant-image` route serves a variant's `previewImage` only when the
 * file resolves inside one of these roots (or inside a `.argent/screenshots`
 * directory, which the route admits by shape — see
 * preview-variant-image-durable.test.ts). These are the scratch locations an
 * agent drops an image into by hand.
 */
function contains(roots: string[], file: string): boolean {
  return roots.some((root) => file === root || file.startsWith(root + sep));
}

describe("previewImageRoots", () => {
  let originalCwd: string;
  let outside: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    // Deliberately NOT under tmpdir: the OS temp dir is a root in its own
    // right, so a cwd fixture placed there would be served whether or not cwd
    // is a root, and the assertion below would hold against its own removal.
    outside = await realpath(await mkdtemp(join(originalCwd, "test-variant-image-roots-")));
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(outside, { recursive: true, force: true });
  });

  it("serves an image the agent left in the tool-server's working directory", async () => {
    const work = join(outside, "work");
    await mkdir(work, { recursive: true });
    process.chdir(work);

    expect(contains(previewImageRoots(), join(work, "shot.png"))).toBe(true);
  });

  it("serves an image under the OS temp dir", async () => {
    process.chdir(outside);

    expect(contains(previewImageRoots(), join(await realpath(tmpdir()), "shot.png"))).toBe(true);
  });

  it("lists `/tmp` alongside the per-user temp dir", async () => {
    // On macOS `os.tmpdir()` is a per-user `/var/folders/…` path, so an agent
    // writing to `/tmp` — a very common choice — lands outside it. (On Linux
    // the two resolve to the same directory, so this only bites on macOS.)
    process.chdir(outside);

    expect(previewImageRoots()).toContain(await realpath("/tmp"));
  });

  it("does not admit the durable screenshots directory as a root", async () => {
    // Durable screenshots are admitted by the shape of their own path, not by a
    // root derived from this process's cwd — the tool-server is a shared daemon
    // whose cwd belongs to whichever project spawned it, not to the client that
    // saved the file. A root here would answer the wrong project's question.
    const project = join(outside, "project");
    await mkdir(project, { recursive: true });
    process.chdir(project);

    expect(previewImageRoots()).not.toContain(join(project, ".argent", "screenshots"));
  });
});
