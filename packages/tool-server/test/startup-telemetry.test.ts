import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const telemetryMock = vi.hoisted(() => ({
  init: vi.fn(),
  attachRegistryTelemetry: vi.fn(() => ({
    detach: vi.fn(),
    recordInvocation: vi.fn(),
    getTotalToolCalls: vi.fn(() => 0),
  })),
  track: vi.fn(),
  shutdown: vi.fn().mockResolvedValue(undefined),
  warmTelemetryIdentity: vi.fn().mockResolvedValue(undefined),
}));

const registryMock = vi.hoisted(() => ({
  dispose: vi.fn().mockResolvedValue(undefined),
}));

const httpHandleMock = vi.hoisted(() => ({
  dispose: vi.fn(),
  app: {
    listen: vi.fn(),
  },
}));

const updateCheckerMock = vi.hoisted(() => ({
  dispose: vi.fn(),
}));

const watcherMock = vi.hoisted(() => ({
  stop: vi.fn(),
}));

// Stub the telemetry surface for assertions, but keep the REAL describeCrash so
// the startup `.catch` path produces genuine anonymous diagnostics (error_name /
// crash_fingerprint / crash_phase) rather than the phase-only catch fallback.
vi.mock("@argent/telemetry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@argent/telemetry")>();
  return { ...telemetryMock, describeCrash: actual.describeCrash };
});
// Keep the real registry exports (notably TypedEventEmitter, which
// variant-proposals.ts constructs at module load via index.ts) and override
// only attachRegistryLogger — wiring the real logger onto the stubbed registry
// here would call `.events.on` on a registry mock that has no event emitter.
vi.mock("@argent/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@argent/registry")>();
  return {
    ...actual,
    attachRegistryLogger: vi.fn(),
  };
});
// start() gates its event log on the `tool-server-event-log` flag, which the
// real reader resolves from a project-scoped .argent/flags.json first and the
// developer's ~/.argent/flags.json second. Left live, a developer who enables
// that documented flag fails these tests — and createToolServerEventLog opens
// the log with a truncating write, so their real event log is emptied before
// start() throws. Pin it off.
vi.mock("@argent/configuration-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@argent/configuration-core")>();
  return { ...actual, isFlagEnabled: vi.fn(() => false) };
});
vi.mock("../src/utils/setup-registry", () => ({
  createRegistry: vi.fn(() => registryMock),
}));
vi.mock("../src/http", () => ({
  createHttpApp: vi.fn(() => httpHandleMock),
}));
vi.mock("../src/utils/update-checker", () => ({
  startUpdateChecker: vi.fn(() => updateCheckerMock),
}));
vi.mock("../src/utils/simulator-watcher", () => ({
  startSimulatorWatcher: vi.fn(() => ({
    stop: watcherMock.stop,
    ready: new Promise<void>((_resolve, reject) => {
      setTimeout(() => reject(new Error("watcher failed")), 0);
    }),
  })),
}));

vi.mock("../src/utils/device-shutdown", () => ({
  shutdownOwnedDevices: vi.fn(async () => {}),
}));

import { startSimulatorWatcher } from "../src/utils/simulator-watcher";
import { shutdownOwnedDevices } from "../src/utils/device-shutdown";
import { variantProposalStore } from "../src/utils/variant-proposals";

describe("tool-server startup telemetry", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it("drains telemetry when startup fails before the listener binds", async () => {
    const { start } = await import("../src/index");

    start();

    // The identity warm-up is kicked off during startup (before the readiness
    // gate), so the fingerprint resolve happens off the accept path. Regression
    // guard: removing `warmTelemetryIdentity()` from start() must fail here.
    expect(telemetryMock.warmTelemetryIdentity).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => {
      expect(telemetryMock.shutdown).toHaveBeenCalledWith(1500);
    });

    // This path (watcher-ready rejection) fails the server before the listener
    // binds, so it is a startup-phase crash: the readiness-gate `.catch` attaches
    // the anonymous diagnostics derived from the rejection error. The rejection is
    // a bare `new Error("watcher failed")`, so error_name is "Error", there is no
    // syscall code, and the de-identified stack yields a 16-hex fingerprint.
    expect(telemetryMock.track).toHaveBeenCalledWith("toolserver:stop", {
      reason: "crash",
      uptime_ms: expect.any(Number),
      total_tool_calls: 0,
      error_name: "Error",
      crash_fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
      crash_phase: "startup",
    });
    expect(updateCheckerMock.dispose).toHaveBeenCalledOnce();
    expect(watcherMock.stop).toHaveBeenCalledOnce();
    expect(httpHandleMock.dispose).toHaveBeenCalledOnce();
    expect(registryMock.dispose).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(1);

    process.emit("SIGTERM");

    expect(telemetryMock.track).toHaveBeenCalledTimes(1);
    expect(telemetryMock.shutdown).toHaveBeenCalledTimes(1);
    expect(updateCheckerMock.dispose).toHaveBeenCalledOnce();
    expect(watcherMock.stop).toHaveBeenCalledOnce();
    expect(httpHandleMock.dispose).toHaveBeenCalledOnce();
    expect(registryMock.dispose).toHaveBeenCalledOnce();
  });

  it("does not bind when a shutdown lands before the watcher is ready", async () => {
    let settleReady: () => void = () => {};
    vi.mocked(startSimulatorWatcher).mockReturnValueOnce({
      stop: watcherMock.stop,
      ready: new Promise<void>((resolve) => (settleReady = resolve)),
    });
    const { start } = await import("../src/index");

    start();
    process.emit("SIGTERM");
    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledWith(0);
    });
    expect(watcherMock.stop).toHaveBeenCalledOnce();

    // Stopping the watcher aborts its first poll, which settles ready, so the
    // readiness gate still opens after the shutdown has run.
    settleReady();
    await new Promise((r) => setTimeout(r, 0));
    expect(httpHandleMock.app.listen).not.toHaveBeenCalled();
  });

  it("stops the watcher before it waits for the owned devices to shut down", async () => {
    // The watcher's simctl calls run in their own process groups, so only the
    // abort reaps them if the exit is cut short while a teardown hangs.
    vi.mocked(startSimulatorWatcher).mockReturnValueOnce({
      stop: watcherMock.stop,
      ready: new Promise<void>(() => {}),
    });
    vi.mocked(shutdownOwnedDevices).mockReturnValueOnce(new Promise<void>(() => {}));
    variantProposalStore.markDeviceOwned("OWNED-DEVICE");
    const { start } = await import("../src/index");

    start();
    process.emit("SIGTERM");

    await vi.waitFor(() => {
      expect(shutdownOwnedDevices).toHaveBeenCalledWith(["OWNED-DEVICE"]);
    });
    expect(watcherMock.stop).toHaveBeenCalledOnce();
  });
});
