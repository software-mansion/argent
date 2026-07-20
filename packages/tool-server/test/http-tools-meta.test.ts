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

// Drive the synchronous, cache-only runtime-kind readers that http.ts consults
// to split a TV target out of its base mobile platform. Real code warms these
// caches via simctl/adb; here we mock only the two getters so a case can pretend
// the cache is cold ("mobile"/undefined → coarse platform) or warm for TV.
const tvKinds = vi.hoisted(() => ({
  ios: undefined as "mobile" | "tv" | undefined,
  android: undefined as "mobile" | "tv" | undefined,
}));

vi.mock("../src/utils/ios-devices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/ios-devices")>();
  return { ...actual, getCachedSimulatorRuntimeKind: () => tvKinds.ios };
});

vi.mock("../src/utils/adb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/adb")>();
  return { ...actual, getCachedAndroidRuntimeKind: () => tvKinds.android };
});

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
    tvKinds.ios = undefined;
    tvKinds.android = undefined;
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
    const recordInvocation = vi.fn((_toolInvocationId: string, meta: Record<string, unknown>) => {
      seenMeta = meta;
      return release;
    });
    const registry = stubRegistry();
    handle.dispose();
    handle = createHttpApp(registry, { recordInvocation });

    await request(handle.app)
      .post("/tools/device-tool")
      .send({
        udid: "11111111-1111-1111-1111-111111111111",
        bundleId: "com.example.app",
      })
      .expect(200);

    expect(recordInvocation).toHaveBeenCalledWith(expect.any(String), {
      platform: "ios",
    });
    expect(seenMeta).not.toHaveProperty("bundleId");
    expect(seenMeta).not.toHaveProperty("deviceId");
    expect(release).toHaveBeenCalledOnce();
    expect(registry.invokeTool).toHaveBeenCalledWith(
      "device-tool",
      expect.any(Object),
      expect.objectContaining({ toolInvocationId: recordInvocation.mock.calls[0]![0] })
    );
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
    const recordInvocation = vi.fn((_toolInvocationId: string, meta: Record<string, unknown>) => {
      expect(meta).toEqual({ platform: "android" });
      return vi.fn();
    });
    handle.dispose();
    handle = createHttpApp(stubRegistry(), { recordInvocation });

    await request(handle.app).post("/tools/boot-tool").send({ avdName: "Pixel_9" }).expect(200);

    expect(recordInvocation).toHaveBeenCalledWith(expect.any(String), { platform: "android" });
  });

  it("refines an iOS device to `tvos` when its cached runtime kind is tv", async () => {
    tvKinds.ios = "tv";
    let seenMeta: Record<string, unknown> | undefined;
    const recordInvocation = vi.fn((_id: string, meta: Record<string, unknown>) => {
      seenMeta = meta;
      return vi.fn();
    });
    handle.dispose();
    handle = createHttpApp(stubRegistry(), { recordInvocation });

    await request(handle.app)
      .post("/tools/device-tool")
      .send({ udid: "11111111-1111-1111-1111-111111111111" })
      .expect(200);

    // Same UDID shape as an iPhone sim, but the warm cache splits it out as tvOS.
    expect(seenMeta).toEqual({ platform: "tvos" });
  });

  it("refines an Android device to `android-tv` when its cached runtime kind is tv", async () => {
    tvKinds.android = "tv";
    let seenMeta: Record<string, unknown> | undefined;
    const recordInvocation = vi.fn((_id: string, meta: Record<string, unknown>) => {
      seenMeta = meta;
      return vi.fn();
    });
    handle.dispose();
    handle = createHttpApp(stubRegistry(), { recordInvocation });

    await request(handle.app)
      .post("/tools/device-tool")
      .send({ udid: "emulator-5554" })
      .expect(200);

    expect(seenMeta).toEqual({ platform: "android-tv" });
  });

  it("keeps the coarse `ios` platform when the cached kind is mobile (not tv)", async () => {
    tvKinds.ios = "mobile";
    let seenMeta: Record<string, unknown> | undefined;
    const recordInvocation = vi.fn((_id: string, meta: Record<string, unknown>) => {
      seenMeta = meta;
      return vi.fn();
    });
    handle.dispose();
    handle = createHttpApp(stubRegistry(), { recordInvocation });

    await request(handle.app)
      .post("/tools/device-tool")
      .send({ udid: "11111111-1111-1111-1111-111111111111" })
      .expect(200);

    expect(seenMeta).toEqual({ platform: "ios" });
  });

  it("keeps the coarse platform when the cache is cold (first call before warm-up)", async () => {
    // tvKinds default to undefined → the reader can't yet tell TV from mobile, so
    // the first tool call on a device reports the base platform. A later call,
    // once describe/streaming has warmed the cache, would report the TV variant.
    let seenMeta: Record<string, unknown> | undefined;
    const recordInvocation = vi.fn((_id: string, meta: Record<string, unknown>) => {
      seenMeta = meta;
      return vi.fn();
    });
    handle.dispose();
    handle = createHttpApp(stubRegistry(), { recordInvocation });

    await request(handle.app)
      .post("/tools/device-tool")
      .send({ udid: "11111111-1111-1111-1111-111111111111" })
      .expect(200);

    expect(seenMeta).toEqual({ platform: "ios" });
  });

  it("re-derives a child sub-tool's TV platform from its own device arg", async () => {
    tvKinds.android = "tv";
    const recordInvocation = vi.fn((_id: string, _meta: Record<string, unknown>) => vi.fn());
    const registry = stubRegistry();
    handle.dispose();
    handle = createHttpApp(registry, { recordInvocation });

    // Parent targets an Android TV device.
    await request(handle.app)
      .post("/tools/device-tool")
      .send({ udid: "emulator-5554" })
      .expect(200);

    const { recordChildInvocation } = vi.mocked(registry.invokeTool).mock.calls[0]![2] as {
      recordChildInvocation: (id: string, childArgs?: unknown) => () => void;
    };

    // A sub-tool targeting the same TV device is attributed to android-tv too.
    recordChildInvocation("tv-child", { udid: "emulator-5554" });
    expect(recordInvocation).toHaveBeenCalledWith("tv-child", { platform: "android-tv" });
  });

  it("records the AI client from request headers alongside platform", async () => {
    let seenMeta: Record<string, unknown> | undefined;
    const recordInvocation = vi.fn((_id: string, meta: Record<string, unknown>) => {
      seenMeta = meta;
      return vi.fn();
    });
    handle.dispose();
    handle = createHttpApp(stubRegistry(), { recordInvocation });

    await request(handle.app)
      .post("/tools/device-tool")
      .set("X-Argent-AI-Client", "codex")
      .send({ udid: "11111111-1111-1111-1111-111111111111" })
      .expect(200);

    expect(seenMeta).toEqual({ platform: "ios", ai_client: "codex" });
  });

  it("forwards a child-invocation recorder bound to the request's attribution", async () => {
    const release = vi.fn();
    const recordInvocation = vi.fn((_id: string, _meta: Record<string, unknown>) => release);
    const registry = stubRegistry();
    handle.dispose();
    handle = createHttpApp(registry, { recordInvocation });

    await request(handle.app)
      .post("/tools/device-tool")
      .set("X-Argent-AI-Client", "codex")
      .send({ udid: "11111111-1111-1111-1111-111111111111" })
      .expect(200);

    // The parent invocation is recorded with the resolved attribution.
    expect(recordInvocation).toHaveBeenCalledTimes(1);
    expect(recordInvocation.mock.calls[0]![1]).toEqual({ platform: "ios", ai_client: "codex" });

    // A recorder is threaded into the tool context so orchestrator tools can
    // attribute the sub-tools they dispatch. The AI client is inherited; a child
    // with no device arg of its own falls back to the request's platform.
    const opts = vi.mocked(registry.invokeTool).mock.calls[0]![2] as {
      recordChildInvocation?: (id: string, childArgs?: unknown) => () => void;
    };
    expect(opts.recordChildInvocation).toBeTypeOf("function");

    const childRelease = opts.recordChildInvocation!("child-id");
    expect(recordInvocation).toHaveBeenCalledWith("child-id", {
      platform: "ios",
      ai_client: "codex",
    });
    expect(childRelease).toBe(release);
  });

  it("re-derives each child's platform from its own device arg", async () => {
    const recordInvocation = vi.fn((_id: string, _meta: Record<string, unknown>) => vi.fn());
    const registry = stubRegistry();
    handle.dispose();
    handle = createHttpApp(registry, { recordInvocation });

    // Parent request targets iOS.
    await request(handle.app)
      .post("/tools/device-tool")
      .set("X-Argent-AI-Client", "codex")
      .send({ udid: "11111111-1111-1111-1111-111111111111" })
      .expect(200);

    const { recordChildInvocation } = vi.mocked(registry.invokeTool).mock.calls[0]![2] as {
      recordChildInvocation: (id: string, childArgs?: unknown) => () => void;
    };

    // A sub-tool that targets an Android device keeps the inherited ai_client but
    // is attributed to ITS OWN platform — not the parent's iOS. This is what lets
    // a flow-execute (no platform of its own) attribute each gesture correctly.
    recordChildInvocation("android-child", { udid: "emulator-5554" });
    expect(recordInvocation).toHaveBeenCalledWith("android-child", {
      ai_client: "codex",
      platform: "android",
    });

    // A child with no device arg falls back to the parent's platform.
    recordChildInvocation("no-device-child", { message: "hi" });
    expect(recordInvocation).toHaveBeenCalledWith("no-device-child", {
      ai_client: "codex",
      platform: "ios",
    });
  });

  it("does not forward a child recorder when there is no attribution to propagate", async () => {
    const recordInvocation = vi.fn(() => vi.fn());
    const registry = stubRegistry();
    handle.dispose();
    handle = createHttpApp(registry, { recordInvocation });

    // plain-tool has no capability and no AI-client header → no metadata at all,
    // so nothing is recorded and no child recorder is handed downstream.
    await request(handle.app).post("/tools/plain-tool").send({}).expect(200);

    expect(recordInvocation).not.toHaveBeenCalled();
    const opts = vi.mocked(registry.invokeTool).mock.calls[0]![2] as {
      recordChildInvocation?: unknown;
    };
    expect(opts.recordChildInvocation).toBeUndefined();
  });

  it("records the coarse `other` bucket for an unknown tool, never its name", async () => {
    let seenMeta: Record<string, unknown> | undefined;
    const recordInvocation = vi.fn((_id: string, meta: Record<string, unknown>) => {
      seenMeta = meta;
      return vi.fn();
    });
    handle.dispose();
    handle = createHttpApp(stubRegistry(), { recordInvocation });

    // A non-device tool with no platform context still records because the
    // coarse `other` slug is present. The name header is ignored entirely.
    await request(handle.app)
      .post("/tools/plain-tool")
      .set("X-Argent-AI-Client", "other")
      .set("X-Argent-AI-Client-Name", "some-new-tool")
      .send({})
      .expect(200);

    expect(seenMeta).toEqual({ ai_client: "other" });
  });

  it("drops unregistered AI client slugs", async () => {
    const recordInvocation = vi.fn(() => vi.fn());
    handle.dispose();
    handle = createHttpApp(stubRegistry(), { recordInvocation });

    // Unknown slug + unsafe name → nothing usable → no metadata → not recorded
    // for a non-device tool.
    await request(handle.app)
      .post("/tools/plain-tool")
      .set("X-Argent-AI-Client", "evil-client")
      .set("X-Argent-AI-Client-Name", "/Users/alice/secret")
      .send({})
      .expect(200);

    expect(recordInvocation).not.toHaveBeenCalled();
  });

  it("never records a client-name header, even for a recognized client", async () => {
    let seenMeta: Record<string, unknown> | undefined;
    const recordInvocation = vi.fn((_id: string, meta: Record<string, unknown>) => {
      seenMeta = meta;
      return vi.fn();
    });
    handle.dispose();
    handle = createHttpApp(stubRegistry(), { recordInvocation });

    // The raw client name is never recorded; only the coarse slug (and platform)
    // survive, regardless of what name header the MCP server forwarded.
    await request(handle.app)
      .post("/tools/device-tool")
      .set("X-Argent-AI-Client", "codex")
      .set("X-Argent-AI-Client-Name", "claude-code")
      .send({ udid: "11111111-1111-1111-1111-111111111111" })
      .expect(200);

    expect(seenMeta).toEqual({ platform: "ios", ai_client: "codex" });
  });

  it("drops a client name sent with no ai_client header", async () => {
    const recordInvocation = vi.fn(() => vi.fn());
    handle.dispose();
    handle = createHttpApp(stubRegistry(), { recordInvocation });

    // Name-only, no slug → nothing usable → no metadata → not recorded for a
    // non-device tool.
    await request(handle.app)
      .post("/tools/plain-tool")
      .set("X-Argent-AI-Client-Name", "some-new-tool")
      .send({})
      .expect(200);

    expect(recordInvocation).not.toHaveBeenCalled();
  });
});
