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
    getSnapshot: vi.fn(() => ({
      services: new Map(),
      namespaces: [],
      tools: ["always-tool", "hinted-tool", "plain-tool"],
    })),
    getTool: vi.fn((name: string) => {
      if (name === "always-tool") {
        return {
          id: "always-tool",
          description: "Always loaded",
          inputSchema: { type: "object", properties: {} },
          alwaysLoad: true,
          searchHint: "always loaded discovery",
          services: () => ({}),
          execute: async () => ({}),
        };
      }
      if (name === "hinted-tool") {
        return {
          id: "hinted-tool",
          description: "Deferred but hinted",
          inputSchema: { type: "object", properties: {} },
          searchHint: "profiling hotspots cpu",
          services: () => ({}),
          execute: async () => ({}),
        };
      }
      if (name === "plain-tool") {
        return {
          id: "plain-tool",
          description: "Plain tool",
          inputSchema: { type: "object", properties: {} },
          services: () => ({}),
          execute: async () => ({}),
        };
      }
      return undefined;
    }),
    invokeTool: vi.fn(),
  } as unknown as Registry;
}

describe("GET /tools progressive-loading metadata", () => {
  let handle: HttpAppHandle;
  let request: typeof import("supertest").default;

  beforeEach(async () => {
    request = await import("supertest").then((m) => m.default);
    handle = createHttpApp(stubRegistry());
  });

  afterEach(() => {
    handle?.dispose();
    vi.clearAllMocks();
  });

  it("passes alwaysLoad and searchHint through on /tools response", async () => {
    const res = await request(handle.app).get("/tools").expect(200);
    const byName = new Map<string, Record<string, unknown>>(
      (res.body.tools as Record<string, unknown>[]).map((t) => [t.name as string, t])
    );

    expect(byName.get("always-tool")).toMatchObject({
      alwaysLoad: true,
      searchHint: "always loaded discovery",
    });
    expect(byName.get("hinted-tool")).toMatchObject({
      searchHint: "profiling hotspots cpu",
    });
    expect(byName.get("hinted-tool")).not.toHaveProperty("alwaysLoad");
    expect(byName.get("plain-tool")).not.toHaveProperty("alwaysLoad");
    expect(byName.get("plain-tool")).not.toHaveProperty("searchHint");
  });
});
