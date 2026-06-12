import { describe, expect, it, expectTypeOf } from "vitest";
import type { ToolsClient, ToolMeta, ToolInvocationResult } from "@argent/tools-client";
import { createArgent, type ArgentClient, type ToolParams, type ToolResult } from "../src/index.js";

// Tool metadata mirroring the served GET /tools shape — device handles use the
// inputSchema properties to decide which device id keys to inject.
const FAKE_TOOLS: ToolMeta[] = [
  {
    name: "gesture-tap",
    description: "",
    inputSchema: { properties: { udid: {}, x: {}, y: {} } },
  },
  {
    name: "debugger-component-tree",
    description: "",
    inputSchema: { properties: { device_id: {}, port: {} } },
  },
  {
    name: "screenshot-diff",
    description: "",
    inputSchema: { properties: { udid: {}, outputDir: {} } }, // strict schema: udid only
  },
  { name: "update-argent", description: "", inputSchema: { properties: {} } },
  { name: "list-devices", description: "", inputSchema: { properties: {} } },
];

function fakeClient(
  calls: Array<{ name: string; args: unknown }>,
  results: Record<string, unknown> = {}
): ToolsClient {
  return {
    fetchTools: async (): Promise<ToolMeta[]> => FAKE_TOOLS,
    fetchTool: async () => null,
    callTool: async (name: string, args: unknown): Promise<ToolInvocationResult> => {
      calls.push({ name, args });
      return { data: results[name] ?? { ok: true, echo: args } };
    },
    baseUrl: async () => ({ url: "http://127.0.0.1:0", token: "" }),
  };
}

const BOOTED_IOS = { platform: "ios", udid: "IOS-1", state: "Booted", name: "iPhone" };
const SHUTDOWN_IOS = { platform: "ios", udid: "IOS-2", state: "Shutdown", name: "iPhone" };
const READY_ANDROID = { platform: "android", serial: "emulator-5554", state: "device" };

describe("createArgent", () => {
  it("maps camelCase methods to kebab-case tool ids", async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const sdk = createArgent({ client: fakeClient(calls) });

    await sdk.gestureTap({ udid: "U", x: 0.5, y: 0.5 });
    await sdk.listDevices();
    await sdk.debuggerComponentTree({ device_id: "U" });

    expect(calls.map((c) => c.name)).toEqual([
      "gesture-tap",
      "list-devices",
      "debugger-component-tree",
    ]);
  });

  it("routes aliases to their tools", async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const sdk = createArgent({ client: fakeClient(calls) });

    await sdk.tap({ udid: "U", x: 0.1, y: 0.2 });
    await sdk.swipe({ udid: "U", fromX: 0.5, fromY: 0.8, toX: 0.5, toY: 0.2 });

    expect(calls.map((c) => c.name)).toEqual(["gesture-tap", "gesture-swipe"]);
    expect(calls[0]!.args).toEqual({ udid: "U", x: 0.1, y: 0.2 });
  });

  it("supports call/invoke/callUnchecked with the same dispatch", async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const sdk = createArgent({ client: fakeClient(calls) });

    const data = await sdk.call("gesture-tap", { udid: "U", x: 0, y: 0 });
    expect(data).toMatchObject({ ok: true });

    const envelope = await sdk.invoke("gesture-tap", { udid: "U", x: 0, y: 0 });
    expect(envelope.data).toMatchObject({ ok: true });
    expect(envelope.images).toEqual([]);

    const unchecked = await sdk.callUnchecked("some-future-tool", { a: 1 });
    expect(unchecked.data).toMatchObject({ ok: true });
    expect(calls.map((c) => c.name)).toEqual(["gesture-tap", "gesture-tap", "some-future-tool"]);
  });

  it("is not thenable (safe to `await createArgent()`)", async () => {
    const sdk = createArgent({ client: fakeClient([]) });
    expect((sdk as unknown as Record<string, unknown>)["then"]).toBeUndefined();
    const awaited = await Promise.resolve(sdk);
    expect(awaited).toBe(sdk);
  });

  it("lists tools through the client", async () => {
    const sdk = createArgent({ client: fakeClient([]) });
    const tools = await sdk.listTools();
    expect(tools.map((t) => t.name)).toEqual(FAKE_TOOLS.map((t) => t.name));
  });

  it("does not fabricate methods for non-method-shaped properties", () => {
    const sdk = createArgent({ client: fakeClient([]) }) as unknown as Record<string, unknown>;
    expect(sdk["$$typeof"]).toBeUndefined();
    expect(sdk["Symbol"]).toBeUndefined();
  });
});

