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

const TOKEN = "abc123def456";

describe("Authorization gate", () => {
  let handle: HttpAppHandle;
  let request: typeof supertest;
  let originalToken: string | undefined;

  beforeEach(async () => {
    request = supertest;
    originalToken = process.env.ARGENT_AUTH_TOKEN;
    process.env.ARGENT_AUTH_TOKEN = TOKEN;
    handle = createHttpApp(stubRegistry());
  });

  afterEach(() => {
    handle?.dispose();
    if (originalToken === undefined) delete process.env.ARGENT_AUTH_TOKEN;
    else process.env.ARGENT_AUTH_TOKEN = originalToken;
  });

  it("accepts a request with the correct Bearer token", async () => {
    const res = await request(handle.app).get("/tools").set("Authorization", `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
  });

  it("rejects with 401 when Authorization header is missing", async () => {
    const res = await request(handle.app).get("/tools");
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Authorization/i);
  });

  it("rejects with 401 when token is wrong", async () => {
    const res = await request(handle.app).get("/tools").set("Authorization", "Bearer wrong-token");
    expect(res.status).toBe(401);
  });

  it("rejects when scheme is not Bearer", async () => {
    const res = await request(handle.app).get("/tools").set("Authorization", `Basic ${TOKEN}`);
    expect(res.status).toBe(401);
  });

  it("rejects when token is the right length but wrong content (constant-time path)", async () => {
    const wrongSameLength = "x".repeat(TOKEN.length);
    const res = await request(handle.app)
      .get("/tools")
      .set("Authorization", `Bearer ${wrongSameLength}`);
    expect(res.status).toBe(401);
  });

  it("blocks POST /tools/:name without auth", async () => {
    const res = await request(handle.app).post("/tools/anything").send({});
    expect(res.status).toBe(401);
  });

  it("blocks /shutdown without auth", async () => {
    handle.dispose();
    handle = createHttpApp(stubRegistry(), { onShutdown: () => {} });
    const res = await request(handle.app).post("/shutdown");
    expect(res.status).toBe(401);
  });

  it("blocks /registry/snapshot without auth", async () => {
    const res = await request(handle.app).get("/registry/snapshot");
    expect(res.status).toBe(401);
  });

  it("exempts the /preview UI subtree from auth", async () => {
    // The browser-loaded preview UI has no token; /preview and /preview/* must
    // stay reachable. (stub registry has no UI html → not 200, but must not 401.)
    const res = await request(handle.app).get("/preview/");
    expect(res.status).not.toBe(401);
  });

  it("does NOT exempt a non-/preview/ path that merely starts with 'preview' (footgun closed)", async () => {
    // Guards the tightened exemption: a bare startsWith('/preview') used to
    // leave a route like /preview-status silently unauthenticated.
    const res = await request(handle.app).get("/preview-status");
    expect(res.status).toBe(401);
  });
});

describe("Authorization gate (token unset / dev mode)", () => {
  let handle: HttpAppHandle;
  let request: typeof supertest;
  let originalToken: string | undefined;

  beforeEach(async () => {
    request = supertest;
    originalToken = process.env.ARGENT_AUTH_TOKEN;
    delete process.env.ARGENT_AUTH_TOKEN;
    handle = createHttpApp(stubRegistry());
  });

  afterEach(() => {
    handle?.dispose();
    if (originalToken === undefined) delete process.env.ARGENT_AUTH_TOKEN;
    else process.env.ARGENT_AUTH_TOKEN = originalToken;
  });

  it("permits unauthenticated requests when ARGENT_AUTH_TOKEN is unset (dev mode)", async () => {
    const res = await request(handle.app).get("/tools");
    expect(res.status).toBe(200);
  });
});

describe("CORS removal", () => {
  let handle: HttpAppHandle;
  let request: typeof supertest;
  let originalToken: string | undefined;

  beforeEach(async () => {
    request = supertest;
    originalToken = process.env.ARGENT_AUTH_TOKEN;
    delete process.env.ARGENT_AUTH_TOKEN;
    handle = createHttpApp(stubRegistry());
  });

  afterEach(() => {
    handle?.dispose();
    if (originalToken === undefined) delete process.env.ARGENT_AUTH_TOKEN;
    else process.env.ARGENT_AUTH_TOKEN = originalToken;
  });

  it("does not emit Access-Control-Allow-Origin: *", async () => {
    const res = await request(handle.app).get("/tools").set("Origin", "https://evil.example");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
