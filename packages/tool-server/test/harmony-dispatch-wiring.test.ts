import { describe, it, expect, vi, beforeEach } from "vitest";

// HarmonyOS is behind the `harmonyos` flag; these cases drive it with the flag on.
vi.mock("../src/utils/harmony-flag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/harmony-flag")>()),
  isHarmonyEnabled: () => true,
}));
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";

// Other harmony tests call the backends directly, so they never exercise the
// `dispatchByPlatform` entries; only the leaf handlers are stubbed here.
const {
  launchStub,
  restartStub,
  reinstallStub,
  openUrlStub,
  keyboardStub,
  androidKeyboardStub,
  describeStub,
} = vi.hoisted(() => {
  const stub = <T>(result: T) => ({
    handler: vi.fn(
      async (_services: unknown, _params: unknown, device: { platform: string; kind: string }) => {
        void device;
        return result;
      }
    ),
  });
  return {
    launchStub: stub({ launched: true, bundleId: "com.huawei.hmos.calculator" }),
    restartStub: stub({ restarted: true, bundleId: "com.huawei.hmos.calculator" }),
    reinstallStub: stub({ reinstalled: true, bundleId: "com.example.hello" }),
    openUrlStub: stub({ opened: true, url: "https://example.com" }),
    keyboardStub: stub({ typed: "hi" }),
    // Keeps the one non-harmony case off the host's adb.
    androidKeyboardStub: stub({ typed: "hi", keys: 2 }),
    // `describe` dispatches to a bare function, not a `{ handler }` impl.
    describeStub: vi.fn(async (_connectKey: string) => ({
      tree: {
        role: "Screen",
        frame: { x: 0, y: 0, width: 1, height: 1 },
        pixelBounds: null,
        children: [],
      },
      source: "harmony-uitest" as const,
    })),
  };
});

vi.mock("../src/tools/launch-app/platforms/harmony", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  harmonyImpl: launchStub,
}));
vi.mock("../src/tools/restart-app/platforms/harmony", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  harmonyImpl: restartStub,
}));
vi.mock("../src/tools/reinstall-app/platforms/harmony", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  harmonyImpl: reinstallStub,
}));
vi.mock("../src/tools/open-url/platforms/harmony", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  harmonyImpl: openUrlStub,
}));
vi.mock("../src/tools/keyboard/platforms/harmony", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  harmonyImpl: keyboardStub,
}));
vi.mock("../src/tools/keyboard/platforms/android", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  makeAndroidImpl: () => androidKeyboardStub,
}));
vi.mock("../src/tools/describe/platforms/harmony", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  describeHarmony: (...a: [string]) => describeStub(...a),
}));

import { createLaunchAppTool } from "../src/tools/launch-app";
import { createRestartAppTool } from "../src/tools/restart-app";
import { reinstallAppTool } from "../src/tools/reinstall-app";
import { openUrlTool } from "../src/tools/open-url";
import { createKeyboardTool } from "../src/tools/keyboard";
import { createDescribeTool } from "../src/tools/describe";

// `hdc` is absent on CI runners.
beforeEach(() => {
  __resetDepCacheForTests();
  __primeDepCacheForTests(["hdc"]);
});

const HARMONY_UDID = "harmony-025DEK236V035771";
const registry = { resolveService: vi.fn(async () => ({})) } as never;

const cases = [
  {
    name: "launch-app",
    stub: launchStub,
    tool: () => createLaunchAppTool(registry),
    params: { udid: HARMONY_UDID, bundleId: "com.huawei.hmos.calculator" },
    result: { launched: true, bundleId: "com.huawei.hmos.calculator" },
  },
  {
    name: "restart-app",
    stub: restartStub,
    tool: () => createRestartAppTool(registry),
    params: { udid: HARMONY_UDID, bundleId: "com.huawei.hmos.calculator" },
    result: { restarted: true, bundleId: "com.huawei.hmos.calculator" },
  },
  {
    name: "reinstall-app",
    stub: reinstallStub,
    tool: () => reinstallAppTool,
    params: { udid: HARMONY_UDID, bundleId: "com.example.hello", appPath: "/tmp/hello.hap" },
    result: { reinstalled: true, bundleId: "com.example.hello" },
  },
  {
    name: "open-url",
    stub: openUrlStub,
    tool: () => openUrlTool,
    params: { udid: HARMONY_UDID, url: "https://example.com" },
    result: { opened: true, url: "https://example.com" },
  },
  {
    name: "keyboard",
    stub: keyboardStub,
    tool: () => createKeyboardTool(registry),
    params: { udid: HARMONY_UDID, text: "hi" },
    result: { typed: "hi" },
  },
] as const;

describe("HarmonyOS dispatch wiring", () => {
  it.each(cases)(
    "$name routes a harmony device to its harmony branch",
    async ({ stub: impl, tool, params, result }) => {
      impl.handler.mockClear();
      await expect(tool().execute!({}, params as never)).resolves.toEqual(result);
      expect(impl.handler).toHaveBeenCalledOnce();
      expect(impl.handler.mock.calls[0]![2]).toMatchObject({
        platform: "harmony",
        kind: "device",
      });
    }
  );

  it("describe routes a harmony device to its harmony branch", async () => {
    describeStub.mockClear();

    await expect(
      createDescribeTool(registry).execute!({}, { udid: HARMONY_UDID } as never)
    ).resolves.toMatchObject({ source: "harmony-uitest" });
    expect(describeStub).toHaveBeenCalledWith("025DEK236V035771");
  });

  it("does not reach a harmony branch for a device of another platform", async () => {
    // A `harmony` entry wired onto the Android arm would pass the cases above.
    keyboardStub.handler.mockClear();
    androidKeyboardStub.handler.mockClear();
    await expect(
      createKeyboardTool(registry).execute!({}, { udid: "emulator-5554", text: "hi" } as never)
    ).resolves.toEqual({ typed: "hi", keys: 2 });
    expect(androidKeyboardStub.handler).toHaveBeenCalledOnce();
    expect(androidKeyboardStub.handler.mock.calls[0]![2]).toMatchObject({
      platform: "android",
      kind: "emulator",
    });
    expect(keyboardStub.handler).not.toHaveBeenCalled();
  });
});
