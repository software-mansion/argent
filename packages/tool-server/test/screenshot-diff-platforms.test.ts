import { describe, it, expect } from "vitest";
import { assertSupported, UnsupportedOperationError } from "../src/utils/capability";
import { resolveDevice } from "../src/utils/device-info";
import { screenshotDiffTool } from "../src/tools/screenshot-diff";
import { SCREENSHOT_CAPTURE_CAPABILITY } from "../src/tools/screenshot";

// The refusal these pin happens at the capability gate, before `execute` runs,
// so a test driving `executeScreenshotDiffTool` cannot see it.
const gate = (id: string) => () =>
  assertSupported("screenshot-diff", screenshotDiffTool.capability, resolveDevice(id));

describe("screenshot-diff accepts every target it can compare", () => {
  it.each([
    ["chromium", "chromium-cdp-9222"],
    ["vega", "amazon-4a27df03c9777152"],
    ["ios-remote", "remote:AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA"],
    ["ios", "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA"],
    ["android", "emulator-5554"],
  ])("does not refuse a %s target", (_label, id) => {
    // Comparing two saved PNGs touches no device, so refusing by platform made
    // visual regression testing impossible on Electron entirely.
    expect(gate(id)).not.toThrow();
  });

  it("declares the platforms a screenshot can actually be taken from", () => {
    // Asserts the shared matrix by value, not by identity — identity would pass
    // even if the matrix itself dropped a platform.
    expect(screenshotDiffTool.capability).toEqual(SCREENSHOT_CAPTURE_CAPABILITY);
    expect(SCREENSHOT_CAPTURE_CAPABILITY).toMatchObject({
      chromium: { app: true },
      vega: { vvd: true },
      appleRemote: { simulator: true },
    });
  });

  it("still refuses a device outside the shared matrix", () => {
    // Guards against "fixing" this by deleting the capability altogether.
    expect(() =>
      assertSupported(
        "screenshot-diff",
        { apple: { simulator: true } },
        resolveDevice("emulator-5554")
      )
    ).toThrow(UnsupportedOperationError);
  });
});

describe("screenshot-diff live capture", () => {
  const services = (udid: string, capture: boolean) =>
    screenshotDiffTool.services!({
      udid,
      captureCurrent: capture,
    } as never);

  it("asks for no simulator-server on platforms it captures another way", () => {
    // Requesting one fails while resolving the service — before `execute` — so
    // the caller would get the blueprint's error instead of one about screenshots.
    expect(services("chromium-cdp-9222", true)).toEqual({});
    expect(services("amazon-4a27df03c9777152", true)).toEqual({});
  });

  it("still asks for one where it does capture, so a wedged server can self-heal", () => {
    expect(Object.keys(services("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", true))).toEqual([
      "simulatorServer",
    ]);
    expect(Object.keys(services("emulator-5554", true))).toEqual(["simulatorServer"]);
  });

  it("asks for nothing when both sides are saved files", () => {
    expect(services("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", false)).toEqual({});
  });
});
