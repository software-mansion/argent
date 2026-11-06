import { describe, expect, it } from "vitest";
import { ServiceState, type ServiceSnapshot } from "@argent/registry";
import { lastDeviceUse } from "../src/tools/simulator/device-services";

const UDID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";

function snapshot(entries: Record<string, Partial<ServiceSnapshot>>): Map<string, ServiceSnapshot> {
  return new Map(
    Object.entries(entries).map(([urn, entry]) => [
      urn,
      { state: ServiceState.RUNNING, dependents: [], ...entry },
    ])
  );
}

describe("lastDeviceUse", () => {
  it("takes the latest use across a device's services, port-keyed debugger URNs included", () => {
    const services = snapshot({
      [`SimulatorServer:${UDID}`]: { lastUsedAt: 100 },
      [`JsRuntimeDebugger:8081:${UDID}`]: { lastUsedAt: 300 },
      [`AXService:${UDID}`]: { lastUsedAt: 200 },
    });

    expect(lastDeviceUse(services, [UDID])).toEqual(new Map([[UDID, 300]]));
  });

  it("keys the result in the caller's spelling of a differently-cased URN", () => {
    const services = snapshot({ [`SimulatorServer:${UDID.toLowerCase()}`]: { lastUsedAt: 100 } });

    expect(lastDeviceUse(services, [UDID])).toEqual(new Map([[UDID, 100]]));
  });

  it("ignores services no tool used, services no longer live, and non-device namespaces", () => {
    const services = snapshot({
      [`NativeDevtools:${UDID}`]: {},
      [`SimulatorServer:${UDID}`]: { lastUsedAt: 100, state: ServiceState.IDLE },
      [`ScreenRecordingSession:${UDID}`]: { lastUsedAt: 200, state: ServiceState.ERROR },
      [`MetroProbe:${UDID}`]: { lastUsedAt: 300 },
    });

    expect(lastDeviceUse(services, [UDID]).size).toBe(0);
  });

  it.each([
    "IosDeviceRunner",
    "NativeDevtools",
    "AndroidDevtools",
    "ChromiumCdp",
    "ChromiumJsRuntimeDebugger",
    "TvControl",
    "AXService",
    "NetworkInspector:8081",
    "ReactProfilerSession:8081",
  ])("marks a device used only through %s", (prefix) => {
    const services = snapshot({ [`${prefix}:${UDID}`]: { lastUsedAt: 100 } });

    expect(lastDeviceUse(services, [UDID])).toEqual(new Map([[UDID, 100]]));
  });

  it("counts a service that is still starting", () => {
    const services = snapshot({
      [`SimulatorServer:${UDID}`]: { lastUsedAt: 100, state: ServiceState.STARTING },
    });

    expect(lastDeviceUse(services, [UDID])).toEqual(new Map([[UDID, 100]]));
  });

  /** Their nodes stay RUNNING after the device shuts down, and serials are reused. */
  it("ignores session services that outlive their device", () => {
    const services = snapshot({
      [`ScreenRecordingSession:${UDID}`]: { lastUsedAt: 100 },
      [`NativeProfilerSession:${UDID}`]: { lastUsedAt: 200 },
      "AndroidTvControl:emulator-5554": { lastUsedAt: 300 },
      "AndroidNetworkInspector:emulator-5554:com.example": { lastUsedAt: 400 },
    });

    expect(lastDeviceUse(services, [UDID, "emulator-5554"]).size).toBe(0);
  });
});
