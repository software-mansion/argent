import { describe, it, expect, afterEach } from "vitest";
import { deviceAttributionFromArgs, platformFromArgs } from "../src/http";
import {
  forgetLogicalKeyedDevice,
  rememberDeviceAlias,
  rememberLogicalKeyedDevice,
  resetDeviceAliases,
} from "../src/utils/debugger/device-alias";

/**
 * The platform on tool:invoke / tool:complete / tool:fail must agree with the
 * platform debugger:tool_outcome derives for the SAME tool_invocation_id.
 * Both now classify through the device-alias map: a forwarded Metro
 * logicalDeviceId (opaque 40-hex handle) is rewritten back to the id the
 * caller connected with before shape classification — otherwise an iOS
 * debugger call joins to `platform: android` lifecycle rows and per-platform
 * failure dashboards double-count.
 */

const LOGICAL_ID = "8b9223b1392be193fa9058e0cef5cefb2bddeb68";
const IOS_UDID = "BE1DCAD9-43CE-40C4-B8B2-9CB30BC03227";
const PHYSICAL_UDID = "00008030-000A1B2C3D4E5F60";

afterEach(() => {
  resetDeviceAliases();
});

describe("http platform inference and the device alias", () => {
  it("classifies a forwarded logicalDeviceId via its learned alias — ios, not android", () => {
    rememberDeviceAlias(LOGICAL_ID, IOS_UDID);
    expect(platformFromArgs({ device_id: LOGICAL_ID })).toBe("ios");
  });

  it("an id with no learned alias keeps the shape-based fallback", () => {
    expect(platformFromArgs({ device_id: LOGICAL_ID })).toBe("android");
  });

  it("stable ids pass through unchanged", () => {
    expect(platformFromArgs({ udid: IOS_UDID })).toBe("ios");
    expect(platformFromArgs({ device_id: "chromium-cdp-9222" })).toBe("chromium");
  });

  it("derives the device kind from the aliased id, not the opaque handle", () => {
    // A learned alias to a physical iPhone makes the debugger call count as
    // hardware; the 40-hex handle alone never would.
    rememberDeviceAlias(LOGICAL_ID, PHYSICAL_UDID);
    expect(deviceAttributionFromArgs({ device_id: LOGICAL_ID })).toEqual({
      platform: "ios",
      device_kind: "device",
    });
  });

  it("an un-aliased handle keeps the shape fallback platform and carries no kind", () => {
    // The fallback `android` is pre-existing; what must not happen is the
    // handle being counted as a physical Android phone.
    expect(deviceAttributionFromArgs({ device_id: LOGICAL_ID })).toEqual({ platform: "android" });
  });

  it("a logical-keyed session carries no kind even if its id looked like a serial", () => {
    // Two devices on one Metro: the caller connects with the logicalDeviceId
    // itself, so there is no alias to canonicalise through. Marked sessions
    // strip the kind regardless of what the handle's shape suggests.
    const serialShaped = "R5CT12345678";
    rememberLogicalKeyedDevice(serialShaped, serialShaped);
    try {
      expect(deviceAttributionFromArgs({ device_id: serialShaped })).toEqual({
        platform: "android",
      });
    } finally {
      forgetLogicalKeyedDevice(serialShaped);
    }
    expect(deviceAttributionFromArgs({ device_id: serialShaped })).toEqual({
      platform: "android",
      device_kind: "device",
    });
  });
});
