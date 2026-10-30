import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetProfilingDevicesForTesting,
  captureOnDemandDropped,
  isProfiling,
  registerCaptureOnDemandSender,
  trackProfilingRun,
} from "../src/utils/profiling-devices";

const CLOUD = "http://10.0.0.7:4000";
const FIRST = "http://127.0.0.1:55558";
const RESPAWNED = "http://127.0.0.1:55559";

afterEach(() => {
  __resetProfilingDevicesForTesting();
});

describe("profiling-devices", () => {
  it("releases the mode when the server's instance goes away mid-profile", () => {
    // An attached server's WebSocket, and so its hold, outlives the instance.
    const send = vi.fn();
    const unregister = registerCaptureOnDemandSender("ext:cloud-1", CLOUD, send);
    trackProfilingRun("ext:cloud-1", { profilingActive: true });
    unregister();
    expect(send.mock.calls).toEqual([[true], [false]]);
  });

  it("leaves the mode alone when a newer instance already took over", () => {
    const old = vi.fn();
    const unregisterOld = registerCaptureOnDemandSender("ext:cloud-1", CLOUD, old);
    trackProfilingRun("ext:cloud-1", { profilingActive: true });
    const current = vi.fn();
    registerCaptureOnDemandSender("ext:cloud-1", CLOUD, current);
    unregisterOld();
    expect(old.mock.calls).toEqual([[true]]);
    expect(current.mock.calls).toEqual([[true]]);
  });

  it("ends a run registered under two ids at a check of either id", () => {
    // A React profile keyed by Metro's logicalDeviceId is also registered under
    // the device's serial; its stop names only the logicalDeviceId.
    const send = vi.fn();
    registerCaptureOnDemandSender("emulator-5554", FIRST, send);
    const run = { profilingActive: true };
    trackProfilingRun("1c3346c4a6889e88", run);
    trackProfilingRun("emulator-5554", run);
    run.profilingActive = false;
    expect(isProfiling("1c3346c4a6889e88")).toBe(false);
    expect(send.mock.calls).toEqual([[true], [false]]);
  });

  it("sends nothing at exit when the server never captured on demand", () => {
    const send = vi.fn();
    registerCaptureOnDemandSender("emulator-5554", FIRST, send)();
    expect(send).not.toHaveBeenCalled();
  });

  it("captures on demand from the first run to the last, also after a respawn or reconnect", () => {
    const send = vi.fn();
    const unregister = registerCaptureOnDemandSender("emulator-5554", FIRST, send);
    const native = { profilingActive: true };
    const react = { profilingActive: true };
    trackProfilingRun("emulator-5554", native);
    trackProfilingRun("emulator-5554", react);
    native.profilingActive = false;
    expect(isProfiling("emulator-5554")).toBe(true);
    expect(send.mock.calls).toEqual([[true]]);

    unregister();
    const respawned = vi.fn();
    registerCaptureOnDemandSender("emulator-5554", RESPAWNED, respawned);
    // A lost connection reverts the server; the next check sends the mode again.
    captureOnDemandDropped("emulator-5554", RESPAWNED);
    isProfiling("emulator-5554");
    react.profilingActive = false;
    expect(isProfiling("emulator-5554")).toBe(false);
    expect(respawned.mock.calls).toEqual([[true], [true], [false]]);
    expect(send.mock.calls).toEqual([[true], [false]]);
  });

  it("holds the mode for the life of a server registered as always on demand", () => {
    // A physical Android phone: the mode is sent at registration, a profile
    // neither adds nor removes it, a lost connection sends it again, and only
    // the exit releases it.
    const send = vi.fn();
    const unregister = registerCaptureOnDemandSender("HT82A0203045", FIRST, send, true);
    expect(send.mock.calls).toEqual([[true]]);
    const run = { profilingActive: true };
    trackProfilingRun("HT82A0203045", run);
    run.profilingActive = false;
    expect(isProfiling("HT82A0203045")).toBe(false);
    expect(send.mock.calls).toEqual([[true]]);
    captureOnDemandDropped("HT82A0203045", FIRST);
    isProfiling("HT82A0203045");
    unregister();
    expect(send.mock.calls).toEqual([[true], [true], [false]]);
  });

  it("ignores the late close of a server that was already replaced", () => {
    // The old process exits only after the new one took over the device.
    const unregisterOld = registerCaptureOnDemandSender("emulator-5554", FIRST, vi.fn());
    const run = { profilingActive: true };
    trackProfilingRun("emulator-5554", run);
    unregisterOld();
    const respawned = vi.fn();
    registerCaptureOnDemandSender("emulator-5554", RESPAWNED, respawned);
    captureOnDemandDropped("emulator-5554", FIRST);
    run.profilingActive = false;
    expect(isProfiling("emulator-5554")).toBe(false);
    expect(respawned.mock.calls).toEqual([[true], [false]]);
  });
});
