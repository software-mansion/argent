import { beforeEach, describe, expect, it, vi } from "vitest";
import { FAILURE_CODES, getFailureSignal, Registry } from "@argent/registry";
import { InvalidToolInputError, UnsupportedOperationError } from "../src/utils/capability";

vi.mock("../src/utils/harmony-flag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/harmony-flag")>()),
  isHarmonyEnabled: () => true,
}));

vi.mock("../src/utils/ios-device/app-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/ios-device/app-session")>()),
  requireCurrentIosDeviceApp: vi.fn(() => "com.example.app"),
}));

const { runnerTypeText } = vi.hoisted(() => ({
  runnerTypeText: vi.fn(async () => ({ reactivated: false })),
}));
vi.mock("../src/utils/ios-device/runner-commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/ios-device/runner-commands")>()),
  typeText: runnerTypeText,
}));

const { macosPressKey, resolveMacosApp } = vi.hoisted(() => ({
  macosPressKey: vi.fn(async () => {}),
  resolveMacosApp: vi.fn(async () => ({})),
}));
vi.mock("../src/utils/macos-input", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/macos-input")>()),
  macosPressKey,
  resolveMacosApp,
}));

const { adbShell, isAndroidTv } = vi.hoisted(() => ({
  adbShell: vi.fn(async (_serial: string, _cmd: string, _opts?: unknown): Promise<string> => ""),
  isAndroidTv: vi.fn(async (_serial: string): Promise<boolean> => false),
}));
vi.mock("../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/adb")>()),
  adbShell,
  isAndroidTv,
}));

vi.mock("../src/utils/check-deps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/check-deps")>()),
  ensureDeps: vi.fn(async () => {}),
}));

const { isTvOsSimulator } = vi.hoisted(() => ({
  isTvOsSimulator: vi.fn(async () => false),
}));
vi.mock("../src/utils/ios-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/ios-devices")>()),
  isTvOsSimulator,
}));

const { isRemoteTvOsSimulator } = vi.hoisted(() => ({
  isRemoteTvOsSimulator: vi.fn(async () => false),
}));
vi.mock("../src/utils/sim-remote", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/sim-remote")>()),
  isRemoteTvOsSimulator,
}));

vi.mock("../src/tools/fill/ios", () => ({
  fillIos: vi.fn(async () => ({ verified: true })),
}));

vi.mock("../src/tools/fill/android", () => ({
  fillAndroid: vi.fn(async () => ({ verified: true })),
}));

vi.mock("../src/tools/fill/chromium", () => ({
  fillChromium: vi.fn(async () => ({ verified: true })),
}));

vi.mock("../src/tools/fill/keys", () => ({
  fillByDeviceKeys: vi.fn(async () => ({ reactivated: false })),
}));

import { fillIos } from "../src/tools/fill/ios";
import { fillAndroid } from "../src/tools/fill/android";
import { fillChromium } from "../src/tools/fill/chromium";
import { fillByDeviceKeys } from "../src/tools/fill/keys";
import { createKeyboardTool } from "../src/tools/keyboard";
import { makeMacosImpl } from "../src/tools/keyboard/platforms/macos";
import { resolveDevice } from "../src/utils/device-info";

const IOS = "809A848B-1671-4A72-B9C9-B1683D95973E";
const IOS_DEVICE = "00008110-000978540290401E";
const ANDROID = "emulator-5554";
const CHROMIUM = "chromium-cdp-9222";
const VEGA = "amazon-4a27df03c9777152";
const HARMONY = "harmony-025DEK236V035771";
const MACOS = "macos-app-com.example.App";

const pressKey = vi.fn((_direction: "Down" | "Up", _keyCode: number) => {});
const dispatchKeyEvent = vi.fn(async (_event: { type: string; key?: string }) => {});
const getHierarchy = vi.fn(async (_opts: unknown) => ({ xml: "" }));

