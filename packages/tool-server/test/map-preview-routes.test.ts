import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import express from "express";
import request from "supertest";
import type { Registry } from "@argent/registry";
import { createPreviewRouter } from "../src/preview";
import { mapSessionStore } from "../src/utils/map-session";

// The /preview/map* routes read the SAME module singleton the map-app tool
// writes — that shared store is the whole wiring, so these tests drive the
// singleton directly and assert what the routes serve.

function makeApp(): express.Express {
  const registry = { invokeTool: vi.fn() } as unknown as Registry;
  const app = express();
  app.use("/preview", createPreviewRouter(registry));
  return app;
}

const PNG_BYTES = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

describe("GET /preview/map", () => {
  it("starts idle with an empty graph", async () => {
    const res = await request(makeApp()).get("/preview/map");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.status).toBe("idle");
    expect(res.body.nodes).toEqual([]);
    expect(res.body.edges).toEqual([]);
    expect(res.body.stats).toMatchObject({ screens: 0, edges: 0 });
  });
});

describe("/preview/map with a live session (screenshot allowlist)", () => {
  let sessionDir: string;
  let outsideFile: string;

  beforeAll(() => {
    mapSessionStore.begin({
      udid: "TEST-UDID",
      bundleId: "com.example.app",
      platform: "ios",
      limits: { maxScreens: 30, maxActionsPerScreen: 12, maxDepth: 5, timeBudgetMs: 300_000 },
      openWindow: false,
    });
    sessionDir = mapSessionStore.sessionScreenshotDir()!;
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "s0.png"), PNG_BYTES);
    // A real, readable PNG that lives OUTSIDE the session dir — the route must
    // refuse it even though the store points at it.
    outsideFile = path.join(os.tmpdir(), `argent-map-test-outside-${process.pid}.png`);
    fs.writeFileSync(outsideFile, PNG_BYTES);

    mapSessionStore.addNode({
      key: "k0",
      title: "Home",
      depth: 0,
      outside: false,
      actionsTotal: 1,
      screenshotPath: path.join(sessionDir, "s0.png"),
    });
    mapSessionStore.addNode({
      key: "k1",
      title: "Escapee",
      depth: 1,
      outside: false,
      actionsTotal: 0,
      screenshotPath: outsideFile,
    });
    mapSessionStore.addNode({
      key: "k2",
      title: "No shot",
      depth: 1,
      outside: false,
      actionsTotal: 0,
      screenshotPath: null,
    });
  });

  afterAll(() => {
    // Never leave the singleton "running" for other suites, and clean up files.
    mapSessionStore.cancel();
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(outsideFile, { force: true });
  });

  it("GET /preview/map reflects the live crawl state (exact wire shape)", async () => {
    const res = await request(makeApp()).get("/preview/map");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("running");
    expect(res.body.bundleId).toBe("com.example.app");
    expect(res.body.rootId).toBe("s0");
    expect(res.body.nodes).toHaveLength(3);
    expect(res.body.nodes[0]).toMatchObject({
      id: "s0",
      title: "Home",
      depth: 0,
      outside: false,
      actionsTotal: 1,
    });
  });

  it("serves a node's PNG from inside the session dir", async () => {
    const res = await request(makeApp()).get("/preview/map/screenshot/s0");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/image\/png/);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(Buffer.compare(res.body as Buffer, PNG_BYTES)).toBe(0);
  });

  it("refuses a stored path OUTSIDE the session dir (the allowlist is the protection)", async () => {
    // The file exists and is a real PNG — only its location is wrong.
    expect(fs.existsSync(outsideFile)).toBe(true);
    const res = await request(makeApp()).get("/preview/map/screenshot/s1");
    expect(res.status).toBe(404);
  });

  it("404s a node without a screenshot and an unknown node id", async () => {
    expect((await request(makeApp()).get("/preview/map/screenshot/s2")).status).toBe(404);
    expect((await request(makeApp()).get("/preview/map/screenshot/nope")).status).toBe(404);
  });

  it("404s when the stored file has vanished from disk", async () => {
    mapSessionStore.addNode({
      key: "k3",
      title: "Ghost",
      depth: 1,
      outside: false,
      actionsTotal: 0,
      screenshotPath: path.join(sessionDir, "missing.png"),
    });
    const res = await request(makeApp()).get("/preview/map/screenshot/s3");
    expect(res.status).toBe(404);
  });
});
