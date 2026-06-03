import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import supertest from "supertest";
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
  let request: typeof supertest;

  beforeEach(async () => {
    request = supertest;
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

describe("Host header validation — explicit non-loopback bind host", () => {
  let handle: HttpAppHandle;

  beforeEach(() => {
    handle = createHttpApp(stubRegistry(), { bindHost: "192.168.92.208" });
  });

  afterEach(() => handle?.dispose());

  it("accepts the configured bind host (the `argent link` path)", async () => {
    const res = await supertest(handle.app).get("/tools").set("Host", "192.168.92.208:3001");
    expect(res.status).toBe(200);
  });

  it("still accepts loopback", async () => {
    const res = await supertest(handle.app).get("/tools").set("Host", "127.0.0.1:3001");
    expect(res.status).toBe(200);
  });

  it("still rejects a different non-loopback host (DNS-rebinding)", async () => {
    const res = await supertest(handle.app).get("/tools").set("Host", "evil.com:3001");
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/192\.168\.92\.208/);
  });
});

describe("Host header validation — wildcard bind disables the guard", () => {
  let handle: HttpAppHandle;

  beforeEach(() => {
    handle = createHttpApp(stubRegistry(), { bindHost: "0.0.0.0" });
  });

  afterEach(() => handle?.dispose());

  it("accepts an arbitrary Host when bound to all interfaces", async () => {
    const res = await supertest(handle.app).get("/tools").set("Host", "10.0.0.42:3001");
    expect(res.status).toBe(200);
  });

  it("accepts a request with no Host header", async () => {
    const res = await supertest(handle.app).get("/tools");
    expect(res.status).toBe(200);
  });
});
