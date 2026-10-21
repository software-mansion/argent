import { describe, expect, it, vi } from "vitest";
import {
  captureOnDemandDropped,
  isProfiling,
  registerCaptureOnDemandSender,
  trackProfilingRun,
} from "../src/utils/profiling-devices";

describe("profiling-devices", () => {
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
    expect(send.mock.calls).toEqual([[true]]);
  });
});
