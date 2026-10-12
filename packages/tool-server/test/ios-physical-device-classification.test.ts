import { describe, it, expect } from "vitest";
import { classifyDevice, isIosPhysicalUdid, resolveDevice } from "../src/utils/device-info";
import { createRegistry } from "../src/utils/setup-registry";

// Real-world shapes: simulator UUIDs are RFC-4122 (8-4-4-4-12); modern physical
// devices are 8+16 hex (A12/2018 hardware and newer, the CoreDevice floor).
const SIM_UDID = "2E35A650-9618-41E1-9E8D-5E4E7CC20929";
const PHYSICAL_UDID = "00008110-000978540290401E";

describe("physical iOS UDID classification", () => {
  it("splits the modern physical shape from simulator UUIDs", () => {
    expect(isIosPhysicalUdid(PHYSICAL_UDID)).toBe(true);
    expect(classifyDevice(PHYSICAL_UDID)).toBe("ios");
    expect(resolveDevice(PHYSICAL_UDID)).toEqual({
      id: PHYSICAL_UDID,
      platform: "ios",
      kind: "device",
    });
    expect(isIosPhysicalUdid(SIM_UDID)).toBe(false);
    expect(resolveDevice(SIM_UDID)).toEqual({
      id: SIM_UDID,
      platform: "ios",
      kind: "simulator",
    });
  });

  it("does not misclassify Android serials or prefixed ids", () => {
    // Legacy 40-hex physical UDIDs are deliberately ambiguous -> android
    // (pre-A12 hardware cannot run iOS 17, the CoreDevice floor).
    for (const serial of [
      "emulator-5554",
      "R58M12ABCDE",
      "192.168.1.5:5555",
      "0123456789abcdef0123456789abcdef01234567",
    ]) {
      expect(classifyDevice(serial)).toBe("android");
    }
    expect(classifyDevice("remote:" + SIM_UDID)).toBe("ios-remote");
    expect(classifyDevice("amazon-4a27df03c9777152")).toBe("vega");
    expect(classifyDevice("chromium-cdp-9222")).toBe("chromium");
  });
});

// Capability ratchet: a tool may declare `apple: { device: true }` only once its
// physical-iOS implementation actually exists (it is then added to this
// allowlist). Without this gate, resolveDevice() returning kind "device" makes
// stale declarations reachable and routes hardware into simulator-only
// services. See the physical-iOS implementation plan, decision D4.
const PHYSICAL_IOS_PORTED_TOOLS: readonly string[] = [
  "launch-app",
  "restart-app",
  "reinstall-app",
  "screenshot",
  "describe",
  "keyboard",
  "gesture-tap",
  "gesture-swipe",
  // Press-hold / straight drags via the runner's longPress + drag; two-finger
  // trains and Move waypoints are rejected with authoring guidance.
  "gesture-custom",
  // home / volumeUp / volumeDown / actionButton via XCUIDevice.press; power
  // and appSwitch have no public XCUIDevice API and stay rejected.
  "button",
  // The wait tools poll describeIosDevice, the same runner snapshot describe
  // returns, so waits and taps see identical frames.
  "await-ui-element",
  "await-screen-idle",
  // Outer gate only: each step still pre-flights its own capability.
  "run-sequence",
  // Live captures go through the runner's device-wide screenshot. The diff
  // engine itself runs on the host either way.
  "screenshot-diff",
  // devicectl launches the named receiving app with the URL as its payload.
  // Web URLs default to Safari and any other scheme must name the app.
  "open-url",
];

describe("apple.device capability ratchet", () => {
  it("only ported tools declare apple.device", () => {
    const registry = createRegistry();
    const offenders = registry
      .getSnapshot()
      .tools.filter((id) => registry.getTool(id)?.capability?.apple?.device === true)
      .filter((id) => !PHYSICAL_IOS_PORTED_TOOLS.includes(id));
    expect(offenders).toEqual([]);
  });
});
