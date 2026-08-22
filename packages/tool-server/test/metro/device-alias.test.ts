import { describe, it, expect, beforeEach } from "vitest";
import {
  rememberDeviceAlias,
  canonicalDeviceId,
  forgetDeviceAlias,
  rememberLogicalKeyedDevice,
  isLogicalKeyedDevice,
  forgetLogicalKeyedDevice,
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

  it("marks only a session whose connect id IS the logicalDeviceId", () => {
    // The marker means "no device-scoped teardown can name this session", and
    // stop-all-simulator-servers reports the marked sessions its scope did NOT
    // reach as left_running. A udid-keyed session is one a scope could have
    // named, so marking it would report another agent's ordinary session on a
    // device this caller never asked about - which that report exists to leave
    // alone.
    rememberLogicalKeyedDevice(LOGICAL_ID, IOS_UDID);
    expect(isLogicalKeyedDevice(IOS_UDID)).toBe(false);
    expect(isLogicalKeyedDevice(LOGICAL_ID)).toBe(false);

    // Vega and a legacy inspector report no logicalDeviceId at all; nothing to
    // compare, so nothing to mark.
    rememberLogicalKeyedDevice(undefined, IOS_UDID);
    expect(isLogicalKeyedDevice(IOS_UDID)).toBe(false);

    // Recorded in the spelling the connect used, read back in whichever the
    // teardown holds: an id reaches the two sides from different places, so
    // both ends fold. Written uppercase here, since the ids these tests use are
    // already lower.
    rememberLogicalKeyedDevice(LOGICAL_ID.toUpperCase(), LOGICAL_ID.toUpperCase());
    expect(isLogicalKeyedDevice(LOGICAL_ID)).toBe(true);
    expect(isLogicalKeyedDevice(LOGICAL_ID.toUpperCase())).toBe(true);

    // Forgotten in whichever spelling the dispose holds - the third place this
    // id is folded, and the one that decides whether the marker outlives its
    // session. Asked here in the spelling the write did NOT store.
    forgetLogicalKeyedDevice(LOGICAL_ID);
    expect(isLogicalKeyedDevice(LOGICAL_ID)).toBe(false);
    rememberLogicalKeyedDevice(LOGICAL_ID, LOGICAL_ID);
    forgetLogicalKeyedDevice(LOGICAL_ID.toUpperCase());
    expect(isLogicalKeyedDevice(LOGICAL_ID)).toBe(false);
  });

  it("clears the logical-keyed markers along with the aliases", () => {
    // Both halves of this module are module-global, so a reset that emptied
    // only one would leak a marker into whatever test ran next.
    rememberLogicalKeyedDevice(LOGICAL_ID, LOGICAL_ID);
    rememberDeviceAlias(LOGICAL_ID, IOS_UDID);
    resetDeviceAliases();
    expect(isLogicalKeyedDevice(LOGICAL_ID)).toBe(false);
    expect(canonicalDeviceId(LOGICAL_ID)).toBe(LOGICAL_ID);
  });

  it("does not disturb Chromium routing", () => {
    const ref = debuggerServiceRef({ port: 8081, device_id: CHROMIUM_ID });
    expect(ref).toMatchObject({ urn: expect.stringContaining(CHROMIUM_ID) });
  });
});
