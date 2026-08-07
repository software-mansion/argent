import { beforeEach, describe, expect, it, vi } from "vitest";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import { isFlagEnabled } from "@argent/configuration-core";

vi.mock("@argent/configuration-core", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isFlagEnabled: vi.fn(),
}));

import { simulatorServerRef } from "../src/blueprints/simulator-server";
import { gestureTapTool } from "../src/tools/gesture-tap";
import { gestureSwipeTool } from "../src/tools/gesture-swipe";
import { screenshotDiffTool } from "../src/tools/screenshot-diff";
import { resolveDevice } from "../src/utils/device-info";
import { InvalidToolInputError } from "../src/utils/capability";

/**
 * `simulatorServerRef` is where physical iOS is opted into. Its own doc argues
 * the placement is load-bearing — the registry hands back a RUNNING instance
 * without re-entering the factory, so a factory-only gate would keep serving
 * taps and screenshots for the life of the server after `argent disable
 * physical-ios-devices`. Nothing exercised it: every other flag-gate case calls
 * `assertPhysicalIosEnabled()` directly, or goes through `launch-app`, which
 * calls it itself. Deleting the line from `simulatorServerRef` left the whole
 * suite green, taking the opt-in off screenshot, gesture-*, keyboard, button,
 * rotate, describe, screen-recording and boot-device at once.
 */
const PHYSICAL_UDID = "00008120-000E6D0C0ABBA01E";
const SIM_UDID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";

const mockFlag = vi.mocked(isFlagEnabled);

beforeEach(() => {
  mockFlag.mockReset();
});

describe("the physical-iOS opt-in is enforced where every CoreDevice tool resolves", () => {
  it("refuses to build a ref for a physical iPhone while the flag is off", () => {
    mockFlag.mockReturnValue(false);
    let thrown: unknown;
    try {
      simulatorServerRef(resolveDevice(PHYSICAL_UDID));
    } catch (err) {
      thrown = err;
    }
    expect(thrown, "a physical iPhone must not resolve with the flag off").toBeInstanceOf(
      InvalidToolInputError
    );
    expect(getFailureSignal(thrown as Error)?.error_code).toBe(
      FAILURE_CODES.CORE_DEVICE_FLAG_DISABLED
    );
    expect((thrown as Error).message).toMatch(/argent enable physical-ios-devices/);
  });

  it("builds it once the flag is on", () => {
    mockFlag.mockReturnValue(true);
    expect(simulatorServerRef(resolveDevice(PHYSICAL_UDID)).urn).toContain(PHYSICAL_UDID);
  });

  it("never consults the flag for a simulator", () => {
    // The other direction: a gate that rejected on shape alone would take iOS
    // simulators down with it, and the sweep above would stay green.
    mockFlag.mockReturnValue(false);
    expect(() => simulatorServerRef(resolveDevice(SIM_UDID))).not.toThrow();
    expect(mockFlag).not.toHaveBeenCalled();
  });

  it("re-reads the flag on every call, so disabling mid-session takes effect", () => {
    // The reason the check sits in the ref builder rather than the factory: the
    // registry caches a running instance and never re-enters the factory, so a
    // factory-only gate would keep driving the phone after `argent disable`.
    mockFlag.mockReturnValue(true);
    expect(() => simulatorServerRef(resolveDevice(PHYSICAL_UDID))).not.toThrow();
    mockFlag.mockReturnValue(false);
    expect(() => simulatorServerRef(resolveDevice(PHYSICAL_UDID))).toThrow(InvalidToolInputError);
  });

  it("stops the tools that reach the CoreDevice session through it", () => {
    // Spot-checks across three distinct services() shapes — a gesture, a gesture
    // with its own extra params, and a tool that resolves the ref for a
    // host-side pixel job — so a regression that only rewires one of them still
    // trips here.
    mockFlag.mockReturnValue(false);
    const cases: Array<[string, () => unknown]> = [
      ["gesture-tap", () => gestureTapTool.services!({ udid: PHYSICAL_UDID, x: 0.5, y: 0.5 })],
      [
        "gesture-swipe",
        () =>
          gestureSwipeTool.services!({
            udid: PHYSICAL_UDID,
            fromX: 0.5,
            fromY: 0.8,
            toX: 0.5,
            toY: 0.2,
          } as never),
      ],
      [
        // Only its live-capture arm builds the ref; a pure static-PNG diff
        // deliberately builds none, so `captureCurrent` is what makes this a
        // CoreDevice consumer at all.
        "screenshot-diff",
        () =>
          screenshotDiffTool.services!({
            udid: PHYSICAL_UDID,
            baseline: "a.png",
            captureCurrent: true,
          } as never),
      ],
    ];
    for (const [id, call] of cases) {
      expect(call, `${id} must not reach a physical iPhone with the flag off`).toThrow(
        InvalidToolInputError
      );
    }
  });
});
