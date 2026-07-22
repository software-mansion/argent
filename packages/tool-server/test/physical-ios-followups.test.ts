/**
 * Follow-up coverage for the physical-iOS (CoreDevice) feature. These tests pin
 * behaviors that the original physical-ios.test.ts left uncovered and that a
 * regression could silently break:
 *
 *  - discovery must NOT surface the host's iOS simulators as phantom physical
 *    devices (devicectl enumerates them with transportType "sameMachine");
 *  - the `button` CoreDevice HID mapping + rejection of buttons with no HID;
 *  - the privileged-tunnel flag gate (root escalation must be opt-in);
 *  - tools that are unsupported on physical iOS reject with a 400-mapped
 *    UnsupportedOperationError, not a generic 500 (open-url/reinstall/restart,
 *    describe, native-profiler), while staying supported on simulators/Android;
 *  - run-sequence must not eagerly hold simulator-server for a physical iPhone;
 *  - gesture-swipe routes to CoreDevice, and rejects the simulator-only `settle`
 *    flag rather than silently returning a flinging swipe;
 *  - swipe duration clamping + timeout scaling.
 */
import { describe, it, expect, vi } from "vitest";

// core-device is the only module under test that reads the feature flag; mock it
// so the flag gate can be exercised deterministically regardless of the host's
// ~/.argent/flags.json. (See variant-flag-gate.test.ts for the same pattern.)
vi.mock("@argent/configuration-core", () => ({ isFlagEnabled: vi.fn() }));
import { isFlagEnabled } from "@argent/configuration-core";

import { resolveDevice, isPhysicalIosUdid } from "../src/utils/device-info";
import { parsePhysicalIosDevices } from "../src/utils/ios-devices";
import { UnsupportedOperationError, assertSupported } from "../src/utils/capability";
import {
  swipeDragParams,
  ensureCoreDeviceTunnel,
  assertPhysicalIosEnabled,
} from "../src/blueprints/core-device";
import { buttonTool } from "../src/tools/button";
import { createRunSequenceTool } from "../src/tools/run-sequence";
import { describeIos } from "../src/tools/describe/platforms/ios";
import { iosImpl as openUrlIos } from "../src/tools/open-url/platforms/ios";
import { iosImpl as reinstallIos } from "../src/tools/reinstall-app/platforms/ios";
import { makeIosImpl as makeRestartAppIosImpl } from "../src/tools/restart-app/platforms/ios";
import { makeIosImpl as makeLaunchAppIosImpl } from "../src/tools/launch-app/platforms/ios";
import { gestureSwipeTool } from "../src/tools/gesture-swipe";
import { gestureTapTool } from "../src/tools/gesture-tap";
import { createKeyboardTool } from "../src/tools/keyboard";
import { gesturePinchTool } from "../src/tools/gesture-pinch";
import { screenshotDiffTool } from "../src/tools/screenshot-diff";
import { nativeDescribeScreenTool } from "../src/tools/native-devtools/native-describe-screen";
import { nativeProfilerStartTool } from "../src/tools/profiler/native-profiler/native-profiler-start";

const mockFlag = vi.mocked(isFlagEnabled);

