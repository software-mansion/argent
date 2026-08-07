/**
 * Follow-up coverage for the physical-iOS (CoreDevice) feature. These tests pin
 * behaviors that the original physical-ios.test.ts left uncovered and that a
 * regression could silently break:
 *
 *  - discovery must NOT surface the host's iOS simulators as phantom physical
 *    devices (devicectl enumerates them with transportType "sameMachine");
 *  - `button` routes a physical iPhone to the sim-server `ios_device` controller
 *    and rejects the buttons with no hardware HID equivalent;
 *  - launch-app enforces the opt-in flag itself (it shells `devicectl`, not the
 *    sim-server, so it can't ride the factory's gate);
 *  - tools that are unsupported on physical iOS reject with a 400-mapped
 *    UnsupportedOperationError, not a generic 500 (the native-devtools family,
 *    the multi-touch gestures), while `describe` returns the CoreDevice ax tree
 *    and stays supported on simulators/Android;
 *  - run-sequence must not eagerly hold simulator-server for a physical iPhone;
 *  - gesture-swipe routes a physical iPhone to the sim-server and honors `settle`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// assertPhysicalIosEnabled reads the feature flag; mock isFlagEnabled so the gate
// can be exercised deterministically regardless of the host's ~/.argent/flags.json.
// (See variant-flag-gate.test.ts for the same pattern.)
vi.mock("@argent/configuration-core", () => ({ isFlagEnabled: vi.fn() }));
import { isFlagEnabled } from "@argent/configuration-core";

import { resolveDevice, isPhysicalIosUdid } from "../src/utils/device-info";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";
import { parsePhysicalIosDevices } from "../src/utils/ios-devices";
import { UnsupportedOperationError, assertSupported } from "../src/utils/capability";
import type { ToolCapability } from "@argent/registry";
import { assertPhysicalIosEnabled, subcommandForDevice } from "../src/blueprints/simulator-server";
import { buttonTool } from "../src/tools/button";
import { createBootDeviceTool } from "../src/tools/devices/boot-device";
import { createRunSequenceTool } from "../src/tools/run-sequence";
import { describeIos } from "../src/tools/describe/platforms/ios";
import { makeIosImpl as makeLaunchAppIosImpl } from "../src/tools/launch-app/platforms/ios";
import { gestureSwipeTool } from "../src/tools/gesture-swipe";
import { gestureTapTool } from "../src/tools/gesture-tap";
import { createKeyboardTool } from "../src/tools/keyboard";
import { gesturePinchTool } from "../src/tools/gesture-pinch";
import { gestureRotateTool } from "../src/tools/gesture-rotate";
import { gestureCustomTool } from "../src/tools/gesture-custom";
import { pasteTool } from "../src/tools/paste";
import { rotateTool } from "../src/tools/rotate";
import { createTvRemoteTool } from "../src/tools/tv-remote";
import { createAwaitScreenIdleTool } from "../src/tools/await-screen-idle";
import { reinstallAppTool } from "../src/tools/reinstall-app";
import { createScreenRecordingStartTool } from "../src/tools/screen-recording/screen-recording-start";
import { screenRecordingStopTool } from "../src/tools/screen-recording/screen-recording-stop";
import { profilerLoadTool } from "../src/tools/profiler/query/profiler-load";
import { screenshotDiffTool } from "../src/tools/screenshot-diff";
import { nativeDescribeScreenTool } from "../src/tools/native-devtools/native-describe-screen";
import { nativeDevtoolsStatusTool } from "../src/tools/native-devtools/native-devtools-status";
import { nativeFindViewsTool } from "../src/tools/native-devtools/native-find-views";
import { nativeFullHierarchyTool } from "../src/tools/native-devtools/native-full-hierarchy";
import { nativeNetworkLogsTool } from "../src/tools/native-devtools/native-network-logs";
import { nativeViewAtPointTool } from "../src/tools/native-devtools/native-view-at-point";
import { nativeUserInteractableViewAtPointTool } from "../src/tools/native-devtools/native-user-interactable-view-at-point";
import { nativeProfilerStartTool } from "../src/tools/profiler/native-profiler/native-profiler-start";
import { nativeProfilerStopTool } from "../src/tools/profiler/native-profiler/native-profiler-stop";
import { nativeProfilerAnalyzeTool } from "../src/tools/profiler/native-profiler/native-profiler-analyze";
import { profilerStackQueryTool } from "../src/tools/profiler/query/profiler-stack-query";
import { profilerCombinedReportTool } from "../src/tools/profiler/combined/profiler-combined-report";

const mockFlag = vi.mocked(isFlagEnabled);

// The opt-in gate runs on every `simulatorServerRef` call, so any case that
// resolves the sim-server needs the flag on. Default it here rather than in the
// individual cases: an unset mock returns undefined (= disabled), which would
// otherwise make every physical-iOS case depend on whichever earlier case last
// set the mock.
beforeEach(() => {
  mockFlag.mockReturnValue(true);
});

// The physical-iOS branch throws/rejects before ever touching `registry` (see
// the assertions below), so a stub registry is safe here.
const launchAppIos = makeLaunchAppIosImpl({} as never);
const keyboardTool = createKeyboardTool({} as never);

const PHYSICAL_UDID = "00008120-000E6D0C0ABBA01E";
const SIM_UDID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";

describe("discovery does not surface simulators as physical devices", () => {
  // Real `xcrun devicectl list devices` JSON also lists every host iOS
  // simulator (platform "iOS", transportType "sameMachine"); without the
  // UDID-shape gate those leak in as phantom physical devices.
  const data = {
    result: {
      devices: [
        // The real, connected iPhone — KEPT.
        {
          hardwareProperties: { udid: PHYSICAL_UDID, platform: "iOS", productType: "iPhone15,4" },
          deviceProperties: { name: "Real iPhone" },
          connectionProperties: { transportType: "wired", tunnelState: "disconnected" },
        },
        // A booted iOS simulator (UUID shape, sameMachine transport) — DROPPED.
        {
          hardwareProperties: { udid: SIM_UDID, platform: "iOS", productType: "iPhone17,2" },
          deviceProperties: { name: "iPhone 16 Pro Max" },
          connectionProperties: { transportType: "sameMachine", tunnelState: "connected" },
        },
        // A shut-down simulator (UUID shape) — DROPPED (would otherwise be
        // reported as a "connected" device).
        {
          hardwareProperties: {
            udid: "39646432-58B6-4A21-923A-00F0EDE4FF81",
            platform: "iOS",
            productType: "iPhone17,3",
          },
          deviceProperties: { name: "iPhone 16" },
          connectionProperties: { transportType: "sameMachine", tunnelState: "disconnected" },
        },
        // A paired-but-offline real device (physical shape, no transport) — DROPPED.
        // Isolates the `!transport` filter: its tunnelState is NOT "unavailable",
        // so only the transport check can drop it.
        {
          hardwareProperties: {
            udid: "00008030-00096526219B802E",
            platform: "iOS",
            productType: "iPhone12,8",
          },
          deviceProperties: { name: "Old iPhone" },
          connectionProperties: { tunnelState: "disconnected" },
        },
        // Unplugged mid-session: the transport lingers but the tunnel is gone —
        // DROPPED. Isolates the `tunnelState === "unavailable"` filter, which the
        // transport check cannot cover.
        {
          hardwareProperties: {
            udid: "00008101-000A4D2E0EC0001E",
            platform: "iOS",
            productType: "iPhone14,2",
          },
          deviceProperties: { name: "Unplugged iPhone" },
          connectionProperties: { transportType: "wired", tunnelState: "unavailable" },
        },
      ],
    },
  };

  it("returns only the real physical iPhone", () => {
    const out = parsePhysicalIosDevices(data);
    expect(out).toEqual([
      { udid: PHYSICAL_UDID, name: "Real iPhone", productType: "iPhone15,4", state: "connected" },
    ]);
  });

  it("every returned device has a physical-shape UDID", () => {
    for (const d of parsePhysicalIosDevices(data)) {
      expect(isPhysicalIosUdid(d.udid)).toBe(true);
    }
  });
});

describe("button on physical iOS routes to the sim-server ios_device controller", () => {
  // A physical iPhone drives the sim-server `ios_device` subcommand over the
  // same transport as a simulator, and the Consumer-page HID mapping lives in
  // the sim-server controller. Only the four hardware buttons are supported;
  // appSwitch/actionButton have no HID equivalent and are rejected (rather than
  // otherwise surface the controller's rejection).
  it("resolves the simulator-server for the four hardware buttons", () => {
    for (const button of ["home", "power", "volumeUp", "volumeDown"]) {
      const services = buttonTool.services!({ udid: PHYSICAL_UDID, button } as never);
      expect(services.simulatorServer).toBeDefined();
      expect(services.coreDevice).toBeUndefined();
    }
  });

  it("rejects buttons with no physical-iOS HID equivalent", async () => {
    const press = (button: string) =>
      buttonTool.execute({} as never, { udid: PHYSICAL_UDID, button } as never);
    await expect(press("appSwitch")).rejects.toBeInstanceOf(UnsupportedOperationError);
    await expect(press("actionButton")).rejects.toBeInstanceOf(UnsupportedOperationError);
  });

  it("does not resolve any service for an unsupported button (no wasted spawn)", () => {
    // services() runs before execute(); resolving the sim-server for a button
    // execute() will reject anyway would pay a spawn + ready-wait for nothing.
    for (const button of ["appSwitch", "actionButton"]) {
      const services = buttonTool.services!({ udid: PHYSICAL_UDID, button } as never);
      expect(services.simulatorServer).toBeUndefined();
    }
  });
});

describe("boot-device on physical iOS prepares the sim-server session", () => {
  // There is nothing to boot on hardware, so boot resolves (spawns) the
  // sim-server's `ios_device` controller, which owns the one USB tunnel. Assert
  // boot resolves exactly that service and reports booted: any other way of
  // reaching the device would resolve no SimulatorServer service.
  it("resolves the simulator-server for the physical udid and returns booted", async () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    mockFlag.mockReturnValue(true);
    try {
      const resolved: string[] = [];
      const registry = {
        resolveService: async (urn: string) => {
          resolved.push(urn);
          return {};
        },
      };
      const tool = createBootDeviceTool(registry as never);
      const res = await tool.execute({} as never, { udid: PHYSICAL_UDID } as never);
      expect(res).toEqual({ platform: "ios", udid: PHYSICAL_UDID, booted: true });
      expect(resolved).toEqual([`SimulatorServer:${PHYSICAL_UDID}`]);
    } finally {
      Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
    }
  });

  it("recycles the session on force, and waits for the new one before reporting booted", async () => {
    // Two promises the tool's description makes. `force` is the only in-band
    // recovery from a session whose tunnel died (phone unplugged and replugged,
    // or rebooted): without the dispose the registry hands back the dead cached
    // instance and the call reports `booted: true` having done nothing. And a
    // boot that does not await the resolve reports success before the CoreDevice
    // session is up — which is the whole point of preparing it here, so a locked
    // or untrusted phone surfaces now instead of on the first tap.
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    mockFlag.mockReturnValue(true);
    try {
      const order: string[] = [];
      let releaseResolve: (() => void) | undefined;
      const registry = {
        disposeService: async (urn: string) => {
          order.push(`dispose:${urn}`);
        },
        resolveService: async (urn: string) => {
          order.push(`resolve:${urn}`);
          await new Promise<void>((r) => (releaseResolve = r));
          order.push(`resolved:${urn}`);
          return {};
        },
      };
      const tool = createBootDeviceTool(registry as never);

      const pending = tool.execute(
        {} as never,
        {
          udid: PHYSICAL_UDID,
          force: true,
        } as never
      );
      // Give the tool a turn to reach the resolve, then check it has not
      // answered while the session is still coming up.
      await new Promise((r) => setImmediate(r));
      let settled = false;
      void pending.then(() => (settled = true));
      await new Promise((r) => setImmediate(r));
      expect(settled, "boot-device must not report booted before the session resolves").toBe(false);

      releaseResolve!();
      await expect(pending).resolves.toEqual({
        platform: "ios",
        udid: PHYSICAL_UDID,
        booted: true,
      });
      // Dispose first: recycling means the cached instance is gone before the
      // new one is built, not alongside it.
      expect(order).toEqual([
        `dispose:SimulatorServer:${PHYSICAL_UDID}`,
        `resolve:SimulatorServer:${PHYSICAL_UDID}`,
        `resolved:SimulatorServer:${PHYSICAL_UDID}`,
      ]);
    } finally {
      Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
    }
  });

  it("does not dispose anything without force", async () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    mockFlag.mockReturnValue(true);
    try {
      const disposed: string[] = [];
      const registry = {
        disposeService: async (urn: string) => {
          disposed.push(urn);
        },
        resolveService: async () => ({}),
      };
      const tool = createBootDeviceTool(registry as never);
      await tool.execute({} as never, { udid: PHYSICAL_UDID } as never);
      expect(disposed).toEqual([]);
    } finally {
      Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
    }
  });
});

describe("launch-app enforces the physical-iOS flag (no bypass)", () => {
  // launch-app drives a real device via `devicectl` directly (not the
  // CoreDevice service), so unlike screenshot/tap/swipe it must enforce the
  // opt-in itself — otherwise it would be the one physical-iOS operation
  // reachable while the feature is disabled.
  it("assertPhysicalIosEnabled throws when the flag is off, not when on", () => {
    mockFlag.mockReturnValue(false);
    expect(() => assertPhysicalIosEnabled()).toThrow(/Physical iOS support is disabled/);
    mockFlag.mockReturnValue(true);
    expect(() => assertPhysicalIosEnabled()).not.toThrow();
  });

  it("launch-app rejects a physical iPhone when the flag is off (before shelling devicectl)", async () => {
    mockFlag.mockReturnValue(false);
    await expect(
      launchAppIos.handler(
        {} as never,
        { udid: PHYSICAL_UDID, bundleId: "com.apple.Preferences" } as never,
        resolveDevice(PHYSICAL_UDID)
      )
    ).rejects.toThrow(/Physical iOS support is disabled.*argent enable physical-ios-devices/s);
  });
});

describe("gesture-swipe on physical iOS routes to the sim-server ios_device controller", () => {
  const swipe = {
    udid: PHYSICAL_UDID,
    fromX: 0.5,
    fromY: 0.7,
    toX: 0.5,
    toY: 0.3,
  };

  it("resolves the simulator-server, not a CoreDevice backend", () => {
    const services = gestureSwipeTool.services!(swipe as never);
    expect(services.simulatorServer).toBeDefined();
    expect(services.coreDevice).toBeUndefined();
  });

  it("supports settle on physical iOS too (same interpolated Move-sample path as a simulator)", () => {
    // The sim-server `ios_device` controller replays the eased Move samples the
    // generic swipe path emits, so `settle` is honored on hardware exactly as it
    // is on a simulator — no separate trajectory path.
    const services = gestureSwipeTool.services!({ ...swipe, settle: true } as never);
    expect(services.simulatorServer).toBeDefined();
    expect(services.coreDevice).toBeUndefined();
  });

  it("still honors settle on a simulator (no regression to simulator support)", () => {
    const services = gestureSwipeTool.services!({
      ...swipe,
      udid: SIM_UDID,
      settle: true,
    } as never);
    expect(services.simulatorServer).toBeDefined();
    expect(services.coreDevice).toBeUndefined();
  });
});

describe("gesture-custom on physical iOS: single contact only, rejected as a whole", () => {
  const touch = vi.fn();
  const services = () => ({ simulatorServer: { transport: { touch } } });

  beforeEach(() => touch.mockClear());

  it("dispatches a single-touch sequence", async () => {
    const result = await gestureCustomTool.execute(
      services() as never,
      {
        udid: PHYSICAL_UDID,
        events: [
          { type: "Down", x: 0.5, y: 0.7 },
          { type: "Move", x: 0.5, y: 0.5 },
          { type: "Up", x: 0.5, y: 0.3 },
        ],
      } as never
    );

    expect(result.events).toBe(3);
    expect(touch).toHaveBeenCalledTimes(3);
    expect(touch.mock.calls.map(([c]) => c.type)).toEqual(["Down", "Move", "Up"]);
    expect(touch.mock.calls.every(([c]) => c.secondX === undefined)).toBe(true);
  });

  it("rejects a second touch point before dispatching anything, so no contact is left down", async () => {
    await expect(
      gestureCustomTool.execute(
        services() as never,
        {
          udid: PHYSICAL_UDID,
          events: [
            { type: "Down", x: 0.5, y: 0.5 },
            { type: "Move", x: 0.4, y: 0.5, x2: 0.6, y2: 0.5 },
            { type: "Up", x: 0.3, y: 0.5, x2: 0.7, y2: 0.5 },
          ],
        } as never
      )
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
    // The `Down` before the offending event must NOT have gone out: a partial
    // dispatch would strand a finger on the screen with no `Up` to follow.
    expect(touch).not.toHaveBeenCalled();
  });

  it("refuses an event that carries only one of x2 / y2", async () => {
    // The guard is `x2 !== undefined || y2 !== undefined`; every other case here
    // sets both, so the second half is unexercised. A y2-only event would then
    // go out with `second_y` set on a digitizer that has one contact.
    for (const half of [{ x2: 0.6 }, { y2: 0.7 }]) {
      await expect(
        gestureCustomTool.execute(
          services() as never,
          {
            udid: PHYSICAL_UDID,
            events: [
              { type: "Down", x: 0.5, y: 0.5 },
              { type: "Up", x: 0.5, y: 0.5, ...half },
            ],
          } as never
        ),
        JSON.stringify(half)
      ).rejects.toBeInstanceOf(UnsupportedOperationError);
      expect(touch, JSON.stringify(half)).not.toHaveBeenCalled();
    }
  });

  it("indexes the rejection against the caller's events, not the interpolated expansion", async () => {
    await expect(
      gestureCustomTool.execute(
        services() as never,
        {
          udid: PHYSICAL_UDID,
          events: [
            { type: "Down", x: 0.5, y: 0.5 },
            { type: "Up", x: 0.4, y: 0.5, x2: 0.6, y2: 0.5 },
          ],
          interpolate: 10,
        } as never
      )
    ).rejects.toThrow(/events\[1\]/);
  });

  it("still sends a two-finger sequence to a simulator (no regression)", async () => {
    const result = await gestureCustomTool.execute(
      services() as never,
      {
        udid: SIM_UDID,
        events: [
          { type: "Down", x: 0.4, y: 0.5, x2: 0.6, y2: 0.5 },
          { type: "Up", x: 0.2, y: 0.5, x2: 0.8, y2: 0.5 },
        ],
      } as never
    );

    expect(result.events).toBe(2);
    expect(touch.mock.calls.map(([c]) => c.secondX)).toEqual([0.6, 0.8]);
  });

  it("leaves a physical ANDROID phone's two-finger gestures alone", () => {
    // The guard narrows on platform AND kind, and a physical Android phone is
    // also `kind: "device"`. Every other case here uses an iPhone udid or a
    // simulator UUID, so dropping the platform half would silently take
    // two-contact gestures away from Android — where adb does drive them.
    const androidTwoTouch = {
      udid: "R5CT30ABCDE",
      events: [
        { type: "Down", x: 0.4, y: 0.5, x2: 0.6, y2: 0.5 },
        { type: "Up", x: 0.2, y: 0.5, x2: 0.8, y2: 0.5 },
      ],
    };
    expect(resolveDevice("R5CT30ABCDE")).toMatchObject({ platform: "android", kind: "device" });
    expect(Object.keys(gestureCustomTool.services!(androidTwoTouch as never))).toEqual([
      "simulatorServer",
    ]);
    return expect(
      gestureCustomTool.execute(services() as never, androidTwoTouch as never)
    ).resolves.toMatchObject({ events: 2 });
  });

  it("resolves no service for a request it is going to reject (no wasted spawn)", () => {
    // The registry resolves every declared service before calling execute, so a
    // ref here would bring the CoreDevice session up purely to reject — and on a
    // device whose session cannot start (locked, unplugged, Developer Mode off)
    // the caller would get that transport error instead of "this gesture needs
    // two contacts". Same shape as `button`'s no-HID-equivalent case above.
    const twoTouch = {
      udid: PHYSICAL_UDID,
      events: [
        { type: "Down", x: 0.5, y: 0.5 },
        { type: "Up", x: 0.4, y: 0.5, x2: 0.6, y2: 0.5 },
      ],
    };
    expect(Object.keys(gestureCustomTool.services!(twoTouch as never))).toEqual([]);

    // The single-touch half must still resolve one, or the tool stops working.
    const singleTouch = {
      udid: PHYSICAL_UDID,
      events: [
        { type: "Down", x: 0.5, y: 0.5 },
        { type: "Up", x: 0.5, y: 0.4 },
      ],
    };
    expect(Object.keys(gestureCustomTool.services!(singleTouch as never))).toEqual([
      "simulatorServer",
    ]);

    // …and a simulator keeps its two-finger support.
    expect(
      Object.keys(gestureCustomTool.services!({ ...twoTouch, udid: SIM_UDID } as never))
    ).toEqual(["simulatorServer"]);
  });
});

describe("tools unsupported on physical iOS reject with UnsupportedOperationError (400)", () => {
  const device = resolveDevice(PHYSICAL_UDID);

  // describe is NOT in the unsupported set: on a physical iPhone it returns the
  // real on-screen accessibility tree served by the simulator-server's CoreDevice
  // axAudit endpoint (`/api/ax-tree`), which works in-app and on the home screen.
  // A stub simulator-server api + fetch stand in here.
  it("describe — returns the CoreDevice accessibility tree (source coredevice-ax), not a rejection", async () => {
    const registry = {
      resolveService: async () => ({ apiUrl: "http://sim.test" }),
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      // The real payload: captions + reading order, no `screen`, no `rect`
      // (pinned on the producer side by radon's
      // `ax_tree_payload_carries_no_geometry`).
      json: async () => ({
        elements: [
          { caption: "General, Button", id: "e1" },
          { caption: "Accessibility, Button", id: "e2" },
        ],
      }),
    } as Response);
    try {
      const result = await describeIos(registry as never, device, {});
      expect(result.source).toBe("coredevice-ax");
      const flat = JSON.stringify(result.tree);
      expect(flat).toContain("General");
      expect(flat).toContain("Accessibility");
      expect(result.hint).toContain("screenshot");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("picks the hint by what the read returned, and bounds the read", async () => {
    // Every hint branch mentions `screenshot`, so asserting that alone leaves
    // the branch selection untested — an empty screen and a truncated one would
    // both be reported as an ordinary read.
    const registry = { resolveService: async () => ({ apiUrl: "http://sim.test" }) };
    const AX_LIMIT = 120;
    const call = async (count: number) => {
      const bodies: unknown[] = [];
      const signals: (AbortSignal | undefined)[] = [];
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (_url: unknown, init?: RequestInit) => {
          bodies.push(JSON.parse(String(init?.body)));
          signals.push(init?.signal ?? undefined);
          return {
            ok: true,
            status: 200,
            json: async () => ({
              elements: Array.from({ length: count }, (_, i) => ({
                caption: `Row ${i}, Button`,
                id: `e${i}`,
              })),
            }),
          } as Response;
        });
      try {
        return { result: await describeIos(registry as never, device, {}), bodies, signals };
      } finally {
        fetchSpy.mockRestore();
      }
    };

    // Nothing on screen: on hardware that is usually a locked or sleeping phone,
    // not an app that renders nothing — and the two need different actions.
    const empty = await call(0);
    expect(empty.result.hint).toMatch(/screen is off or locked/i);

    // A full read means the ceiling was hit, so "not found" is not proof of
    // absence and the agent must be told before it concludes otherwise.
    const full = await call(AX_LIMIT);
    expect(full.result.hint).toMatch(/Only the first 120 elements/);
    expect(full.result.hint).toMatch(/not proof of absence/);

    // A partial read is neither.
    const partial = await call(3);
    expect(partial.result.hint).not.toMatch(/screen is off or locked/i);
    expect(partial.result.hint).not.toMatch(/Only the first/);

    // The ceiling is requested explicitly rather than inherited from whichever
    // sim-server build is installed, and the read is bounded — a sleeping device
    // can otherwise leave describe hanging with no tool-layer timeout.
    expect(partial.bodies[0]).toEqual({ limit: AX_LIMIT });
    expect(partial.signals[0], "the ax-tree read must carry an abort signal").toBeInstanceOf(
      AbortSignal
    );
  });
});

describe("await-screen-idle settles on a physical iPhone despite the rotating read", () => {
  // Reproduces the device's actual behaviour: the accessibility read starts at
  // the VoiceOver cursor and advances it, so a completely still screen yields a
  // different ORDER on every call. Verified on hardware — three consecutive
  // reads of one Safari page gave three orderings of the same six elements.
  const STILL = ["Back, Button", "Page Menu, Button", "Address, x", "refresh, Button"];

  // These cases run the tool's `execute`, which preflights `xcrun` for any iOS
  // device. Unit tests run on Linux in CI, where it does not exist, so prime the
  // availability cache instead of shelling out — and clear it afterwards so the
  // priming does not leak into the rest of the file.
  beforeEach(() => __primeDepCacheForTests(["xcrun"]));
  afterEach(() => __resetDepCacheForTests());

  // `captionsFor` is called with the read index, so a case can keep producing
  // fresh screens indefinitely rather than running off the end of a fixed list
  // and repeating (which would settle for the wrong reason).
  function rotatingRegistry(captionsFor: (call: number) => string[], readDelayMs = 0) {
    let call = 0;
    const registry = { resolveService: async () => ({ apiUrl: "http://sim.test" }) };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      if (readDelayMs) await new Promise((r) => setTimeout(r, readDelayMs));
      const captions = captionsFor(call);
      call += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          elements: captions.map((caption, i) => ({ caption, id: `e${i}` })),
        }),
      } as Response;
    });
    return { registry, fetchSpy, calls: () => call };
  }

  // One still screen, read four times, rotated by one each time.
  const rotate = (xs: string[], by: number) => [...xs.slice(by), ...xs.slice(0, by)];

  it("defaults to a device-sized timeout, not the 3s simulator one", async () => {
    // Each read on hardware is a ~2s round trip. Settling needs two of them, so
    // under the 3s simulator default the second read lands past the deadline and
    // a motionless screen reports settled: false. 1.8s per read puts the second
    // at ~3.6s — inside the device default, outside the simulator one.
    const { registry, fetchSpy } = rotatingRegistry(
      (call) => rotate(STILL, call % STILL.length),
      1800
    );
    try {
      const tool = createAwaitScreenIdleTool(registry as never);
      const result = await tool.execute({}, { udid: PHYSICAL_UDID } as never);
      expect(result.settled).toBe(true);
      expect(result.waitedMs).toBeGreaterThan(3000);
    } finally {
      fetchSpy.mockRestore();
    }
  }, 20000);

  it("settles when only the order changes", async () => {
    const { registry, fetchSpy } = rotatingRegistry((call) => rotate(STILL, call % STILL.length));
    try {
      const tool = createAwaitScreenIdleTool(registry as never);
      const result = await tool.execute({}, {
        udid: PHYSICAL_UDID,
        minStableMs: 50,
        pollIntervalMs: 50,
        timeoutMs: 3000,
      } as never);
      expect(result.settled).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("does not settle when the elements themselves keep changing", async () => {
    // Guards the obvious way to "fix" the above — declaring everything settled.
    // Each read here is a genuinely different screen, not a rotation of one.
    const { registry, fetchSpy } = rotatingRegistry((call) => [`Loading ${call}`]);
    try {
      const tool = createAwaitScreenIdleTool(registry as never);
      const result = await tool.execute({}, {
        udid: PHYSICAL_UDID,
        minStableMs: 50,
        pollIntervalMs: 50,
        timeoutMs: 400,
      } as never);
      expect(result.settled).toBe(false);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("run-sequence does not eagerly hold simulator-server for physical iOS", () => {
  // run-sequence never eagerly declares any service (each step resolves its own
  // via invokeSubTool). Keeping it lazy means a physical-iOS sequence made only
  // of unsupported steps never brings up a CoreDevice session just to reject
  // them. Simulators go through the same lazy path.
  const tool = createRunSequenceTool({} as never);
  const params = (udid: string) => ({ udid, steps: [{ tool: "gesture-tap", args: {} }] });

  it("holds no simulator-server service for a physical iPhone", () => {
    const services = tool.services(params(PHYSICAL_UDID));
    expect(services.simulatorServer).toBeUndefined();
    expect(Object.keys(services)).toHaveLength(0);
  });

  it("holds no simulator-server service for a simulator either", () => {
    const services = tool.services(params(SIM_UDID));
    expect(services.simulatorServer).toBeUndefined();
    expect(Object.keys(services)).toHaveLength(0);
  });
});

describe("capability matrix is honest about physical-iOS support (clean 400 at the gate)", () => {
  const physical = resolveDevice(PHYSICAL_UDID);
  const sim = resolveDevice(SIM_UDID);
  const androidEmu = resolveDevice("emulator-5554");
  const androidPhone = resolveDevice("HT82A0203045");

  it("supported tools accept a physical iPhone", () => {
    expect(() => assertSupported("gesture-tap", gestureTapTool.capability, physical)).not.toThrow();
    expect(() => assertSupported("button", buttonTool.capability, physical)).not.toThrow();
    // Driven on hardware over CoreDevice: keyboard through the HID keyboard
    // surface, rotate through the devicecontrol service. screenshot-diff is
    // host-side pixel work over a screenshot, so it needs nothing device-side
    // beyond the screenshot a physical iPhone already serves.
    expect(() => assertSupported("keyboard", keyboardTool.capability, physical)).not.toThrow();
    expect(() => assertSupported("rotate", rotateTool.capability, physical)).not.toThrow();
    expect(() =>
      assertSupported("screenshot-diff", screenshotDiffTool.capability, physical)
    ).not.toThrow();
    // reinstall-app installs through devicectl; screen recording reads the same
    // simulator-server frame stream the ios_device controller publishes into.
    expect(() =>
      assertSupported("reinstall-app", reinstallAppTool.capability, physical)
    ).not.toThrow();
    expect(() =>
      assertSupported(
        "screen-recording-start",
        createScreenRecordingStartTool({} as never).capability,
        physical
      )
    ).not.toThrow();
    expect(() =>
      assertSupported("screen-recording-stop", screenRecordingStopTool.capability, physical)
    ).not.toThrow();
    // await-screen-idle rides describe, which works on hardware once the read's
    // element ORDER is ignored (see the rotating-read cases above).
    expect(() =>
      assertSupported(
        "await-screen-idle",
        createAwaitScreenIdleTool({} as never).capability,
        physical
      )
    ).not.toThrow();
  });

  it("simulator-only tools reject a physical iPhone via the capability gate", () => {
    for (const [id, cap] of [
      ["gesture-pinch", gesturePinchTool.capability],
      ["native-describe-screen", nativeDescribeScreenTool.capability],
      // native-profiler-start does LIVE capture via simulator-only simctl (the
      // process enumeration mislabels a real iPhone as a "simulator"), so it
      // rejects physical iOS at the gate. (Its post-capture sibling tools stay
      // device-agnostic — see profiler-query-android-capability.test.ts.)
      ["native-profiler-start", nativeProfilerStartTool.capability],
    ] as const) {
      expect(() => assertSupported(id, cap, physical)).toThrow(UnsupportedOperationError);
      // ...but still work on a simulator (no regression to simulator support).
      expect(() => assertSupported(id, cap, sim)).not.toThrow();
    }
  });

  it("native-profiler-start still accepts Android — emulator AND physical phone", () => {
    // `apple.device: false` must not leak across platforms: Android keeps
    // `device: true`, so a physical phone (kind "device", like the iPhone above)
    // is still accepted.
    expect(androidPhone.kind).toBe("device");
    expect(() =>
      assertSupported("native-profiler-start", nativeProfilerStartTool.capability, androidEmu)
    ).not.toThrow();
    expect(() =>
      assertSupported("native-profiler-start", nativeProfilerStartTool.capability, androidPhone)
    ).not.toThrow();
  });

  // Every tool whose backend is simulator-only, enumerated rather than sampled:
  // an unlisted one is how a physical iPhone reaches a `simctl spawn` / xctrace
  // path and fails deep with a 500 instead of at the gate with a 400.
  it("every simulator-only tool rejects a physical iPhone, and none of them lost simulator support", () => {
    const simulatorOnly: ReadonlyArray<readonly [string, ToolCapability | undefined]> = [
      ["paste", pasteTool.capability],
      ["gesture-pinch", gesturePinchTool.capability],
      ["gesture-rotate", gestureRotateTool.capability],
      ["tv-remote", createTvRemoteTool({} as never).capability],
      ["native-describe-screen", nativeDescribeScreenTool.capability],
      ["native-devtools-status", nativeDevtoolsStatusTool.capability],
      ["native-find-views", nativeFindViewsTool.capability],
      ["native-full-hierarchy", nativeFullHierarchyTool.capability],
      ["native-network-logs", nativeNetworkLogsTool.capability],
      ["native-view-at-point", nativeViewAtPointTool.capability],
      ["native-user-interactable-view-at-point", nativeUserInteractableViewAtPointTool.capability],
      ["native-profiler-start", nativeProfilerStartTool.capability],
      ["native-profiler-stop", nativeProfilerStopTool.capability],
      ["native-profiler-analyze", nativeProfilerAnalyzeTool.capability],
      // Post-capture query tools: a physical iPhone can never have a native
      // trace to query, since the capture half above rejects it.
      ["profiler-stack-query", profilerStackQueryTool.capability],
      ["profiler-combined-report", profilerCombinedReportTool.capability],
    ];
    for (const [id, cap] of simulatorOnly) {
      expect(
        () => assertSupported(id, cap, physical),
        `${id} must reject a physical iPhone`
      ).toThrow(UnsupportedOperationError);
      expect(
        () => assertSupported(id, cap, sim),
        `${id} must still accept a simulator`
      ).not.toThrow();
    }
  });
});

describe("profiler-load's native mode is closed on a physical iPhone", () => {
  const physical = resolveDevice(PHYSICAL_UDID);
  const nativeParams = { mode: "load_native", session_id: "s1", device_id: PHYSICAL_UDID };

  it("declares no native-profiler session for a hardware udid", () => {
    // `native-profiler-start` is simulator-only, so a native trace can never
    // exist for a physical iPhone. Building the ref anyway instantiates a
    // NativeProfilerSession in the registry that every reader of it
    // (native-profiler-analyze, profiler-stack-query) rejects at the gate.
    expect(Object.keys(profilerLoadTool.services!(nativeParams as never))).toEqual([]);
    expect(
      Object.keys(profilerLoadTool.services!({ ...nativeParams, device_id: SIM_UDID } as never))
    ).toEqual(["session"]);
  });

  it("rejects the request itself, rather than dead-ending in the trace parser", async () => {
    await expect(
      profilerLoadTool.execute({} as never, nativeParams as never)
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
  });

  it("leaves the device-independent modes alone", () => {
    // `list` and `load_react` read the debug directory, so gating the whole tool
    // would take the React profiler path down with it on a hardware udid.
    for (const mode of ["list", "load_react"]) {
      expect(
        Object.keys(profilerLoadTool.services!({ ...nativeParams, mode } as never)),
        mode
      ).toEqual([]);
    }
    expect(() =>
      assertSupported("profiler-load", profilerLoadTool.capability, physical)
    ).not.toThrow();
  });
});

describe("subcommandForDevice picks the sim-server controller per platform AND kind", () => {
  // The PR's headline behaviour: a physical iPhone drives `ios_device`. Kind is
  // load-bearing on both platforms — routing a physical device to the emulator
  // /simulator controller (or the reverse) spawns a controller that cannot talk
  // to the target at all.
  it.each([
    [SIM_UDID, "ios"],
    [PHYSICAL_UDID, "ios_device"],
    ["emulator-5554", "android"],
    ["HT82A0203045", "android_device"],
  ])("%s -> %s", (udid, expected) => {
    expect(subcommandForDevice(resolveDevice(udid))).toBe(expected);
  });
});
