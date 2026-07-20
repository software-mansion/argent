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
});
