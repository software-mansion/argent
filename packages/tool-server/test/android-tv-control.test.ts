import { describe, it, expect, vi, beforeEach } from "vitest";

// The Android TV backend drives the device entirely through `adb` helpers.
// Mock them so the factory + api run without a real device.
vi.mock("../src/utils/adb", () => ({
  adbShell: vi.fn(async () => ""),
  adbExecOutBinary: vi.fn(async () => Buffer.from("")),
  shellQuote: (v: string) => `'${v.replace(/'/g, "'\\''")}'`,
  getAndroidRuntimeKind: vi.fn(async () => "tv" as const),
}));

import {
  androidTvControlBlueprint,
  androidTvControlRef,
} from "../src/blueprints/android-tv-control";
import type { TvControlApi } from "../src/blueprints/tv-control-types";
import { adbShell, adbExecOutBinary, getAndroidRuntimeKind } from "../src/utils/adb";

const mockShell = vi.mocked(adbShell);
const mockExecOut = vi.mocked(adbExecOutBinary);
const mockRuntimeKind = vi.mocked(getAndroidRuntimeKind);

const SERIAL = "emulator-5556";
const device = { id: SERIAL, platform: "android" as const, kind: "emulator" as const };

async function makeApi(): Promise<TvControlApi> {
  const instance = await androidTvControlBlueprint.factory({}, device, { device });
  return instance.api;
}

// Build a uiautomator dump with the given focusable nodes. `focusedIndex` marks
// which one carries focused="true".
function dump(
  nodes: Array<{ label: string; bounds: string; cls?: string; text?: string }>,
  focusedIndex: number
): Buffer {
  const inner = nodes
    .map((n, i) => {
      const cls = n.cls ?? "android.widget.TextView";
      const focused = i === focusedIndex ? "true" : "false";
      const text = n.text ?? "";
      return `<node class="${cls}" content-desc="${n.label}" text="${text}" bounds="${n.bounds}" focusable="true" focused="${focused}" enabled="true" package="com.example.tv" />`;
    })
    .join("");
  return Buffer.from(`<?xml version='1.0'?><hierarchy rotation="0">${inner}</hierarchy>`);
}

beforeEach(() => {
  mockShell.mockReset();
  mockShell.mockResolvedValue("");
  mockExecOut.mockReset();
  mockRuntimeKind.mockReset();
  mockRuntimeKind.mockResolvedValue("tv");
});

describe("android-tv-control — ref + factory gating", () => {
  it("builds a namespaced ref", () => {
    const ref = androidTvControlRef(device);
    expect(ref.urn).toBe(`AndroidTvControl:${SERIAL}`);
    expect(ref.options.device).toBe(device);
  });

  it("rejects a non-TV (mobile) device", async () => {
    mockRuntimeKind.mockResolvedValue("mobile");
    await expect(makeApi()).rejects.toThrow(/Android-TV-only/);
  });

  it("rejects an offline / unknown serial", async () => {
    mockRuntimeKind.mockResolvedValue(undefined);
    await expect(makeApi()).rejects.toThrow(/no ready Android device/);
  });
});

describe("android-tv-control — navigate maps to keyevents", () => {
  it.each([
    ["up", 19],
    ["down", 20],
    ["left", 21],
    ["right", 22],
    ["select", 23],
    ["back", 4],
    ["home", 3],
    ["menu", 82],
    ["playPause", 85],
    ["rewind", 89],
    ["fastForward", 90],
    ["next", 87],
    ["previous", 88],
    ["volumeUp", 24],
    ["volumeDown", 25],
    ["mute", 164],
  ] as const)("sends %s as keyevent %i", async (direction, code) => {
    const api = await makeApi();
    await api.navigate(direction);
    expect(mockShell).toHaveBeenCalledWith(SERIAL, `input keyevent ${code}`, expect.anything());
  });
});

describe("android-tv-control — type", () => {
  it("sends spaces as KEYCODE_SPACE keyevents, not %s", async () => {
    const api = await makeApi();
    await api.type("hello world");
    const calls = mockShell.mock.calls.filter((c: unknown[]) => c[0] === SERIAL).map((c) => c[1]);
    expect(calls).toEqual(["input text 'hello'", "input keyevent 62", "input text 'world'"]);
    // The fragile "%s" space encoding is gone.
    expect(calls.some((c: string) => c.includes("%s"))).toBe(false);
  });

  it("preserves a literal %s in user text (round-trip safe)", async () => {
    const api = await makeApi();
    await api.type("50%save");
    const calls = mockShell.mock.calls.filter((c: unknown[]) => c[0] === SERIAL).map((c) => c[1]);
    // Split after the '%' so the device never collapses an adjacent "%s" into a
    // space: "%" and "save" arrive in separate `input text` calls, verbatim.
    expect(calls).toEqual(["input text '50%'", "input text 'save'"]);
    // No keyevent — there is no real space in the input.
    expect(calls.some((c: string) => c.includes("keyevent"))).toBe(false);
  });

  it("is a no-op for empty text", async () => {
    const api = await makeApi();
    await api.type("");
    // Only the factory's runtime-kind probe ran via getAndroidRuntimeKind; no
    // `input text` shell-out.
    expect(mockShell).not.toHaveBeenCalledWith(
      SERIAL,
      expect.stringContaining("input text"),
      expect.anything()
    );
  });
});

describe("android-tv-control — describe", () => {
  it("projects the focused + focusable nodes from the uiautomator dump", async () => {
    mockExecOut.mockResolvedValue(
      dump(
        [
          { label: "Home", bounds: "[0,0][100,50]" },
          { label: "Search", bounds: "[100,0][200,50]", cls: "android.widget.Button" },
        ],
        0
      )
    );
    const api = await makeApi();
    const res = await api.describe();
    expect(res.bundleId).toBe("com.example.tv");
    expect(res.focused?.label).toBe("Home");
    expect(res.focusable).toHaveLength(2);
    expect(res.focusable[1]?.label).toBe("Search");
    expect(res.focusable[1]?.traits).toContain("button");
  });
});

describe("android-tv-control — recycleAx is a no-op", () => {
  it("resolves without touching adb", async () => {
    const api = await makeApi();
    mockShell.mockClear();
    await expect(api.recycleAx()).resolves.toBeUndefined();
    expect(mockShell).not.toHaveBeenCalled();
  });
});
