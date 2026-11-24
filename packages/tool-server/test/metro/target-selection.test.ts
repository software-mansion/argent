import { createHash } from "node:crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { FAILURE_CODES, FailureError, getFailureSignal } from "@argent/registry";
import type { CDPTarget } from "../../src/utils/debugger/discovery";

type TargetSelection = typeof import("../../src/utils/debugger/target-selection");
let selectTarget: TargetSelection["selectTarget"];

/**
 * The Mac Catalyst apps in `~/.argent/macos-apps.json`, by bundle id, with the
 * identifierForVendor their library reported (null: none). Empty, as for a
 * user who never started one, unless a test fills it.
 */
const trackedCatalystApps = vi.hoisted(() => new Map<string, string | null>());
vi.mock("../../src/utils/macos-app-kind", () => ({
  trackedMacosAppKind: (bundleId: string) =>
    trackedCatalystApps.has(bundleId) ? "catalyst" : "app",
  trackedMacosAppVendorId: (bundleId: string) => trackedCatalystApps.get(bundleId) ?? undefined,
}));

function makeTarget(overrides: Partial<CDPTarget> = {}): CDPTarget {
  return {
    id: "page1",
    title: "React Native",
    description: "",
    webSocketDebuggerUrl: "ws://localhost:8081/inspector/debug?device=0&page=1",
    ...overrides,
  };
}

/**
 * React Native's Apple inspector id: `sha256("apple-<identifierForVendor>-<bundle
 * id>-<fusebox|legacy>")`, first 40 hex digits. A react-native-macos app has no
 * vendor id; a Mac Catalyst app runs UIKit and has one.
 */
function appleLogicalId(
  bundleId: string,
  { vendorId = "", mode = "fusebox" }: { vendorId?: string; mode?: "fusebox" | "legacy" } = {}
): string {
  return createHash("sha256")
    .update(`apple-${vendorId}-${bundleId}-${mode}`)
    .digest("hex")
    .slice(0, 40);
}

/** A react-native-macos Debug app's runtime, in the shape of REAL_MAC_TARGET. */
function macTarget(bundleId: string, overrides: Partial<CDPTarget> = {}): CDPTarget {
  const logicalDeviceId = appleLogicalId(bundleId);
  return makeTarget({
    id: `${logicalDeviceId}-1`,
    title: `${bundleId} ()`,
    description: "React Native Bridgeless [C++ connection]",
    appId: bundleId,
    deviceName: "Unknown",
    webSocketDebuggerUrl: `ws://localhost:8081/inspector/debug?device=${logicalDeviceId}&page=1`,
    reactNative: { logicalDeviceId, capabilities: { prefersFuseboxFrontend: true } },
    ...overrides,
  });
}

/** The same app on an iOS simulator: its id hashes in the simulator's vendor id. */
function iosTarget(bundleId: string, overrides: Partial<CDPTarget> = {}): CDPTarget {
  const logicalDeviceId = appleLogicalId(bundleId, {
    vendorId: "5C1B6E9A-0D2F-4A47-9E3B-7A1D2C3E4F50",
  });
  return makeTarget({
    id: `${logicalDeviceId}-1`,
    title: `${bundleId} (iPhone 17 Pro)`,
    description: "React Native Bridgeless [C++ connection]",
    appId: bundleId,
    deviceName: "iPhone 17 Pro",
    webSocketDebuggerUrl: `ws://localhost:8081/inspector/debug?device=${logicalDeviceId}&page=1`,
    reactNative: { logicalDeviceId, capabilities: { prefersFuseboxFrontend: true } },
    ...overrides,
  });
}

/** One entry of GET /json/list from a react-native-macos 0.83 Debug app, verbatim. */
const REAL_MAC_TARGET = JSON.parse(
  '{"id":"d73eedec912893ff31dd6ec1a39d2d23a126f495-1","title":"com.example.focus.rnprof ()",' +
    '"description":"React Native Bridgeless [C++ connection]","appId":"com.example.focus.rnprof",' +
    '"type":"node","webSocketDebuggerUrl":"ws://localhost:8297/inspector/debug?device=' +
    'd73eedec912893ff31dd6ec1a39d2d23a126f495&page=1","deviceName":"Unknown","reactNative":' +
    '{"logicalDeviceId":"d73eedec912893ff31dd6ec1a39d2d23a126f495","capabilities":' +
    '{"prefersFuseboxFrontend":true,"nativeSourceCodeFetching":false,"nativePageReloads":true}}}'
) as CDPTarget;

