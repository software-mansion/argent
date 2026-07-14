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

describe("tool-server bind-failure telemetry", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it("captures the syscall on a startup-phase crash when the listener fails to bind", async () => {
    const { start } = await import("../src/index");

    start();

    // Wait until the `.then` branch has run and registered the bind-error
    // handler on the server, then simulate an EADDRINUSE bind failure.
    await vi.waitFor(() => {
      expect(serverMock.listenerCount("error")).toBeGreaterThan(0);
    });
    serverMock.emit(
      "error",
      Object.assign(new Error("listen EADDRINUSE: address already in use 127.0.0.1:3001"), {
        code: "EADDRINUSE",
        syscall: "listen",
      })
    );

    await vi.waitFor(() => {
      expect(telemetryMock.shutdown).toHaveBeenCalledWith(1500);
    });

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
});