// Physical-iOS branches of both handlers throw/reject before ever touching
// `registry` (see the assertions below), so a stub registry is safe here.
const restartIos = makeRestartAppIosImpl({} as never);
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
        {
          hardwareProperties: {
            udid: "00008030-00096526219B802E",
            platform: "iOS",
            productType: "iPhone12,8",
          },
          deviceProperties: { name: "Old iPhone" },
          connectionProperties: { tunnelState: "unavailable" },
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
  // The argent-side name→HID mapping is gone: a physical iPhone drives the
  // sim-server `ios_device` subcommand over the same transport as a simulator,
  // and the Consumer-page HID mapping lives in the sim-server controller. Only
  // the four hardware buttons are supported; appSwitch/actionButton have no
  // HID equivalent and are rejected (the fire-and-forget transport could not
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

describe("privileged tunnel start is gated behind the feature flag", () => {
  it("rejects with the enable hint when physical-ios-devices is off", async () => {
    mockFlag.mockReturnValue(false);
    await expect(ensureCoreDeviceTunnel(PHYSICAL_UDID)).rejects.toThrow(
      /Physical iOS support is disabled.*argent enable physical-ios-devices/s
    );
    expect(mockFlag).toHaveBeenCalledWith("physical-ios-devices");
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
    // generic swipe path emits, so `settle` is honored — unlike the old
    // fixed-trajectory CoreDevice HID drag, which had to reject it.
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

describe("tools unsupported on physical iOS reject with UnsupportedOperationError (400)", () => {
  const device = resolveDevice(PHYSICAL_UDID);

  it("open-url", async () => {
    await expect(
      openUrlIos.handler({} as never, { udid: PHYSICAL_UDID, url: "https://x" } as never, device)
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
  });

  it("reinstall-app", async () => {
    await expect(
      reinstallIos.handler(
        {} as never,
        { udid: PHYSICAL_UDID, bundleId: "com.x", appPath: "/tmp/x.app" } as never,
        device
      )
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
  });

  it("restart-app", async () => {
    await expect(
      restartIos.handler({} as never, { udid: PHYSICAL_UDID, bundleId: "com.x" } as never, device)
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
  });

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
      json: async () => ({
        screen: { w: 393, h: 852 },
        elements: [
          { caption: "General, Button", id: "e1", rect: "{{16, 100}, {361, 44}}" },
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
});

describe("run-sequence does not eagerly hold simulator-server for physical iOS", () => {
  // run-sequence never eagerly declares any service (each step resolves its own
  // via invokeSubTool) — a physical iOS udid must not eagerly hold
  // simulator-server, which would throw on a `kind === "device"` target before
  // step 1 even runs. Simulators go through the same lazy path.
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

  it("supported tools accept a physical iPhone", () => {
    expect(() => assertSupported("gesture-tap", gestureTapTool.capability, physical)).not.toThrow();
    expect(() => assertSupported("button", buttonTool.capability, physical)).not.toThrow();
  });

  it("simulator-only tools reject a physical iPhone via the capability gate", () => {
    for (const [id, cap] of [
      ["keyboard", keyboardTool.capability],
      ["gesture-pinch", gesturePinchTool.capability],
      ["screenshot-diff", screenshotDiffTool.capability],
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

  it("native-profiler-start still accepts a physical Android device", () => {
    expect(() =>
      assertSupported("native-profiler-start", nativeProfilerStartTool.capability, androidEmu)
    ).not.toThrow();
  });
});

describe("swipeDragParams — clamping and timeout scaling", () => {
  it("clamps a typical swipe and scales the timeout past the drag duration", () => {
    const p = swipeDragParams(300);
    expect(p.seconds).toBe("0.300");
    expect(p.steps).toBe(19);
    expect(p.timeoutMs).toBe(15_300);
  });

  it("a long swipe gets a timeout that outlasts the drag (the bug this fixes)", () => {
    const p = swipeDragParams(20_000);
    expect(p.seconds).toBe("20.000");
    expect(p.steps).toBe(60); // step count is capped
    expect(p.timeoutMs).toBe(35_000);
    expect(p.timeoutMs).toBeGreaterThan(20_000);
  });

  it("floors degenerate (zero/negative) durations to a real dwell", () => {
    expect(swipeDragParams(0).seconds).toBe("0.050");
    expect(swipeDragParams(-100).seconds).toBe("0.050");
    expect(swipeDragParams(0).steps).toBeGreaterThanOrEqual(2);
  });

  it("caps a pathological duration", () => {
    const p = swipeDragParams(10_000_000);
    expect(p.seconds).toBe("60.000");
    expect(p.timeoutMs).toBe(75_000);
  });
});