function thrownBy(run: () => unknown): Error {
  let thrown: unknown;
  try {
    run();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(Error);
  return thrown as Error;
}

const MISMATCH_SIGNAL = {
  error_code: FAILURE_CODES.DEBUGGER_TARGET_DEVICE_MISMATCH,
  failure_stage: "debugger_select_target",
  failure_area: "tool_server",
  error_kind: "not_found",
};

describe("selectTarget", () => {
  // selectTarget remembers every logicalDeviceId it has seen for the life of
  // the module. A fresh module per test keeps one test's ids out of the next.
  beforeEach(async () => {
    vi.resetModules();
    ({ selectTarget } = await import("../../src/utils/debugger/target-selection"));
  });

  it("prefers Fusebox target", () => {
    const fusebox = makeTarget({
      id: "fusebox",
      reactNative: { capabilities: { prefersFuseboxFrontend: true } },
    });
    const legacy = makeTarget({ id: "legacy", title: "React Native Bridge (0)" });

    const result = selectTarget([legacy, fusebox], 8081);
    expect(result.target.id).toBe("fusebox");
    expect(result.isNewDebugger).toBe(true);
    expect(result.legacyInspector).toBe(false);
  });

  it("falls back to C++ connection", () => {
    const cpp = makeTarget({
      id: "cpp",
      description: "some [C++ connection]",
    });
    const legacy = makeTarget({ id: "legacy" });

    const result = selectTarget([legacy, cpp], 8081);
    expect(result.target.id).toBe("cpp");
    expect(result.isNewDebugger).toBe(true);
    expect(result.legacyInspector).toBe(false);
  });

  it("falls back to React Native Bridge", () => {
    const bridge = makeTarget({
      id: "bridge",
      title: "React Native Bridge (0)",
    });
    const other = makeTarget({ id: "other", title: "Other" });

    const result = selectTarget([other, bridge], 8081);
    expect(result.target.id).toBe("bridge");
    expect(result.isNewDebugger).toBe(false);
    // RN 0.74's modern CDP registry lists it; its -32601 is not the legacy one.
    expect(result.legacyInspector).toBe(false);
  });

  it("falls back to first target", () => {
    const t1 = makeTarget({ id: "first", title: "Unknown" });
    const t2 = makeTarget({ id: "second", title: "Unknown 2" });

    const result = selectTarget([t1, t2], 8081);
    expect(result.target.id).toBe("first");
    expect(result.legacyInspector).toBe(true);
  });

  it("picks the legacy Hermes runtime over a worklet runtime listed before it", () => {
    // /json/list of an RN 0.75 legacy-inspector app using Reanimated (#1836),
    // minus the `don't use` page discoverMetro drops.
    const reanimated = makeTarget({ id: "0-2", title: "Reanimated UI runtime" });
    // A runtime from `createWorkletRuntime` carries whatever name it was given.
    const custom = makeTarget({ id: "0-3", title: "my-worklet-runtime" });
    const hermes = makeTarget({ id: "0-1", title: "Hermes React Native" });

    const result = selectTarget([reanimated, custom, hermes], 8081);
    expect(result.target.id).toBe("0-1");
    expect(result.isNewDebugger).toBe(false);
    expect(result.legacyInspector).toBe(true);
  });

  it("picks a bridgeless app's runtime over a worklet runtime listed before it", () => {
    // New architecture without Fusebox (RN 0.73 - 0.75 default) names the app's
    // runtime differently.
    const reanimated = makeTarget({ id: "0-2", title: "Reanimated UI runtime" });
    const hermes = makeTarget({ id: "0-1", title: "Hermes Bridgeless React Native" });

    const result = selectTarget([reanimated, hermes], 8081);
    expect(result.target.id).toBe("0-1");
    expect(result.isNewDebugger).toBe(false);
  });

  it("picks the app's runtime when the C++ packager connection suffixes its title", () => {
    // RN 0.74 with inspectorEnableCxxInspectorPackagerConnection and no modern
    // CDP registry: legacy pages keep their names, plus " [C++ connection]".
    const reanimated = makeTarget({ id: "0-2", title: "Reanimated UI runtime [C++ connection]" });
    const hermes = makeTarget({ id: "0-1", title: "Hermes React Native [C++ connection]" });

    const result = selectTarget([reanimated, hermes], 8081);
    expect(result.target.id).toBe("0-1");
    expect(result.isNewDebugger).toBe(false);
  });

  it("normalizes WebSocket URL to localhost with correct port", () => {
    const target = makeTarget({
      webSocketDebuggerUrl: "ws://10.0.2.2:9999/inspector/debug?device=0&page=1",
    });

    const result = selectTarget([target], 8081);
    expect(result.webSocketUrl).toContain("localhost");
    expect(result.webSocketUrl).toContain("8081");
    expect(result.webSocketUrl).not.toContain("10.0.2.2");
    expect(result.webSocketUrl).not.toContain("9999");
  });

  it("filters by deviceName when specified", () => {
    const dev1 = makeTarget({ id: "dev1", deviceName: "iPhone 16" });
    const dev2 = makeTarget({ id: "dev2", deviceName: "Pixel 9" });

    const result = selectTarget([dev1, dev2], 8081, {
      deviceName: "Pixel 9",
    });
    expect(result.target.id).toBe("dev2");
  });

  it("filters by deviceId when specified", () => {
    const dev1 = makeTarget({
      id: "dev1",
      reactNative: { logicalDeviceId: "aaa" },
    });
    const dev2 = makeTarget({
      id: "dev2",
      reactNative: { logicalDeviceId: "bbb" },
    });

    const result = selectTarget([dev1, dev2], 8081, { deviceId: "bbb" });
    expect(result.target.id).toBe("dev2");
  });

  it("picks the requested device's app runtime when two legacy devices share Metro", () => {
    const pages = (device: number, logicalDeviceId: string) => [
      makeTarget({
        id: `${device}-2`,
        title: "Reanimated UI runtime",
        reactNative: { logicalDeviceId },
      }),
      makeTarget({
        id: `${device}-1`,
        title: "Hermes React Native",
        reactNative: { logicalDeviceId },
      }),
    ];

    const result = selectTarget([...pages(0, "aaa"), ...pages(1, "bbb")], 8081, {
      deviceId: "bbb",
    });
    expect(result.target.id).toBe("1-1");
  });

  it("routes distinct deviceIds to distinct devices (no collapse)", () => {
    const dev1 = makeTarget({
      id: "dev1",
      reactNative: { logicalDeviceId: "aaa", capabilities: { prefersFuseboxFrontend: true } },
    });
    const dev2 = makeTarget({
      id: "dev2",
      reactNative: { logicalDeviceId: "bbb", capabilities: { prefersFuseboxFrontend: true } },
    });

    expect(selectTarget([dev1, dev2], 8081, { deviceId: "aaa" }).target.id).toBe("dev1");
    expect(selectTarget([dev1, dev2], 8081, { deviceId: "bbb" }).target.id).toBe("dev2");
  });

  it("throws instead of silently collapsing when an unmatched deviceId is ambiguous", () => {
    const dev1 = makeTarget({ id: "dev1", reactNative: { logicalDeviceId: "aaa" } });
    const dev2 = makeTarget({ id: "dev2", reactNative: { logicalDeviceId: "bbb" } });

    // An id that matches neither device must NOT resolve to the first target —
    // that is the "all debuggers resolve to the same device" bug.
    expect(() => selectTarget([dev1, dev2], 8081, { deviceId: "unmatched" })).toThrow(
      /No debugger target matches device_id "unmatched"/
    );
    // The error must surface the valid ids so the caller can re-target.
    expect(() => selectTarget([dev1, dev2], 8081, { deviceId: "unmatched" })).toThrow(/aaa.*bbb/);
  });

  describe("resolving a udid by device name on a shared Metro", () => {
    const UDID = "B7D5711C-0000-4000-8000-000000000000";
    const device = (id: string, deviceName: string, logicalDeviceId: string) =>
      makeTarget({
        id,
        deviceName,
        reactNative: { logicalDeviceId, capabilities: { prefersFuseboxFrontend: true } },
      });
    const iphone = device("dev1", "iPhone", "d4d1e970");
    const proMax = device("dev2", "iPhone 17 Pro Max", "ed43ae85");
    const named = device("dev3", "iPhone 17 [ink-and-quill]", "27fb9b61");
    const is = (name: string) => (reported: string) => reported === name;

    it("picks the one device whose name matches", () => {
      const result = selectTarget([iphone, proMax, named], 9001, {
        deviceId: UDID,
        deviceNameMatches: is("iPhone 17 [ink-and-quill]"),
      });
      expect(result.target.id).toBe("dev3");
    });

    it("refuses when two devices share the matching name", () => {
      const twin = device("dev4", "iPhone 17 [ink-and-quill]", "aa11bb22");
      const err = thrownBy(() =>
        selectTarget([iphone, named, twin], 9001, {
          deviceId: UDID,
          deviceNameMatches: is("iPhone 17 [ink-and-quill]"),
        })
      );
      expect(getFailureSignal(err)).toMatchObject(MISMATCH_SIGNAL);
      expect(err.message).toMatch(/cannot be told apart by name/);
      expect(err.message).toMatch(/27fb9b61.*aa11bb22/);
    });

    it("refuses when no device has the name", () => {
      const err = thrownBy(() =>
        selectTarget([iphone, proMax], 9001, {
          deviceId: UDID,
          deviceNameMatches: is("iPhone 17 [ink-and-quill]"),
        })
      );
      expect(getFailureSignal(err)).toMatchObject(MISMATCH_SIGNAL);
    });

    it("keeps a matching logicalDeviceId ahead of the name", () => {
      const result = selectTarget([iphone, named], 9001, {
        deviceId: "d4d1e970",
        deviceNameMatches: is("iPhone 17 [ink-and-quill]"),
      });
      expect(result.target.id).toBe("dev1");
    });

    it("picks the device's app runtime among its several targets", () => {
      const worklet = makeTarget({
        id: "dev3-2",
        title: "Reanimated UI runtime",
        deviceName: "iPhone 17 [ink-and-quill]",
        reactNative: { logicalDeviceId: "27fb9b61" },
      });
      const result = selectTarget([iphone, worklet, named], 9001, {
        deviceId: UDID,
        deviceNameMatches: is("iPhone 17 [ink-and-quill]"),
      });
      expect(result.target.id).toBe("dev3");
    });

    it("says when the device was found by name, and only then", () => {
      const byName = selectTarget([iphone, named], 9001, {
        deviceId: UDID,
        deviceNameMatches: is("iPhone 17 [ink-and-quill]"),
      });
      expect(byName.matchedByName).toBe(true);
      expect(selectTarget([iphone, named], 9001, { deviceId: "d4d1e970" }).matchedByName).toBe(
        false
      );
    });

    describe("once the udid is pinned to the logicalDeviceId its name led to", () => {
      const pinnedTo = (logicalDeviceId: string) => ({
        deviceId: UDID,
        deviceNameMatches: is("iPhone 17 [ink-and-quill]"),
        pinnedLogicalDeviceId: logicalDeviceId,
      });

      it("picks the pinned device without asking for its name", () => {
        const result = selectTarget([iphone, named], 9001, {
          deviceId: UDID,
          pinnedLogicalDeviceId: "27fb9b61",
        });
        expect(result.target.id).toBe("dev3");
        expect(result.matchedByName).toBe(false);
      });

      it("refuses the only other device after the pinned one left", () => {
        // Seen on Metro first, as the connect that pinned it saw it.
        selectTarget([iphone, named], 9001, pinnedTo("27fb9b61"));
        const err = thrownBy(() => selectTarget([iphone], 9001, pinnedTo("27fb9b61")));
        expect(getFailureSignal(err)).toMatchObject({
          error_code: FAILURE_CODES.DEBUGGER_METRO_NO_TARGETS,
        });
        expect(err.message).toMatch(/"27fb9b61", which device_id "B7D5711C-[^"]+" was matched/);
        expect(err.message).toMatch(/no longer attached/);
      });

      it("finds the device again by name when its app came back under a new id", () => {
        const reinstalled = device("dev5", "iPhone 17 [ink-and-quill]", "0f0f0f0f");
        const result = selectTarget([iphone, reinstalled], 9001, pinnedTo("27fb9b61"));
        expect(result.target.id).toBe("dev5");
        expect(result.matchedByName).toBe(true);
      });
    });
  });

  it("the ambiguous-mismatch error carries the DEBUGGER_TARGET_DEVICE_MISMATCH signal", () => {
    // The message is contract (asserted above and matched on by agents); the
    // signal gives telemetry a dedicated code — instead of the catch-all
    // service-initialization bucket — and lets debugger-status map the error
    // to the "device_mismatch" reason.
    const dev1 = makeTarget({ id: "dev1", reactNative: { logicalDeviceId: "aaa" } });
    const dev2 = makeTarget({ id: "dev2", reactNative: { logicalDeviceId: "bbb" } });
    let thrown: unknown;
    try {
      selectTarget([dev1, dev2], 8081, { deviceId: "unmatched" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(getFailureSignal(thrown)).toMatchObject({
      error_code: FAILURE_CODES.DEBUGGER_TARGET_DEVICE_MISMATCH,
      failure_stage: "debugger_select_target",
      failure_area: "tool_server",
      error_kind: "not_found",
    });
  });

  it("surfaces deviceName alongside logicalDeviceId so the caller can map ids to devices", () => {
    const ipad = makeTarget({
      id: "dev1",
      deviceName: "iPad Pro",
      reactNative: { logicalDeviceId: "9e7844f7" },
    });
    const iphone = makeTarget({
      id: "dev2",
      deviceName: "iPhone 16",
      reactNative: { logicalDeviceId: "8a44101d" },
    });

    // Each listed device shows its human-readable name next to the hash.
    expect(() => selectTarget([ipad, iphone], 8081, { deviceId: "some-udid" })).toThrow(
      /iPad Pro \(9e7844f7\).*iPhone 16 \(8a44101d\)/
    );
  });

  it("falls back to the bare logicalDeviceId when a device has no deviceName", () => {
    const named = makeTarget({
      id: "dev1",
      deviceName: "iPhone 16",
      reactNative: { logicalDeviceId: "aaa" },
    });
    const unnamed = makeTarget({ id: "dev2", reactNative: { logicalDeviceId: "bbb" } });

    expect(() => selectTarget([named, unnamed], 8081, { deviceId: "unmatched" })).toThrow(
      /iPhone 16 \(aaa\).*bbb/
    );
  });

  it("still falls back to the only device when a single device is connected", () => {
    // Single-device convenience: callers may pass an id Metro never echoes (e.g.
    // an iOS simulator UDID, which is not the logicalDeviceId). With one device
    // there is no ambiguity, so selection must succeed via fallback.
    const fusebox = makeTarget({
      id: "only",
      reactNative: {
        logicalDeviceId: "real-logical-id",
        capabilities: { prefersFuseboxFrontend: true },
      },
    });
    const uiPage = makeTarget({
      id: "only-ui",
      reactNative: { logicalDeviceId: "real-logical-id" },
    });

    const result = selectTarget([fusebox, uiPage], 8081, { deviceId: "some-ios-udid" });
    expect(result.target.id).toBe("only");
  });

  it("falls back when no target exposes a logicalDeviceId at all", () => {
    // Old-arch / pre-Fusebox targets omit reactNative.logicalDeviceId entirely.
    const t1 = makeTarget({ id: "first" });
    const t2 = makeTarget({
      id: "second",
      reactNative: { capabilities: { prefersFuseboxFrontend: true } },
    });

    const result = selectTarget([t1, t2], 8081, { deviceId: "anything" });
    expect(result.target.id).toBe("second");
  });

  it("names a Mac app by its bundle id, not its deviceName, when a non-Mac id matches no device", () => {
    const mac = macTarget("com.example.app");
    const ios = iosTarget("com.example.app");

    const err = thrownBy(() => selectTarget([mac, ios], 8081, { deviceId: "some-udid" }));

    expect(err.message).toContain(
      `devices are connected to Metro on port 8081: Mac app com.example.app (${mac.reactNative!.logicalDeviceId}), ` +
        `iPhone 17 Pro (${ios.reactNative!.logicalDeviceId}).`
    );
    // A react-native-macos runtime registers its deviceName as "Unknown".
    expect(err.message).not.toContain("Unknown (");
    expect(getFailureSignal(err)).toMatchObject(MISMATCH_SIGNAL);
  });

  it("matches an iOS logicalDeviceId exactly when a Mac app of the same bundle id shares Metro", () => {
    const mac = macTarget("com.example.app");
    const ios = iosTarget("com.example.app");

    const result = selectTarget([mac, ios], 8081, {
      deviceId: ios.reactNative!.logicalDeviceId,
    });

    expect(result.target.id).toBe(ios.id);
  });
  describe("when a previously attached device has left Metro", () => {
    // Real repro: an iOS simulator and an Android emulator share Metro 8081.
    // The Android app dies, so its target disappears. A call still naming the
    // Android logicalDeviceId must not fall back to the iPhone.
    const IPHONE_ID = "f8e3d987f6b3e9268503fc0fcb3d5d9f1da875d9";
    const ANDROID_ID = "904f32cb7611d7a43b99a5276e18506a3505b892";

    const iphone = () =>
      makeTarget({
        id: "iphone",
        deviceName: "iPhone 17 Pro",
        webSocketDebuggerUrl: "ws://localhost:8081/inspector/debug?device=0&page=1",
        reactNative: { logicalDeviceId: IPHONE_ID, capabilities: { prefersFuseboxFrontend: true } },
      });
    const android = () =>
      makeTarget({
        id: "android",
        deviceName: "sdk_gphone64_arm64 - 16 - API 36",
        webSocketDebuggerUrl: "ws://10.0.2.2:8081/inspector/debug?device=1&page=1",
        reactNative: {
          logicalDeviceId: ANDROID_ID,
          capabilities: { prefersFuseboxFrontend: true },
        },
      });

    function selectGoneAndroid(): unknown {
      selectTarget([iphone(), android()], 8081, { deviceId: IPHONE_ID });
      try {
        selectTarget([iphone()], 8081, { deviceId: ANDROID_ID });
      } catch (err) {
        return err;
      }
      return undefined;
    }

    it("throws a FailureError instead of routing to the remaining device", () => {
      const thrown = selectGoneAndroid();

      expect(thrown).toBeInstanceOf(FailureError);
    });

    it("carries the DEBUGGER_METRO_NO_TARGETS signal", () => {
      const thrown = selectGoneAndroid();

      expect(getFailureSignal(thrown)).toMatchObject({
        error_code: FAILURE_CODES.DEBUGGER_METRO_NO_TARGETS,
        failure_stage: "debugger_select_target",
        failure_area: "tool_server",
        error_kind: "not_found",
      });
    });

    it("names the requested id and says the device is no longer attached", () => {
      const thrown = selectGoneAndroid();

      expect((thrown as Error | undefined)?.message).toMatch(
        new RegExp(`${ANDROID_ID}[\\s\\S]*no longer attached`)
      );
    });

    it("names the device still on Metro so the caller is not misled", () => {
      const thrown = selectGoneAndroid();

      expect((thrown as Error | undefined)?.message).toContain(`iPhone 17 Pro (${IPHONE_ID})`);
    });

    it("still falls back for an id never seen as a logicalDeviceId", () => {
      // Earlier pools saw two logical ids; a simulator UDID is neither, so the
      // single-device convenience must still apply.
      selectTarget(
        [
          makeTarget({ id: "a", reactNative: { logicalDeviceId: "seen-a-1111" } }),
          makeTarget({
            id: "b",
            webSocketDebuggerUrl: "ws://localhost:8081/inspector/debug?device=1&page=1",
            reactNative: { logicalDeviceId: "seen-b-2222" },
          }),
        ],
        8081,
        { deviceId: "seen-a-1111" }
      );
      const only = makeTarget({ id: "only", reactNative: { logicalDeviceId: "seen-a-1111" } });

      const result = selectTarget([only], 8081, { deviceId: "B1C2D3E4-SIM-UDID" });

      expect(result.target.id).toBe("only");
    });

    it("routes to the device again once it re-attaches with the same logicalDeviceId", () => {
      selectTarget([iphone(), android()], 8081, { deviceId: IPHONE_ID });
      expect(() => selectTarget([iphone()], 8081, { deviceId: ANDROID_ID })).toThrow();

      const result = selectTarget([iphone(), android()], 8081, { deviceId: ANDROID_ID });

      expect(result.target.id).toBe("android");
    });

    it("after a reinstall changed the id, still refuses and points at the id shown for the device", () => {
      // iOS derives the id from identifierForVendor, which a reinstall can
      // reset: the same iPhone comes back under a new id while the agent still
      // holds the old one.
      const REINSTALLED_ID = "6c1f0e5ab9d24f7e8a3b1c2d4e5f60718293a4b5";
      const reinstalled = makeTarget({
        ...iphone(),
        reactNative: {
          logicalDeviceId: REINSTALLED_ID,
          capabilities: { prefersFuseboxFrontend: true },
        },
      });
      selectTarget([iphone(), android()], 8081, { deviceId: IPHONE_ID });

      let thrown: unknown;
      try {
        selectTarget([reinstalled], 8081, { deviceId: IPHONE_ID });
      } catch (err) {
        thrown = err;
      }

      expect(getFailureSignal(thrown)?.error_code).toBe(FAILURE_CODES.DEBUGGER_METRO_NO_TARGETS);
      const message = (thrown as Error).message;
      expect(message).toContain(`iPhone 17 Pro (${REINSTALLED_ID})`);
      expect(message).toMatch(/reinstall-app[\s\S]*retry with the id shown for it/);
    });
  });

  describe("when a logicalDeviceId this process has not seen matches no target", () => {
    // Real repro: a fresh tool-server, Metro serving an iOS simulator and an
    // Android emulator. The simulator's app is stopped before the first call,
    // so Metro lists only the emulator, and the first call names the
    // simulator's logicalDeviceId, which this process has never listed.
    const SIMULATOR_ID = "8e8a3f0c5b1d4e2f9a7c6b5d4e3f2a1b0c9d8e7f";
    const EMULATOR_ID = "6661c0de5ab9d24f7e8a3b1c2d4e5f60718293a4";

    const emulator = () =>
      makeTarget({
        id: "emulator",
        deviceName: "sdk_gphone64_arm64 - 14 - API 34",
        webSocketDebuggerUrl: "ws://10.0.2.2:8081/inspector/debug?device=1&page=1",
        reactNative: {
          logicalDeviceId: EMULATOR_ID,
          capabilities: { prefersFuseboxFrontend: true },
        },
      });
    const simulator = () =>
      makeTarget({
        id: "simulator",
        deviceName: "iPhone 17 Pro",
        webSocketDebuggerUrl: "ws://localhost:8081/inspector/debug?device=0&page=1",
        reactNative: {
          logicalDeviceId: SIMULATOR_ID,
          capabilities: { prefersFuseboxFrontend: true },
        },
      });

    function selectUnattachedSimulator(): unknown {
      try {
        selectTarget([emulator()], 8081, { deviceId: SIMULATOR_ID });
      } catch (err) {
        return err;
      }
      return undefined;
    }

    it("refuses with DEBUGGER_METRO_NO_TARGETS instead of routing to the only device", () => {
      const thrown = selectUnattachedSimulator();

      expect(thrown).toBeInstanceOf(FailureError);
      expect(getFailureSignal(thrown)).toMatchObject({
        error_code: FAILURE_CODES.DEBUGGER_METRO_NO_TARGETS,
        failure_stage: "debugger_select_target",
        failure_area: "tool_server",
        error_kind: "not_found",
      });
    });

    it("says the id is not attached, not that it left, and names the device Metro lists", () => {
      const message = (selectUnattachedSimulator() as Error | undefined)?.message;

      expect(message).toContain(`"${SIMULATOR_ID}" is not attached to Metro on port 8081`);
      expect(message).not.toContain("no longer attached");
      expect(message).toContain(`sdk_gphone64_arm64 - 14 - API 34 (${EMULATOR_ID})`);
    });

    it("routes to the device once its app attaches", () => {
      expect(selectUnattachedSimulator()).toBeInstanceOf(FailureError);

      const result = selectTarget([emulator(), simulator()], 8081, { deviceId: SIMULATOR_ID });

      expect(result.target.id).toBe("simulator");
    });

    it("still falls back for a simulator UDID or an emulator serial", () => {
      expect(
        selectTarget([emulator()], 8081, { deviceId: "B1C2D3E4-5F60-4718-9A2B-3C4D5E6F7A8B" })
          .target.id
      ).toBe("emulator");
      expect(selectTarget([emulator()], 8081, { deviceId: "emulator-5554" }).target.id).toBe(
        "emulator"
      );
    });
  });
});

/**
 * One entry of GET /json/list from a React Native 0.88.1 Debug app built for Mac
 * Catalyst, verbatim, and the identifierForVendor its argent library reported.
 */
const REAL_CATALYST_TARGET = JSON.parse(
  '{"id":"fad0a40568545e50e14146aed7b9d140fb09f1cb-1","title":"com.argentcat.prof.rncat (iPad)",' +
    '"description":"React Native Bridgeless [C++ connection]","appId":"com.argentcat.prof.rncat",' +
    '"type":"node","webSocketDebuggerUrl":"ws://127.0.0.1:8995/inspector/debug?device=' +
    'fad0a40568545e50e14146aed7b9d140fb09f1cb&page=1","deviceName":"iPad","reactNative":' +
    '{"logicalDeviceId":"fad0a40568545e50e14146aed7b9d140fb09f1cb","capabilities":' +
    '{"prefersFuseboxFrontend":true,"nativeSourceCodeFetching":false,"nativePageReloads":true}}}'
) as CDPTarget;
const REAL_CATALYST_VENDOR_ID = "3F3B75E2-A9D2-585E-9ADF-8A1405F6525A";

describe("selectTarget on a Mac app id", () => {
  // A fresh module per test, as in the describe above.
  beforeEach(async () => {
    trackedCatalystApps.clear();
    vi.resetModules();
    ({ selectTarget } = await import("../../src/utils/debugger/target-selection"));
  });

  it("picks a real Mac Catalyst runtime by the identifierForVendor its library reported", () => {
    // Pins the formula: the hash in the fixture is the one the app sent.
    expect(appleLogicalId("com.argentcat.prof.rncat", { vendorId: REAL_CATALYST_VENDOR_ID })).toBe(
      REAL_CATALYST_TARGET.reactNative!.logicalDeviceId
    );
    // The same app on an iOS simulator, which has another vendor id.
    const ios = iosTarget("com.argentcat.prof.rncat");
    trackedCatalystApps.set("com.argentcat.prof.rncat", REAL_CATALYST_VENDOR_ID);

    for (const targets of [
      [REAL_CATALYST_TARGET],
      [ios, REAL_CATALYST_TARGET],
      [REAL_CATALYST_TARGET, ios],
    ]) {
      const result = selectTarget(targets, 8995, {
        deviceId: "macos-app-com.argentcat.prof.rncat",
      });
      expect(result.target.id).toBe("fad0a40568545e50e14146aed7b9d140fb09f1cb-1");
      expect(result.isNewDebugger).toBe(true);
    }
    // The app reads as a Mac app where Metro's devices are listed.
    const err = thrownBy(() =>
      selectTarget([REAL_CATALYST_TARGET], 8995, { deviceId: "macos-app-com.example.app" })
    );
    expect(err.message).toContain(
      "Metro lists: Mac app com.argentcat.prof.rncat (fad0a40568545e50e14146aed7b9d140fb09f1cb)."
    );
  });

  it("refuses a Mac Catalyst app whose identifierForVendor argent does not know, and says how to get it", () => {
    // Started by an argent whose library did not report it.
    trackedCatalystApps.set("com.argentcat.prof.rncat", null);

    const err = thrownBy(() =>
      selectTarget([REAL_CATALYST_TARGET], 8995, {
        deviceId: "macos-app-com.argentcat.prof.rncat",
      })
    );

    expect(err.message).toContain(
      "No JS runtime of the Mac app com.argentcat.prof.rncat is connected to Metro on port 8995. " +
        "Metro lists: iPad (fad0a40568545e50e14146aed7b9d140fb09f1cb). argent does not know the " +
        "identifierForVendor of the Mac Catalyst app com.argentcat.prof.rncat"
    );
    expect(err.message).toContain(
      "Run restart-app, then retry; if this message stays, update argent."
    );
    expect(err.message).toContain("React Native built for Mac Catalyst");
    expect(err.message).not.toContain("react-native-macos");
    expect(getFailureSignal(err)).toMatchObject(MISMATCH_SIGNAL);
  });

  it("does not take a react-native-macos runtime for a Mac Catalyst app of the same bundle id", () => {
    // The record says argent started the Mac Catalyst build: a runtime of an empty
    // vendor id is another process, with or without the Catalyst app's vendor id.
    const mac = macTarget("com.example.app");
    const ios = iosTarget("com.example.app");

    trackedCatalystApps.set("com.example.app", REAL_CATALYST_VENDOR_ID);
    const err = thrownBy(() =>
      selectTarget([ios, mac], 8081, { deviceId: "macos-app-com.example.app" })
    );
    expect(getFailureSignal(err)).toMatchObject(MISMATCH_SIGNAL);
    expect(err.message).not.toContain("argent does not know the identifierForVendor");

    trackedCatalystApps.set("com.example.app", null);
    const noVendorId = thrownBy(() =>
      selectTarget([mac], 8081, { deviceId: "macos-app-com.example.app" })
    );
    expect(getFailureSignal(noVendorId)).toMatchObject(MISMATCH_SIGNAL);
    expect(noVendorId.message).toContain("argent does not know the identifierForVendor");
  });

  it("picks a real react-native-macos 0.83 runtime, whose inspector id hashes the bundle id alone", () => {
    // Pins the formula: the hash in the fixture is the one the app sent.
    expect(appleLogicalId("com.example.focus.rnprof")).toBe(
      REAL_MAC_TARGET.reactNative!.logicalDeviceId
    );
    const ios = iosTarget("com.example.focus.rnprof");

    for (const targets of [[REAL_MAC_TARGET], [ios, REAL_MAC_TARGET], [REAL_MAC_TARGET, ios]]) {
      const result = selectTarget(targets, 8297, {
        deviceId: "macos-app-com.example.focus.rnprof",
      });
      expect(result.target.id).toBe("d73eedec912893ff31dd6ec1a39d2d23a126f495-1");
      expect(result.isNewDebugger).toBe(true);
      expect(result.webSocketUrl).toBe(
        "ws://localhost:8297/inspector/debug?device=d73eedec912893ff31dd6ec1a39d2d23a126f495&page=1"
      );
    }
  });

  it("picks the Mac app's runtime over an iOS simulator running the same bundle id, in either order", () => {
    const mac = macTarget("com.example.app");
    const ios = iosTarget("com.example.app");
    // Both fusebox targets: priority alone would pick whichever comes first.
    expect(
      selectTarget([ios, mac], 8081, { deviceId: "macos-app-com.example.app" }).target.id
    ).toBe(mac.id);
    expect(
      selectTarget([mac, ios], 8081, { deviceId: "macos-app-com.example.app" }).target.id
    ).toBe(mac.id);
  });

  it("picks each of two Mac apps on one Metro by its own bundle id", () => {
    const one = macTarget("com.example.one");
    const two = macTarget("com.example.two");

    expect(
      selectTarget([one, two], 8081, { deviceId: "macos-app-com.example.one" }).target.id
    ).toBe(one.id);
    expect(
      selectTarget([one, two], 8081, { deviceId: "macos-app-com.example.two" }).target.id
    ).toBe(two.id);
  });

  it("reads the bundle id from description on Metro 0.76, which sends no appId", () => {
    const mac = macTarget("com.example.app", {
      appId: undefined,
      title: "React Native Bridgeless [C++ connection]",
      description: "com.example.app",
    });
    const ios = iosTarget("com.example.app", {
      appId: undefined,
      title: "React Native Bridgeless [C++ connection]",
      description: "com.example.app",
    });

    for (const targets of [
      [ios, mac],
      [mac, ios],
    ]) {
      expect(selectTarget(targets, 8081, { deviceId: "macos-app-com.example.app" }).target.id).toBe(
        mac.id
      );
    }
  });

  it("matches an inspector id with the legacy suffix", () => {
    const other = macTarget("com.example.other");
    const logicalDeviceId = appleLogicalId("com.example.app", { mode: "legacy" });
    const legacy = macTarget("com.example.app", {
      id: `${logicalDeviceId}-1`,
      reactNative: { logicalDeviceId },
    });

    const result = selectTarget([other, legacy], 8081, { deviceId: "macos-app-com.example.app" });

    expect(result.target.id).toBe(legacy.id);
  });

  it("compares bundle ids without case, both ways", () => {
    // The hash is of the bundle id as the app registered it. The iOS target
    // comes first, so only a match picks the Mac app.
    const ios = iosTarget("com.example.app");
    const mixedCase = macTarget("com.Example.App");
    expect(
      selectTarget([ios, mixedCase], 8081, { deviceId: "macos-app-com.example.app" }).target.id
    ).toBe(mixedCase.id);
    const lowerCase = macTarget("com.example.app");
    expect(
      selectTarget([ios, lowerCase], 8081, { deviceId: "macos-app-COM.EXAMPLE.APP" }).target.id
    ).toBe(lowerCase.id);
  });

  it("refuses, instead of falling back to the one device, when only another app is on Metro", () => {
    const other = macTarget("com.example.other");

    const err = thrownBy(() =>
      selectTarget([other], 8081, { deviceId: "macos-app-com.example.app" })
    );

    expect(err.message).toContain(
      "No JS runtime of the Mac app com.example.app is connected to Metro on port 8081. " +
        `Metro lists: Mac app com.example.other (${other.reactNative!.logicalDeviceId}).`
    );
    // The usual cause: the app quit, crashed or was not started yet.
    expect(err.message).toContain("If the app does not run, start it (launch-app)");
    expect(getFailureSignal(err)).toMatchObject(MISMATCH_SIGNAL);
  });

  it.each(["macos-app-com.other_app", "macos-app-"])(
    "refuses %s, a Mac app id macOS cannot name, instead of falling back to the one device",
    (deviceId) => {
      // The capability gate admits a Mac app id by its prefix alone.
      for (const lone of [macTarget("com.example.app"), iosTarget("com.example.app")]) {
        const err = thrownBy(() => selectTarget([lone], 8081, { deviceId }));

        expect(err.message).toContain("is connected to Metro on port 8081. Metro lists: ");
        expect(getFailureSignal(err)).toMatchObject(MISMATCH_SIGNAL);
      }
    }
  );

  it("refuses when only an iOS simulator runs the same bundle id, and lists that device", () => {
    const ios = iosTarget("com.example.app");
    const legacy = makeTarget({ id: "0-1", title: "Hermes React Native" });

    const err = thrownBy(() =>
      selectTarget([ios, legacy], 8081, { deviceId: "macos-app-com.example.app" })
    );

    expect(err.message).toContain(
      `Metro lists: iPhone 17 Pro (${ios.reactNative!.logicalDeviceId}), ` +
        "unknown (legacy inspector — no logicalDeviceId)."
    );
    expect(err.message).not.toContain("Mac app com.example.app (");
    expect(getFailureSignal(err)).toMatchObject(MISMATCH_SIGNAL);
  });

  it("does not read a target with no logicalDeviceId as a Mac app", () => {
    // A legacy inspector page carries no inspector id, so its description says nothing.
    const legacy = makeTarget({ id: "0-1", description: "com.example.app" });

    const err = thrownBy(() =>
      selectTarget([legacy], 8081, { deviceId: "macos-app-com.example.app" })
    );

    expect(getFailureSignal(err)).toMatchObject(MISMATCH_SIGNAL);
  });
});