describe("argent.device()", () => {
  it("injects only the device id keys each tool's schema declares", async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const device = createArgent({ client: fakeClient(calls) }).device("UDID-1");

    await device.tap({ x: 0.1, y: 0.2 });
    await device.debuggerComponentTree();
    await device.screenshotDiff({ outputDir: "/tmp/diff" });
    await device.updateArgent();

    expect(calls.map((c) => c.args)).toEqual([
      { udid: "UDID-1", x: 0.1, y: 0.2 },
      { device_id: "UDID-1" },
      { udid: "UDID-1", outputDir: "/tmp/diff" }, // strict schema: no device_id injected
      {}, // no device keys in schema: nothing injected
    ]);
  });

  it("lets explicit caller params override the bound id", async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const device = createArgent({ client: fakeClient(calls) }).device("UDID-1");
    await device.callUnchecked("gesture-tap", { udid: "OTHER", x: 0, y: 0 });
    expect(calls[0]!.args).toMatchObject({ udid: "OTHER" });
  });

  it("auto-detects the single booted device lazily and caches it", async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const device = createArgent({
      client: fakeClient(calls, {
        "list-devices": { devices: [BOOTED_IOS, SHUTDOWN_IOS], avds: [] },
      }),
    }).device();

    await device.tap({ x: 0, y: 0 });
    await device.tap({ x: 1, y: 1 });

    expect(calls.map((c) => c.name)).toEqual(["list-devices", "gesture-tap", "gesture-tap"]);
    expect(calls[1]!.args).toMatchObject({ udid: "IOS-1" });
    await expect(device.deviceId()).resolves.toBe("IOS-1");
  });

  it("detects a ready Android emulator by serial", async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const device = createArgent({
      client: fakeClient(calls, {
        "list-devices": { devices: [SHUTDOWN_IOS, READY_ANDROID], avds: [] },
      }),
    }).device();
    await expect(device.deviceId()).resolves.toBe("emulator-5554");
  });

  it("throws a descriptive error when zero or several devices are booted", async () => {
    const none = createArgent({
      client: fakeClient([], { "list-devices": { devices: [SHUTDOWN_IOS], avds: [] } }),
    }).device();
    await expect(none.tap({ x: 0, y: 0 })).rejects.toThrow(/no booted simulator\/emulator/);

    const many = createArgent({
      client: fakeClient([], {
        "list-devices": { devices: [BOOTED_IOS, READY_ANDROID], avds: [] },
      }),
    }).device();
    await expect(many.tap({ x: 0, y: 0 })).rejects.toThrow(
      /2 booted devices.*IOS-1.*emulator-5554/
    );
  });

  it("does not trigger auto-detection for tools without device params", async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const device = createArgent({ client: fakeClient(calls) }).device();
    await device.updateArgent();
    expect(calls.map((c) => c.name)).toEqual(["update-argent"]);
  });
});

describe("SDK types (compile-time)", () => {
  it("derives param and result types from the server's zod schemas", () => {
    expectTypeOf<ToolParams<"gesture-tap">>().toEqualTypeOf<{
      udid: string;
      x: number;
      y: number;
    }>();
    expectTypeOf<ToolResult<"gesture-tap">>().toEqualTypeOf<{
      tapped: boolean;
      timestampMs: number;
    }>();

    const sdk = {} as ArgentClient;
    expectTypeOf(sdk.gestureTap).parameters.toEqualTypeOf<
      [{ udid: string; x: number; y: number }]
    >();
    expectTypeOf(sdk.tap).returns.resolves.toEqualTypeOf<{
      tapped: boolean;
      timestampMs: number;
    }>();
    // void-params tool gets a no-arg method
    expectTypeOf(sdk.updateArgent).parameters.toEqualTypeOf<[]>();
  });

  it("drops device id params from device-bound methods", () => {
    const device = {} as import("../src/index.js").ArgentDevice;
    // udid is gone from tap...
    expectTypeOf(device.tap).parameters.toEqualTypeOf<[{ x: number; y: number }]>();
    // ...and screenshot's remaining fields are all optional → no-arg call allowed
    expectTypeOf(device.screenshot).toBeCallableWith();
    expectTypeOf(device.screenshot).toBeCallableWith({ scale: 1.0 });
    // device_id-family tools lose their key too
    expectTypeOf(device.debuggerComponentTree).toBeCallableWith({ port: 8081 });
    // void-params tools stay no-arg
    expectTypeOf(device.updateArgent).parameters.toEqualTypeOf<[]>();
    expectTypeOf(device.deviceId).returns.resolves.toBeString();
  });
});
