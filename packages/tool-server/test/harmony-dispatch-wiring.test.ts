import { describe, it, expect, vi, beforeEach } from "vitest";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";

// The tools whose HarmonyOS support is a single entry in a `dispatchByPlatform`
// table. Every other harmony test reaches the backend by importing it and
// calling it directly, which exercises the backend and never the wiring: delete
// those entries and the rest of the suite stays green while each of these tools
// 501s on a real device. `describe` is the one that matters most — it is the
// platform's primary discovery tool — and it is wired as an inline handler
// rather than a `harmonyImpl`, so it is covered separately below.
//
// Only the leaf handler is stubbed, deliberately — the claim under test is
// dispatch, so a stub owning no device behaviour keeps these cases pinned to the
// wiring while the backends underneath them keep changing.
// Hoisted with the `vi.mock` factories that close over them — a plain top-level
// const is still in its temporal dead zone when the factory runs.
const { launchStub, restartStub, openUrlStub, keyboardStub, androidKeyboardStub, describeStub } =
  vi.hoisted(() => {
    // Full dispatch signature, so the device it was handed stays typed below.
    const stub = <T>(result: T) => ({
      handler: vi.fn(
        async (
          _services: unknown,
          _params: unknown,
          device: { platform: string; kind: string }
        ) => {
          void device;
          return result;
        }
      ),
    });
    return {
      launchStub: stub({ launched: true, bundleId: "com.huawei.hmos.calculator" }),
      restartStub: stub({ restarted: true, bundleId: "com.huawei.hmos.calculator" }),
      openUrlStub: stub({ opened: true, url: "https://example.com" }),
      keyboardStub: stub({ typed: "hi" }),
      // The android keyboard arm shells out to `adb` (an is-this-a-TV probe,
      // then `input text`) — reachable from this file's one non-harmony case,
      // so it is stubbed like the leaves above to keep every test here off the
      // host's adb and whatever device it points at.
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
import { openUrlTool } from "../src/tools/open-url";
import { createKeyboardTool } from "../src/tools/keyboard";
import { createDescribeTool } from "../src/tools/describe";

// `describe`'s harmony branch declares `requires: ["hdc"]`, so its preflight
// runs before the handler. Prime the probe rather than leave it to the host:
// `hdc` is present on a HarmonyOS dev machine and absent on a CI runner, and
// the claim under test here is dispatch either way.
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
      // Not `.toHaveBeenCalled()` alone: without the dispatch entry this rejects
      // with NotImplementedOnPlatformError, so asserting on the resolved value
      // pins that the branch both ran and produced the tool's result.
      await expect(tool().execute!({}, params as never)).resolves.toEqual(result);
      expect(impl.handler).toHaveBeenCalledOnce();
      expect(impl.handler.mock.calls[0]![2]).toMatchObject({
        platform: "harmony",
        kind: "device",
      });
    }
  );

  it("describe routes a harmony device to its harmony branch", async () => {
    // Without the dispatch entry this rejects with NotImplementedOnPlatform, so
    // resolving with the harmony source pins that the branch ran — and the
    // connect key pins that the device id was unwrapped on the way in.
    describeStub.mockClear();

    await expect(
      createDescribeTool(registry).execute!({}, { udid: HARMONY_UDID } as never)
    ).resolves.toMatchObject({ source: "harmony-uitest" });
    expect(describeStub).toHaveBeenCalledWith("025DEK236V035771");
  });

  it("does not reach a harmony branch for a device of another platform", async () => {
    // Guards the inverse mutation: a `harmony` entry wired onto the wrong arm of
    // the table would satisfy the cases above and silently hijack Android.
    //
    // `not.toHaveBeenCalled()` alone is equally satisfied by a dispatch that
    // threw or timed out before the harmony branch was reachable, so pin the
    // android arm positively first: resolving with the tool's own result proves
    // dispatch completed.
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
