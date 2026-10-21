import { describe, expect, it, vi } from "vitest";
import {
  isProfiling,
  registerCaptureOnDemandSender,
  trackProfilingRun,
} from "../src/utils/profiling-devices";

describe("profiling-devices", () => {
  it("captures on demand from the first run to the last, also after a respawn", () => {
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
    react.profilingActive = false;
    expect(isProfiling("emulator-5554")).toBe(false);
    expect(respawned.mock.calls).toEqual([[true], [false]]);
    expect(send.mock.calls).toEqual([[true]]);
  });
});
