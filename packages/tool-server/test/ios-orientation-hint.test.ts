import { describe, it, expect } from "vitest";
import {
  IOS_ROTATED_CAPTURE_NOTE,
  LANDSCAPE_COORDINATE_HINT,
  isLandscapeScreenFrame,
  withLandscapeHint,
} from "../src/utils/ios-orientation-hint";

/**
 * Issue #609. On a rotated iOS simulator argent reports coordinates in two
 * different spaces depending on which path served the tree:
 *
 *   describe via ax-service       portrait-native  — agrees with where taps land
 *   describe via native-devtools  upright          — does not
 *   native-describe-screen        upright          — does not
 *
 * Measured on a landscape iPad Pro 13-inch, the same button reads (0.238, 0.342)
 * from ax-service and (0.342, 0.762) from native-devtools.
 *
 * These tests pin the advisory and — just as importantly — pin that the numbers
 * themselves are left alone. The screen aspect gives the axis but not the sense,
 * so a transform here would be a guess between two possibilities 180° apart.
 */

const LANDSCAPE = { width: 1376, height: 1032 }; // rotated iPad Pro 13-inch
const PORTRAIT = { width: 1032, height: 1376 };

describe("isLandscapeScreenFrame", () => {
  it("recognises a rotated device by its reported screen", () => {
    expect(isLandscapeScreenFrame(LANDSCAPE)).toBe(true);
  });

  it("does not flag an upright device", () => {
    expect(isLandscapeScreenFrame(PORTRAIT)).toBe(false);
  });

  it("does not flag a square screen, which says nothing either way", () => {
    expect(isLandscapeScreenFrame({ width: 1024, height: 1024 })).toBe(false);
  });

  it("does not flag a missing screen frame", () => {
    expect(isLandscapeScreenFrame(undefined)).toBe(false);
  });
});

describe("withLandscapeHint", () => {
  it("adds the advisory when the device is rotated", () => {
    expect(withLandscapeHint(undefined, LANDSCAPE)).toBe(LANDSCAPE_COORDINATE_HINT);
  });

  it("adds nothing when the device is upright", () => {
    expect(withLandscapeHint(undefined, PORTRAIT)).toBeUndefined();
  });

  it("leaves an existing hint untouched when the device is upright", () => {
    expect(withLandscapeHint("reboot the simulator", PORTRAIT)).toBe("reboot the simulator");
  });

  it("keeps a blocking hint first when both apply", () => {
    // describe's other hints say the simulator needs rebooting or the app cannot
    // be inspected at all. Those are blocking; a coordinate-space note is only
    // useful once you have a tree, so it must not be what the caller reads first.
    const combined = withLandscapeHint("reboot the simulator", LANDSCAPE)!;
    expect(combined.startsWith("reboot the simulator")).toBe(true);
    expect(combined).toContain(LANDSCAPE_COORDINATE_HINT);
  });

  it("points the caller at describe rather than at a coordinate transform", () => {
    expect(LANDSCAPE_COORDINATE_HINT).toMatch(/describe/);
    expect(LANDSCAPE_COORDINATE_HINT).toMatch(/will miss/);
  });
});

describe("the rotate note", () => {
  it("does not stop at 'pass rotation', which is the trap being reported", () => {
    // Recommending `rotation` alone yields a readable image whose coordinates
    // silently disagree with describe and with touch — worse than a sideways
    // image, because the failure is invisible.
    expect(IOS_ROTATED_CAPTURE_NOTE).toContain("rotation");
    expect(IOS_ROTATED_CAPTURE_NOTE).toMatch(/different space/);
    expect(IOS_ROTATED_CAPTURE_NOTE).toMatch(/do not read coordinates off it/i);
  });
});
