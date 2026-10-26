import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetProfilingDevicesForTesting,
  captureOnDemandDropped,
  isProfiling,
  registerCaptureOnDemandSender,
  trackProfilingRun,
} from "../src/utils/profiling-devices";

afterEach(() => {
  __resetProfilingDevicesForTesting();
});

describe("profiling-devices", () => {
  it("releases the mode when the server's instance goes away mid-profile", () => {
    // An attached server's WebSocket, and so its hold, outlives the instance.
    const send = vi.fn();
    const unregister = registerCaptureOnDemandSender("ext:cloud-1", send);
    trackProfilingRun("ext:cloud-1", { profilingActive: true });
    unregister();
    expect(send.mock.calls).toEqual([[true], [false]]);
  });

  it("leaves the mode alone when a newer instance already took over", () => {
    const old = vi.fn();
    const unregisterOld = registerCaptureOnDemandSender("ext:cloud-1", old);
    trackProfilingRun("ext:cloud-1", { profilingActive: true });
    const current = vi.fn();
    registerCaptureOnDemandSender("ext:cloud-1", current);
    unregisterOld();
    expect(old.mock.calls).toEqual([[true]]);
    expect(current.mock.calls).toEqual([[true]]);
  });

  it("ends a run registered under two ids at a check of either id", () => {
    // A React profile keyed by Metro's logicalDeviceId is also registered under
    // the device's serial; its stop names only the logicalDeviceId.
    const send = vi.fn();
    registerCaptureOnDemandSender("emulator-5554", send);
    const run = { profilingActive: true };
    trackProfilingRun("1c3346c4a6889e88", run);
    trackProfilingRun("emulator-5554", run);
    run.profilingActive = false;
    expect(isProfiling("1c3346c4a6889e88")).toBe(false);
    expect(send.mock.calls).toEqual([[true], [false]]);
  });

  it("sends nothing at exit when the server never captured on demand", () => {
    const send = vi.fn();
    registerCaptureOnDemandSender("emulator-5554", send)();
    expect(send).not.toHaveBeenCalled();
  });

  it("captures on demand from the first run to the last, also after a respawn or reconnect", () => {
    const send = vi.fn();
    const unregister = registerCaptureOnDemandSender("emulator-5554", send);
    const native = { profilingActive: true };
    const react = { profilingActive: true };
    trackProfilingRun("emulator-5554", native);
    trackProfilingRun("emulator-5554", react);
    native.profilingActive = false;
    expect(isProfiling("emulator-5554")).toBe(true);
    expect(send.mock.calls).toEqual([[true]]);

    unregister();
    const respawned = vi.fn();
    registerCaptureOnDemandSender("emulator-5554", respawned);
    // A lost connection reverts the server; the next check sends the mode again.
    captureOnDemandDropped("emulator-5554");
    isProfiling("emulator-5554");
    react.profilingActive = false;
    expect(isProfiling("emulator-5554")).toBe(false);
    expect(respawned.mock.calls).toEqual([[true], [true], [false]]);
    expect(send.mock.calls).toEqual([[true], [false]]);
  });
});
