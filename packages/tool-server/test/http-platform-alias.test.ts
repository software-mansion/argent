import { describe, it, expect, afterEach } from "vitest";
import { platformFromArgs } from "../src/http";
import { rememberDeviceAlias, resetDeviceAliases } from "../src/utils/debugger/device-alias";

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

  it("attributes a boot that names an instance rather than a device", () => {
    // The first call of any HarmonyOS session, and the only one with no id to
    // classify: unattributed, it is the platform's own boot that goes missing
    // from every per-platform view.
    expect(platformFromArgs({ harmonyInstance: "argent_phone" })).toBe("harmony");
    expect(platformFromArgs({ avdName: "Pixel_7" })).toBe("android");
    // The connect key the boot hands back classifies by shape from then on.
    expect(platformFromArgs({ udid: "harmony-127.0.0.1:5555" })).toBe("harmony");
  });
});
