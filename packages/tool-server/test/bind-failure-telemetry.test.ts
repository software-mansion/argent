import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { FAILURE_CODES } from "@argent/registry";

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

// The probe is mocked so no test ever issues a real network request — the
// un-mocked probe would GET http://127.0.0.1:3001/tools, and the outcome (and
// so the test verdict) would depend on whatever happens to be listening on the
// developer's real default tool-server port when the suite runs.
const probeMock = vi.hoisted(() => ({
  probeArgentToolServer: vi.fn<(host: string, port: number) => Promise<boolean>>(),
}));

// A minimal stand-in for the http.Server returned by app.listen(): just enough
// of the surface index.ts touches — `.on("error")` to register the handler, a
// manual `.emit()` to fire it, and the `.address()`/`.close()` shutdown() calls.
// (Hand-rolled rather than a real EventEmitter because vi.hoisted runs before
// module imports resolve.) `listen()` deliberately never invokes its success
// callback — that models a bind that fails, so `listening` stays false and the
// crash is phased as "startup".
const serverMock = vi.hoisted(() => {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    on(event: string, cb: (...args: unknown[]) => void) {
      const list = listeners.get(event) ?? [];
      list.push(cb);
      listeners.set(event, list);
      return this;
    },
    listenerCount(event: string) {
      return listeners.get(event)?.length ?? 0;
    },
    emit(event: string, ...args: unknown[]) {
      for (const cb of listeners.get(event) ?? []) cb(...args);
    },
    // Each test re-imports index.ts and calls start() again; without this the
    // previous test's bind-error handler (a stale closure) would fire too.
    reset() {
      listeners.clear();
    },
    address: () => ({ port: 3001 }),
    close: (cb: () => void) => cb(),
  };
});

const httpHandleMock = vi.hoisted(() => ({
  dispose: vi.fn(),
  attachChromiumWebsockets: vi.fn(),
  app: {
    listen: vi.fn(() => serverMock),
  },
}));

const updateCheckerMock = vi.hoisted(() => ({
  dispose: vi.fn(),
}));

const watcherMock = vi.hoisted(() => ({
  stop: vi.fn(),
}));

// Keep the REAL describeCrash so the bind-error handler produces genuine
// anonymous diagnostics (error_name / error_syscall / crash_fingerprint); stub
// the rest for assertion.
vi.mock("@argent/telemetry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@argent/telemetry")>();
  return { ...telemetryMock, describeCrash: actual.describeCrash };
});
vi.mock("@argent/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@argent/registry")>();
  return { ...actual, attachRegistryLogger: vi.fn() };
});
vi.mock("../src/utils/setup-registry", () => ({
  createRegistry: vi.fn(() => registryMock),
}));
vi.mock("../src/utils/probe-argent-tool-server", () => probeMock);
vi.mock("../src/http", () => ({
  createHttpApp: vi.fn(() => httpHandleMock),
}));
vi.mock("../src/utils/update-checker", () => ({
  startUpdateChecker: vi.fn(() => updateCheckerMock),
}));
// Unlike the startup-failure test, the readiness gate RESOLVES here so control
// reaches app.listen() and the bind-error handler is what fires.
vi.mock("../src/utils/simulator-watcher", () => ({
  startSimulatorWatcher: vi.fn(() => ({
    stop: watcherMock.stop,
    ready: Promise.resolve(),
  })),
}));

// Boot a fresh start() (fresh module state + a newly registered bind-error
// handler) and fire a bind error at it once the handler is attached.
async function startAndEmitBindError(err: NodeJS.ErrnoException): Promise<void> {
  const { start } = await import("../src/index");
  start();
  await vi.waitFor(() => {
    expect(serverMock.listenerCount("error")).toBeGreaterThan(0);
  });
  serverMock.emit("error", err);
}

describe("tool-server bind-failure telemetry", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    serverMock.reset();
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it("captures the syscall on a startup-phase crash when nothing healthy owns the port", async () => {
    // EADDRINUSE, but the probe finds no healthy argent peer (foreign holder,
    // wedged server, or race already resolved) → still a genuine crash.
    probeMock.probeArgentToolServer.mockResolvedValue(false);

    await startAndEmitBindError(
      Object.assign(new Error("listen EADDRINUSE: address already in use 127.0.0.1:3001"), {
        code: "EADDRINUSE",
        syscall: "listen",
      })
    );

    await vi.waitFor(() => {
      expect(telemetryMock.shutdown).toHaveBeenCalledWith(1500);
    });

    expect(probeMock.probeArgentToolServer).toHaveBeenCalledWith("127.0.0.1", 3001);

    // The bind failure routes through crashShutdown: reason:"crash", phased as
    // "startup" (the listen callback never ran), with the syscall captured as
    // error_syscall and the failure signal carried through. error_name is "Error"
    // and the de-identified stack yields a 16-hex fingerprint.
    expect(telemetryMock.track).toHaveBeenCalledWith("toolserver:stop", {
      reason: "crash",
      uptime_ms: expect.any(Number),
      total_tool_calls: 0,
      error_code: FAILURE_CODES.ARGENT_UNCLASSIFIED_FAILURE,
      failure_stage: "toolserver_bind",
      failure_area: "tool_server",
      error_kind: "crash",
      error_name: "Error",
      error_syscall: "EADDRINUSE",
      crash_fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
      crash_phase: "startup",
    });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("defers cleanly (exit 0, reason 'deferred', no crash fields) when a healthy argent peer owns the port", async () => {
    probeMock.probeArgentToolServer.mockResolvedValue(true);

    await startAndEmitBindError(
      Object.assign(new Error("listen EADDRINUSE: address already in use 127.0.0.1:3001"), {
        code: "EADDRINUSE",
        syscall: "listen",
      })
    );

    await vi.waitFor(() => {
      expect(telemetryMock.shutdown).toHaveBeenCalledWith(1500);
    });

    expect(probeMock.probeArgentToolServer).toHaveBeenCalledWith("127.0.0.1", 3001);

    // The redundant instance leaves the crash population entirely: a clean stop
    // with its own distinct reason (not "signal", so a supervisor relaunch loop
    // over deferrals stays identifiable), no failure signal, no crash
    // diagnostics — asserted via exact object equality.
    expect(telemetryMock.track).toHaveBeenCalledWith("toolserver:stop", {
      reason: "deferred",
      uptime_ms: expect.any(Number),
      total_tool_calls: 0,
    });
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  it("crashes without probing on a non-EADDRINUSE bind error", async () => {
    await startAndEmitBindError(
      Object.assign(new Error("listen EACCES: permission denied 127.0.0.1:3001"), {
        code: "EACCES",
        syscall: "listen",
      })
    );

    await vi.waitFor(() => {
      expect(telemetryMock.shutdown).toHaveBeenCalledWith(1500);
    });

    expect(probeMock.probeArgentToolServer).not.toHaveBeenCalled();
    expect(telemetryMock.track).toHaveBeenCalledWith(
      "toolserver:stop",
      expect.objectContaining({
        reason: "crash",
        error_syscall: "EACCES",
      })
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
