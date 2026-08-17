import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("@argent/telemetry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@argent/telemetry")>();
  return { ...actual, track: vi.fn() };
});

import { track } from "@argent/telemetry";
import { trackDebuggerOutcome } from "../../src/tools/debugger/not-connected";
import { rememberDeviceAlias, forgetDeviceAlias } from "../../src/utils/debugger/device-alias";

const mockTrack = vi.mocked(track);

/**
 * The platform dimension of debugger:tool_outcome must classify the id the
 * caller CONNECTED with, not the raw param: agents follow debugger-connect's
 * contract and forward the returned logicalDeviceId (an opaque 40-hex Metro
 * handle) on every subsequent call, and that shape fails the iOS-UDID test in
 * classifyDevice — without the alias rewrite every iOS Metro session lands in
 * telemetry as "android" (observed live), which is exactly the per-platform
 * dashboard this event exists to power.
 */

const LOGICAL_ID = "8b9223b1392be193fa9058e0cef5cefb2bddeb68";
const IOS_UDID = "BE1DCAD9-43CE-40C4-B8B2-9CB30BC03227";

afterEach(() => {
  forgetDeviceAlias(LOGICAL_ID);
  mockTrack.mockClear();
});

describe("trackDebuggerOutcome platform classification", () => {
  it("classifies a forwarded Metro logicalDeviceId via its learned alias — ios, not android", () => {
    rememberDeviceAlias(LOGICAL_ID, IOS_UDID);
    trackDebuggerOutcome("debugger-status", "connected", { device_id: LOGICAL_ID }, undefined);
    expect(mockTrack).toHaveBeenCalledWith(
      "debugger:tool_outcome",
      expect.objectContaining({ platform: "ios" })
    );
  });

  it("an id with no learned alias keeps the shape-based fallback (android)", () => {
    trackDebuggerOutcome("debugger-status", "connected", { device_id: LOGICAL_ID }, undefined);
    expect(mockTrack).toHaveBeenCalledWith(
      "debugger:tool_outcome",
      expect.objectContaining({ platform: "android" })
    );
  });

  it("chromium ids classify as chromium (the alias map never rewrites them)", () => {
    trackDebuggerOutcome(
      "debugger-log-registry",
      "cdp_unreachable",
      { device_id: "chromium-cdp-54427" },
      undefined
    );
    expect(mockTrack).toHaveBeenCalledWith(
      "debugger:tool_outcome",
      expect.objectContaining({ platform: "chromium" })
    );
  });

  it("omits platform entirely when there is no device_id", () => {
    trackDebuggerOutcome("debugger-status", "metro_not_running", {}, undefined);
    const props = mockTrack.mock.calls.at(-1)![1] as Record<string, unknown>;
    expect("platform" in props).toBe(false);
  });
});
