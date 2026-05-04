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

describe("selectTarget — deviceId silent fallback", () => {
  it("throws when an explicit deviceId does not match any target", () => {
    // Two devices, both with logicalDeviceId. Caller asks for 'CCC' which is not present.
    const dev1 = makeTarget({
      id: "dev1",
      reactNative: { logicalDeviceId: "AAA" },
    });
    const dev2 = makeTarget({
      id: "dev2",
      reactNative: { logicalDeviceId: "BBB" },
    });

    // Expected behaviour: when an explicit deviceId is requested but no target
    // matches, the function should refuse to silently route the caller to a
    // different physical device.
    expect(() => selectTarget([dev1, dev2], 8081, { deviceId: "CCC" })).toThrow();
  });
});
