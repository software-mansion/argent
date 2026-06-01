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
    getSnapshot: vi.fn(() => ({
      services: new Map(),
      namespaces: [],
      tools: ["always-tool", "hinted-tool", "plain-tool", "device-tool", "boot-tool"],
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
      if (name === "device-tool") {
        return {
          id: "device-tool",
          description: "Device tool",
          inputSchema: { type: "object", properties: {} },
          capability: { apple: { simulator: true }, android: { emulator: true } },
          services: () => ({}),
          execute: async () => ({}),
        };
      }
      if (name === "boot-tool") {
        return {
          id: "boot-tool",
          description: "Boot tool",
          inputSchema: { type: "object", properties: {} },
          capability: { apple: { simulator: true }, android: { emulator: true } },
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
  const request = supertest;

  beforeEach(async () => {
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

  it("does not pass bundleId into telemetry invocation metadata", async () => {
    const release = vi.fn();
    let seenMeta: Record<string, unknown> | undefined;
    const recordInvocation = vi.fn((_toolId: string, meta: Record<string, unknown>) => {
      seenMeta = meta;
      return release;
    });
    handle.dispose();
    handle = createHttpApp(stubRegistry(), { recordInvocation });

    await request(handle.app)
      .post("/tools/device-tool")
      .send({
        udid: "11111111-1111-1111-1111-111111111111",
        bundleId: "com.example.app",
      })
      .expect(200);

    expect(recordInvocation).toHaveBeenCalledWith("device-tool", {
      platform: "ios",
      deviceId: "11111111-1111-1111-1111-111111111111",
    });
    expect(seenMeta).not.toHaveProperty("bundleId");
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not record platform metadata for non-device tools", async () => {
    const recordInvocation = vi.fn(() => vi.fn());
    handle.dispose();
    handle = createHttpApp(stubRegistry(), { recordInvocation });

    await request(handle.app)
      .post("/tools/plain-tool")
      .send({
        udid: "11111111-1111-1111-1111-111111111111",
        bundleId: "com.example.app",
      })
      .expect(200);

    expect(recordInvocation).not.toHaveBeenCalled();
  });

  it("records Android platform for avdName device-management calls without a device hash", async () => {
    const recordInvocation = vi.fn((_toolId: string, meta: Record<string, unknown>) => {
      expect(meta).toEqual({ platform: "android" });
      return vi.fn();
    });
    handle.dispose();
    handle = createHttpApp(stubRegistry(), { recordInvocation });

    await request(handle.app).post("/tools/boot-tool").send({ avdName: "Pixel_9" }).expect(200);

    expect(recordInvocation).toHaveBeenCalledWith("boot-tool", { platform: "android" });
  });
});
