import { describe, it, expect, beforeEach } from "vitest";
import {
  rememberDeviceAlias,
  canonicalDeviceId,
  forgetDeviceAlias,
  resetDeviceAliases,
} from "../../src/utils/debugger/device-alias";
import { debuggerServiceRef } from "../../src/tools/debugger/debugger-service-ref";

const IOS_UDID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const LOGICAL_ID = "8a44101d";
const CHROMIUM_ID = "chromium-cdp-19222";

describe("device-alias — canonicalizing a forwarded logicalDeviceId", () => {
  beforeEach(() => resetDeviceAliases());

  it("passes an unknown id through unchanged", () => {
    expect(canonicalDeviceId(IOS_UDID)).toBe(IOS_UDID);
    expect(canonicalDeviceId(LOGICAL_ID)).toBe(LOGICAL_ID);
    expect(canonicalDeviceId(undefined)).toBeUndefined();
  });

  it("maps a learned logicalDeviceId back to the id its device connected with", () => {
    rememberDeviceAlias(LOGICAL_ID, IOS_UDID);
    expect(canonicalDeviceId(LOGICAL_ID)).toBe(IOS_UDID);
    // the connect id itself is still a no-op
    expect(canonicalDeviceId(IOS_UDID)).toBe(IOS_UDID);
  });

  it("never records a self-alias (Chromium, where logicalDeviceId === device id)", () => {
    rememberDeviceAlias(CHROMIUM_ID, CHROMIUM_ID);
    expect(canonicalDeviceId(CHROMIUM_ID)).toBe(CHROMIUM_ID);
  });

  it("ignores a missing logicalDeviceId (Vega / legacy inspector)", () => {
    rememberDeviceAlias(undefined, IOS_UDID);
    expect(canonicalDeviceId(IOS_UDID)).toBe(IOS_UDID);
  });

  it("drops the alias on forget so a reconnect is not shadowed", () => {
    rememberDeviceAlias(LOGICAL_ID, IOS_UDID);
    forgetDeviceAlias(LOGICAL_ID);
    expect(canonicalDeviceId(LOGICAL_ID)).toBe(LOGICAL_ID);
  });
});

describe("debuggerServiceRef — collapses a forwarded logicalDeviceId onto one URN", () => {
  beforeEach(() => resetDeviceAliases());

  it("keys the service by the connect id whether called with the UDID or the logicalDeviceId", () => {
    const connectRef = debuggerServiceRef({ port: 8081, device_id: IOS_UDID });
    expect(connectRef).toBe(`JsRuntimeDebugger:8081:${IOS_UDID}`);

    // After connect learns Metro's handle, a later call that forwards it must
    // resolve to the SAME URN — otherwise a second CDP connection is opened.
    rememberDeviceAlias(LOGICAL_ID, IOS_UDID);
    const forwardedRef = debuggerServiceRef({ port: 8081, device_id: LOGICAL_ID });
    expect(forwardedRef).toBe(connectRef);
  });

  it("does not disturb Chromium routing", () => {
    const ref = debuggerServiceRef({ port: 8081, device_id: CHROMIUM_ID });
    expect(ref).toMatchObject({ urn: expect.stringContaining(CHROMIUM_ID) });
  });
});
