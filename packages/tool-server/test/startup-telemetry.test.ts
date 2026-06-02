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

vi.mock("@argent/telemetry", () => telemetryMock);
vi.mock("@argent/registry", () => ({
  attachRegistryLogger: vi.fn(),
}));
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

    await vi.waitFor(() => {
      expect(telemetryMock.shutdown).toHaveBeenCalledWith(1500);
    });

    expect(telemetryMock.track).toHaveBeenCalledWith("toolserver:stop", {
      reason: "crash",
      uptime_ms: expect.any(Number),
      total_tool_calls: 0,
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
