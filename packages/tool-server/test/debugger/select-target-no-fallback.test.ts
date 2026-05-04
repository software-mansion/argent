import { describe, it, expect } from "vitest";
import { selectTarget } from "../../src/utils/debugger/target-selection";
import type { CDPTarget } from "../../src/utils/debugger/discovery";

function makeTarget(overrides: Partial<CDPTarget> = {}): CDPTarget {
  return {
    id: "page1",
    title: "React Native",
    description: "",
    webSocketDebuggerUrl: "ws://localhost:8081/inspector/debug?device=0&page=1",
    ...overrides,
  };
}

describe("selectTarget — explicit failure when deviceId/deviceName filters are empty", () => {
  it("throws when an explicit deviceId matches no target instead of routing to a different device", () => {
    const dev1 = makeTarget({
      id: "dev1",
      reactNative: { logicalDeviceId: "AAA" },
    });
    const dev2 = makeTarget({
      id: "dev2",
      reactNative: { logicalDeviceId: "BBB" },
    });

    expect(() => selectTarget([dev1, dev2], 8081, { deviceId: "CCC" })).toThrow(/CCC/);
  });

  it("throws when an explicit deviceName matches no target", () => {
    const dev1 = makeTarget({
      id: "dev1",
      deviceName: "iPhone 15",
      reactNative: { logicalDeviceId: "AAA" },
    });
    const dev2 = makeTarget({
      id: "dev2",
      deviceName: "Pixel 7",
      reactNative: { logicalDeviceId: "BBB" },
    });

    expect(() => selectTarget([dev1, dev2], 8081, { deviceName: "Galaxy S24" })).toThrow(
      /Galaxy S24/
    );
  });

  it("still selects the matching target when deviceId is provided and present", () => {
    const dev1 = makeTarget({
      id: "dev1",
      reactNative: { logicalDeviceId: "AAA" },
    });
    const dev2 = makeTarget({
      id: "dev2",
      reactNative: { logicalDeviceId: "BBB" },
    });

    const result = selectTarget([dev1, dev2], 8081, { deviceId: "BBB" });
    expect(result.target.id).toBe("dev2");
  });

  it("does not throw when no deviceId/deviceName is provided (no filter, fallback allowed)", () => {
    const dev1 = makeTarget({
      id: "dev1",
      reactNative: { logicalDeviceId: "AAA" },
    });

    const result = selectTarget([dev1], 8081);
    expect(result.target.id).toBe("dev1");
  });
});
