import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { join } from "node:path";
import { mkdtemp, mkdir, rm, writeFile, realpath, symlink } from "node:fs/promises";
import type { Registry } from "@argent/registry";

// /variant-image is a lens-only route behind the argent-lens flag; force it ON
// so the suite is independent of the machine's real flags.json.
vi.mock("@argent/configuration-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@argent/configuration-core")>()),
  isFlagEnabled: vi.fn(() => true),
}));

import { createPreviewRouter } from "../src/preview";
import { variantProposalStore } from "../src/utils/variant-proposals";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);

/**
 * The Argent Lens hands `propose_variant` the path `screenshot` just returned,
 * and the preview window fetches it back through /variant-image. That PNG is
 * saved durably under `.argent/screenshots/`, so the route has to serve from
 * there — otherwise every thumbnail 404s and the window shows "No preview".
 *
 * Fixtures deliberately live under the package directory, NOT under `tmpdir()`:
 * the OS temp dir and `/tmp` are themselves allowed roots, so a fixture placed
 * there is served no matter what the durable roots say and the test would pass
 * against the very regression it exists to catch.
 */
function harness() {
  const registry = { invokeTool: vi.fn() } as unknown as Registry;
  const app = express();
  app.use(express.json());
  app.use(createPreviewRouter(registry));
  return app;
}

async function serveFrom(previewImage: string) {
  const { elementId, variantId } = variantProposalStore.proposeVariant({
    element: "Login button",
    variant: { name: "orange", summary: "warmer", previewImage },
  });
  return request(harness()).get(`/variant-image/${elementId}/${variantId}`);
}

describe("GET /variant-image — durable screenshots", () => {
  let fixtures: string; // outside tmpdir/, /tmp and (after chdir) cwd
  let projectRoot: string;
  let home: string;
  let originalCwd: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    variantProposalStore.reset();
    originalCwd = process.cwd();
    fixtures = await realpath(await mkdtemp(join(originalCwd, "test-variant-image-")));
    projectRoot = join(fixtures, "project");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(join(projectRoot, "package.json"), "{}"); // the project marker
    home = join(fixtures, "home");
    await mkdir(home, { recursive: true });
    await mkdir(join(fixtures, "elsewhere-2"), { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    variantProposalStore.reset();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(fixtures, { recursive: true, force: true });
  });

  it("serves a screenshot saved at the project root while cwd is a subdirectory", async () => {
    // The monorepo case: the agent works in `apps/mobile`, but the screenshot is
    // saved at the PROJECT root, which is under none of cwd, tmpdir, or /tmp.
    const sub = join(projectRoot, "apps", "mobile");
    await mkdir(sub, { recursive: true });
    process.chdir(sub);
    const dir = join(projectRoot, ".argent", "screenshots");
    await mkdir(dir, { recursive: true });
    const shot = join(dir, "screenshot-SIM-1.png");
    await writeFile(shot, PNG);

    const res = await serveFrom(shot);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(Buffer.from(res.body as Buffer)).toEqual(PNG);
  });

  it("serves a screenshot saved under the global ~/.argent/screenshots", async () => {
    // Where the client saves when it is not inside a project. Both roots are
    // registered unconditionally, since which one the client picked is its call.
    const elsewhere = join(fixtures, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    process.chdir(elsewhere);
    const dir = join(home, ".argent", "screenshots");
    await mkdir(dir, { recursive: true });
    const shot = join(dir, "screenshot-SIM-1.png");
    await writeFile(shot, PNG);

    const res = await serveFrom(shot);

    expect(res.status).toBe(200);
    expect(Buffer.from(res.body as Buffer)).toEqual(PNG);
  });

  it("serves a screenshot belonging to a project this tool-server was not started in", async () => {
    // The tool-server is a machine-global daemon keyed by install, not project
    // (`ensureToolsServer` reuses one that "may be healthy and serving another
    // project's session"), so its cwd is whichever project spawned it. Deriving
    // the durable directory from that cwd answers the wrong question: the
    // client saved into ITS project. On main this could not bite, because the
    // materialized path was always under tmpdir — an allowed root regardless.
    const projectA = join(fixtures, "projectA");
    const projectB = join(fixtures, "projectB");
    for (const p of [projectA, projectB]) {
      await mkdir(p, { recursive: true });
      await writeFile(join(p, "package.json"), "{}");
    }
    process.chdir(projectA); // the daemon's cwd
    const dir = join(projectB, ".argent", "screenshots"); // the client's project
    await mkdir(dir, { recursive: true });
    const shot = join(dir, "screenshot-SIM-1.png");
    await writeFile(shot, PNG);

    const res = await serveFrom(shot);

    expect(res.status).toBe(200);
    expect(Buffer.from(res.body as Buffer)).toEqual(PNG);
  });

  it("still refuses an image outside every allowed root", async () => {
    // Containment is what stops the route serving arbitrary files; widening it
    // for screenshots must not have opened the rest of the tree.
    const sub = join(projectRoot, "apps", "mobile");
    await mkdir(sub, { recursive: true });
    process.chdir(sub);
    const shot = join(projectRoot, "assets", "secret.png");
    await mkdir(join(projectRoot, "assets"), { recursive: true });
    await writeFile(shot, PNG);

    expect((await serveFrom(shot)).status).toBe(404);
  });

  it("refuses a directory that merely resembles the durable one", async () => {
    // Admitting by shape means the shape has to be exact. A sibling whose name
    // starts with the allowed one, a directory ending in `.argent` that isn't
    // it, and a subdirectory below the screenshots dir are all outside what
    // `screenshot` writes — and each is a way a prefix-flavoured check leaks.
    process.chdir(join(fixtures, "elsewhere-2"));
    const cases = [
      join(projectRoot, ".argent", "screenshots-evil", "x.png"),
      join(projectRoot, "not.argent", "screenshots", "x.png"),
      join(projectRoot, ".argent", "screenshots", "nested", "x.png"),
      join(projectRoot, ".argent", "recordings", "x.png"),
      join(projectRoot, ".argent", "flags.json.png"),
    ];
    for (const shot of cases) {
      await mkdir(join(shot, ".."), { recursive: true });
      await writeFile(shot, PNG);
      expect({ shot, status: (await serveFrom(shot)).status }).toEqual({ shot, status: 404 });
    }
  });

  it("refuses a symlink that borrows the durable directory's name", async () => {
    // The check runs on the realpath, so planting `.argent/screenshots` as a
    // link to somewhere else cannot lend that directory's privileges to the
    // files inside it.
    process.chdir(join(fixtures, "elsewhere-2"));
    const secrets = join(fixtures, "secrets");
    await mkdir(secrets, { recursive: true });
    await writeFile(join(secrets, "id_rsa.png"), PNG);
    await mkdir(join(projectRoot, ".argent"), { recursive: true });
    await symlink(secrets, join(projectRoot, ".argent", "screenshots"));

    const res = await serveFrom(join(projectRoot, ".argent", "screenshots", "id_rsa.png"));

    expect(res.status).toBe(404);
  });
});