function focusedAndroidField(text: string): string {
  return (
    `<hierarchy><node class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">` +
    `<node text="${text}" class="android.widget.EditText" focused="true" bounds="[0,100][1080,200]" />` +
    `</node></hierarchy>`
  );
}

function registry(): Registry {
  const r = new Registry();
  vi.spyOn(r, "resolveService").mockImplementation(async (urn: string) => {
    if (urn.startsWith("AXService:")) return { degraded: true } as never;
    if (urn.startsWith("AndroidDevtools:")) return { getHierarchy } as never;
    return { pressKey, dispatchKeyEvent } as never;
  });
  return r;
}

describe("keyboard — clear option", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isAndroidTv.mockResolvedValue(false);
    isTvOsSimulator.mockResolvedValue(false);
    isRemoteTvOsSimulator.mockResolvedValue(false);
  });

  it("clears alone on iOS, Android, and Chromium without typing keys", async () => {
    const tool = createKeyboardTool(registry());

    await expect(tool.execute({}, { udid: IOS, clear: true })).resolves.toEqual({
      typed: "",
      keys: 0,
      cleared: true,
    });
    expect(fillIos).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: IOS }),
      ""
    );
    expect(pressKey).not.toHaveBeenCalled();

    await expect(tool.execute({}, { udid: ANDROID, clear: true })).resolves.toEqual({
      typed: "",
      keys: 0,
      cleared: true,
    });
    expect(fillAndroid).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: ANDROID }),
      ""
    );
    expect(adbShell).not.toHaveBeenCalled();

    await expect(tool.execute({}, { udid: CHROMIUM, clear: true })).resolves.toEqual({
      typed: "",
      keys: 0,
      cleared: true,
    });
    expect(fillChromium).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: CHROMIUM }),
      ""
    );
    expect(dispatchKeyEvent).not.toHaveBeenCalled();
  });

  it("clears before typing text on iOS, Android, and Chromium", async () => {
    const tool = createKeyboardTool(registry());

    const iosRes = await tool.execute({}, { udid: IOS, clear: true, text: "hi", delayMs: 0 });
    expect(iosRes).toEqual({ typed: "hi", keys: 2, cleared: true });
    expect(fillIos).toHaveBeenCalledTimes(1);
    expect(pressKey.mock.calls.filter((c) => c[0] === "Down")).toHaveLength(2);

    getHierarchy
      .mockResolvedValueOnce({ xml: focusedAndroidField("") })
      .mockResolvedValueOnce({ xml: focusedAndroidField("hi") });
    const androidRes = await tool.execute({}, { udid: ANDROID, clear: true, text: "hi" });
    expect(androidRes).toEqual({ typed: "hi", keys: 2, cleared: true, verified: true });
    expect(fillAndroid).toHaveBeenCalledTimes(1);
    expect(adbShell).toHaveBeenCalledWith(ANDROID, "input text 'hi'", expect.any(Object));
    // The read-back's "before" is the cleared field, not the old contents.
    expect(vi.mocked(fillAndroid).mock.invocationCallOrder[0]).toBeLessThan(
      getHierarchy.mock.invocationCallOrder[0]!
    );

    const chromiumRes = await tool.execute(
      {},
      { udid: CHROMIUM, clear: true, text: "hi", delayMs: 0 }
    );
    expect(chromiumRes).toEqual({ typed: "hi", keys: 2, cleared: true });
    expect(fillChromium).toHaveBeenCalledTimes(1);
    expect(dispatchKeyEvent.mock.calls.filter((c) => c[0].type === "char")).toHaveLength(2);
  });

  it("validates untypeable text before clearing so failed calls leave the field intact", async () => {
    const tool = createKeyboardTool(registry());

    await expect(
      tool.execute({}, { udid: ANDROID, clear: true, text: "bad\nline" })
    ).rejects.toThrow(InvalidToolInputError);
    expect(fillAndroid).not.toHaveBeenCalled();

    await expect(
      tool.execute({}, { udid: IOS, clear: true, text: "emoji🔥", delayMs: 0 })
    ).rejects.toThrow(InvalidToolInputError);
    expect(fillIos).not.toHaveBeenCalled();

    await expect(
      tool.execute({}, { udid: CHROMIUM, clear: true, text: "emoji🔥", delayMs: 0 })
    ).rejects.toThrow(InvalidToolInputError);
    expect(fillChromium).not.toHaveBeenCalled();
  });

  it("rejects `clear: true` combined with `key` without touching any device", async () => {
    const tool = createKeyboardTool(registry());
    await expect(tool.execute({}, { udid: ANDROID, clear: true, key: "enter" })).rejects.toThrow(
      InvalidToolInputError
    );
    expect(fillAndroid).not.toHaveBeenCalled();
    expect(adbShell).not.toHaveBeenCalled();
  });

  it("rejects `clear: true` on Apple TV, remote tvOS, Android TV, Vega, and HarmonyOS", async () => {
    const tool = createKeyboardTool(registry());

    isTvOsSimulator.mockResolvedValueOnce(true);
    await expect(tool.execute({}, { udid: IOS, clear: true })).rejects.toThrow(
      UnsupportedOperationError
    );

    isRemoteTvOsSimulator.mockResolvedValueOnce(true);
    await expect(tool.execute({}, { udid: `remote:${IOS}`, clear: true })).rejects.toThrow(
      UnsupportedOperationError
    );

    isAndroidTv.mockResolvedValue(true);
    await expect(tool.execute({}, { udid: ANDROID, clear: true })).rejects.toThrow(
      UnsupportedOperationError
    );

    await expect(tool.execute({}, { udid: VEGA, clear: true })).rejects.toThrow(
      UnsupportedOperationError
    );

    await expect(tool.execute({}, { udid: HARMONY, clear: true })).rejects.toThrow(
      UnsupportedOperationError
    );

    const macosImpl = makeMacosImpl(registry());
    await expect(
      macosImpl.handler({}, { udid: MACOS, clear: true }, resolveDevice(MACOS))
    ).rejects.toThrow(UnsupportedOperationError);
    expect(resolveMacosApp).not.toHaveBeenCalled();
    expect(macosPressKey).not.toHaveBeenCalled();
  });

  it("omits `cleared` and preserves `reactivated` on physical iOS", async () => {
    const tool = createKeyboardTool(registry());

    vi.mocked(fillByDeviceKeys).mockResolvedValueOnce({ reactivated: false });
    await expect(tool.execute({}, { udid: IOS_DEVICE, clear: true })).resolves.toEqual({
      typed: "",
      keys: 0,
    });

    vi.mocked(fillByDeviceKeys).mockResolvedValueOnce({ reactivated: true });
    await expect(tool.execute({}, { udid: IOS_DEVICE, clear: true })).resolves.toEqual({
      typed: "",
      keys: 0,
      reactivated: true,
    });

    vi.mocked(fillByDeviceKeys).mockResolvedValueOnce({ reactivated: true });
    runnerTypeText.mockResolvedValueOnce({ reactivated: false });
    await expect(tool.execute({}, { udid: IOS_DEVICE, clear: true, text: "hi" })).resolves.toEqual({
      typed: "hi",
      keys: 2,
      reactivated: true,
    });
  });

  it("propagates clear failure before typing text and rewrites hidden `fill` wording", async () => {
    vi.mocked(fillAndroid).mockRejectedValueOnce(
      new InvalidToolInputError("Tap the text field first, then call fill again.", {
        error_code: FAILURE_CODES.FILL_NO_FOCUSED_FIELD,
      })
    );
    const tool = createKeyboardTool(registry());
    const err = await tool
      .execute({}, { udid: ANDROID, clear: true, text: "hi" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    if (!(err instanceof Error)) throw new Error("expected error");
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FILL_NO_FOCUSED_FIELD);
    expect(err.message).toContain("call keyboard again");
    expect(err.message).not.toMatch(/\bfill\b/);
    expect(adbShell).not.toHaveBeenCalled();
  });
});
