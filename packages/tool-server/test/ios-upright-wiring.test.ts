import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceInfo } from "@argent/registry";
import type { UiOrientation } from "../src/tools/describe/contract";

const tvOs = vi.hoisted(() => ({ udids: new Set<string>() }));
vi.mock("../src/utils/ios-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/ios-devices")>()),
  isTvOsSimulator: async (udid: string) => tvOs.udids.has(udid),
}));
vi.mock("../src/utils/check-deps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/check-deps")>()),
  ensureDeps: async () => {},
}));
vi.mock("../src/blueprints/native-devtools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/blueprints/native-devtools")>()),
  precheckNativeDevtools: async () => undefined,
}));

import {
  __resetUiOrientationForTests,
  forgetUiOrientation,
  forgettingUiOrientation,
  readUiOrientation,
  setUiOrientationSourceProvider,
} from "../src/utils/ios-ui-orientation";
import { adaptAxTree } from "../src/tools/ui-tree/ios";
import { queryViewHierarchyFor } from "../src/tools/native-devtools/macos-view-hierarchy";
import { uiScreenSize } from "../src/utils/ui-orientation";

const SIM = "405655A7-F5FD-4101-9168-148F0F0953D1";
const NATIVE = { width: 402, height: 874 };

const orientationMock = vi.fn<
  () => Promise<{
    interfaceOrientation?: UiOrientation;
    screenFrame?: { width: number; height: number };
  }>
>();

beforeEach(() => {
  __resetUiOrientationForTests();
  orientationMock.mockReset();
  tvOs.udids.clear();
  setUiOrientationSourceProvider(async () => ({ orientation: orientationMock }));
});

afterEach(() => {
  setUiOrientationSourceProvider(undefined);
  vi.useRealTimers();
});

describe("readUiOrientation, failures and turns", () => {
  it("reuses a failed read briefly, so a hung daemon holds one touch, not every one", async () => {
    vi.useFakeTimers();
    orientationMock.mockRejectedValue(new Error("hung"));
    expect((await readUiOrientation(SIM)).unknownReason).toContain("hung");
    expect((await readUiOrientation(SIM)).unknownReason).toContain("hung");
    expect(orientationMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_100);
    await readUiOrientation(SIM);
    expect(orientationMock).toHaveBeenCalledTimes(2);
  });

  it("does not hand a read started before a rotate to a touch after it", async () => {
    let answer!: (v: { interfaceOrientation: UiOrientation }) => void;
    orientationMock.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    const before = readUiOrientation(SIM);
    await vi.waitFor(() => expect(orientationMock).toHaveBeenCalledTimes(1));
    forgetUiOrientation(SIM);
    orientationMock.mockResolvedValueOnce({ interfaceOrientation: "portrait" });
    const after = readUiOrientation(SIM);
    answer({ interfaceOrientation: "landscapeRight" });
    expect((await before).orientation).toBe("landscapeRight");
    expect((await after).orientation).toBe("portrait");
  });

  it("asks nothing of an Apple TV simulator", async () => {
    tvOs.udids.add(SIM);
    expect(await readUiOrientation(SIM)).toEqual({});
    expect(orientationMock).not.toHaveBeenCalled();
  });

  it("forgets after a tool that changes the front app, also when it fails", async () => {
    orientationMock.mockResolvedValue({ interfaceOrientation: "landscapeLeft" });
    await readUiOrientation(SIM);
    const device = { id: SIM, platform: "ios", kind: "simulator" } as DeviceInfo;
    const launch = forgettingUiOrientation<unknown, unknown, never>({
      handler: async () => {
        throw new Error("not installed");
      },
    });
    await expect(launch.handler({}, {}, device)).rejects.toThrow("not installed");
    await readUiOrientation(SIM);
    expect(orientationMock).toHaveBeenCalledTimes(2);
  });
});

describe("uiScreenSize", () => {
  it("swaps the axes under a quarter turn only", () => {
    expect(uiScreenSize(NATIVE, "landscapeLeft")).toEqual({ width: 874, height: 402 });
    expect(uiScreenSize(NATIVE, "landscapeRight")).toEqual({ width: 874, height: 402 });
    expect(uiScreenSize(NATIVE, "portraitUpsideDown")).toBe(NATIVE);
    expect(uiScreenSize(NATIVE, undefined)).toBe(NATIVE);
  });
});

describe("adaptAxTree", () => {
  it("turns the frames and the screen by the orientation the daemon reported", () => {
    const tree = adaptAxTree({
      alertVisible: false,
      screenFrame: NATIVE,
      interfaceOrientation: "landscapeRight",
      truncated: false,
      nodes: [
        {
          index: 0,
          label: "Back",
          traits: ["button"],
          frame: { x: 0.9, y: 0.05, width: 0.05, height: 0.1 },
        },
      ],
    });
    expect(tree.screen).toEqual({ width: 874, height: 402 });
    // Native top-right is the UI's top-left.
    const frame = tree.roots[0]!.frame!;
    expect(frame.x).toBeCloseTo(0.05);
    expect(frame.y).toBeCloseTo(0.05);
    expect(frame.width).toBeCloseTo(0.1);
    expect(frame.height).toBeCloseTo(0.05);
  });

  it("leaves a daemon's tree native when it names no orientation", () => {
    const frame = { x: 0.9, y: 0.05, width: 0.05, height: 0.1 };
    const tree = adaptAxTree({
      alertVisible: false,
      screenFrame: NATIVE,
      truncated: false,
      nodes: [{ index: 0, frame }],
    });
    expect(tree.screen).toEqual(NATIVE);
    expect(tree.roots[0]!.frame).toEqual(frame);
  });
});

describe("queryViewHierarchyFor on a landscape iOS simulator", () => {
  it("looks up the native point under an upright one, and turns the view back", async () => {
    orientationMock.mockResolvedValue({
      interfaceOrientation: "landscapeRight",
      screenFrame: NATIVE,
    });
    const queryViewHierarchy = vi.fn(
      async (_bundleId: string, _method: string, _params: unknown) => ({
        view: { className: "UIButton", screenFrame: { x: 362, y: 40, width: 30, height: 60 } },
      })
    );
    const result = (await queryViewHierarchyFor(
      { nativeDevtools: { queryViewHierarchy } },
      { udid: SIM, bundleId: "com.example.app", x: 70, y: 25 },
      "native-view-at-point",
      "ViewHierarchy.viewAtPoint",
      null,
      (r: { view?: unknown }) => r
    )) as { view: { screenFrame: { x: number; y: number; width: number; height: number } } };
    // Upright (70, 25) on 874x402 is native (377, 70) on 402x874.
    const sent = queryViewHierarchy.mock.calls[0]![2] as { x: number; y: number };
    expect(sent.x).toBeCloseTo(377);
    expect(sent.y).toBeCloseTo(70);
    expect(result.view.screenFrame.x).toBeCloseTo(40);
    expect(result.view.screenFrame.y).toBeCloseTo(10);
    expect(result.view.screenFrame.width).toBeCloseTo(60);
    expect(result.view.screenFrame.height).toBeCloseTo(30);
  });
});
