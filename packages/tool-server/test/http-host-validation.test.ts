import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHttpApp, type HttpAppHandle } from "../src/http";
import type { Registry } from "@argent/registry";

vi.mock("../src/utils/update-checker", () => ({
  getUpdateState: vi.fn(() => ({
    updateAvailable: false,
    latestVersion: null,
    currentVersion: "1.0.0",
  })),
  isUpdateNoteSuppressed: vi.fn(() => true),
  suppressUpdateNote: vi.fn(),
}));

function stubRegistry(): Registry {
  return {
    getSnapshot: vi.fn(() => ({ services: new Map(), namespaces: [], tools: [] })),
    getTool: vi.fn(() => undefined),
    invokeTool: vi.fn(async () => ({ ok: true })),
  } as unknown as Registry;
}

describe("Host header validation", () => {
  let handle: HttpAppHandle;
  let request: typeof import("supertest").default;

  beforeEach(async () => {
    request = await import("supertest").then((m) => m.default);
    handle = createHttpApp(stubRegistry());
  });

  afterEach(() => {
    handle?.dispose();
  });

  it("accepts 127.0.0.1 with port", async () => {
    const res = await request(handle.app).get("/tools").set("Host", "127.0.0.1:60770");
    expect(res.status).toBe(200);
  });

  it("accepts localhost with port", async () => {
    const res = await request(handle.app).get("/tools").set("Host", "localhost:60770");
    expect(res.status).toBe(200);
  });

  it("accepts ::1 with port", async () => {
    const res = await request(handle.app).get("/tools").set("Host", "[::1]:60770");
    expect(res.status).toBe(200);
  });

  it("accepts 127.0.0.1 without port", async () => {
    const res = await request(handle.app).get("/tools").set("Host", "127.0.0.1");
    expect(res.status).toBe(200);
  });

  it("rejects a public hostname (DNS-rebinding attack)", async () => {
    const res = await request(handle.app).get("/tools").set("Host", "evil.com:60770");
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/loopback/i);
    expect(res.body.error).toMatch(/DNS-rebinding/i);
  });

  it("rejects an IP that is not loopback", async () => {
    const res = await request(handle.app).get("/tools").set("Host", "10.0.0.1:60770");
    expect(res.status).toBe(403);
  });

  it("blocks DNS-rebinding even on POST /tools/:name", async () => {
    const res = await request(handle.app)
      .post("/tools/anything")
      .set("Host", "attacker.example:60770")
      .send({});
    expect(res.status).toBe(403);
  });
});
