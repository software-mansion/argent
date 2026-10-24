import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const gate = vi.hoisted(() => ({
  identity: Promise.resolve() as Promise<void>,
}));

const telemetryMock = vi.hoisted(() => ({
  init: vi.fn(),
  attachRegistryTelemetry: vi.fn(() => ({
    detach: vi.fn(),
    recordInvocation: vi.fn(),
    getTotalToolCalls: vi.fn(() => 0),
  })),
  track: vi.fn(),
  shutdown: vi.fn().mockResolvedValue(undefined),
  warmTelemetryIdentity: vi.fn(() => gate.identity),
  describeCrash: vi.fn(() => ({ crash_phase: "startup" })),
  aiTelemetryFromMeta: vi.fn(() => ({})),
}));

const registryMock = vi.hoisted(() => ({
  dispose: vi.fn().mockResolvedValue(undefined),
}));

// listen() never invokes its success callback, which keeps the startup banner
// off the suite's stdout.
const serverMock = vi.hoisted(() => ({
  on() {
    return this;
  },
  address: () => ({ port: 3001 }),
  close: (cb: () => void) => cb(),
}));

const httpHandleMock = vi.hoisted(() => ({
  dispose: vi.fn(),
  attachChromiumWebsockets: vi.fn(),
  app: {
    listen: vi.fn(() => serverMock),
  },
}));

vi.mock("@argent/telemetry", () => telemetryMock);
vi.mock("@argent/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@argent/registry")>();
  return { ...actual, attachRegistryLogger: vi.fn() };
});
// Pinned off so a developer who enables the documented `tool-server-event-log`
// flag does not have their real event log truncated by these runs.
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
  startUpdateChecker: vi.fn(() => ({ dispose: vi.fn() })),
}));
// The first poll's `simctl list` on a cold CoreSimulatorService, which never answers here.
vi.mock("../src/utils/simulator-watcher", () => ({
  startSimulatorWatcher: vi.fn(() => ({
    stop: vi.fn(),
    ready: new Promise<void>(() => {}),
  })),
}));

describe("tool-server readiness gate", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it("binds without waiting for the simulator watcher's first poll", async () => {
    gate.identity = Promise.resolve();
    const { start } = await import("../src/index");

    start();

    await vi.waitFor(() => {
      expect(httpHandleMock.app.listen).toHaveBeenCalledTimes(1);
    });
  });

  it("does not bind until the identity warm-up settles", async () => {
    let settleIdentity!: () => void;
    gate.identity = new Promise<void>((resolve) => {
      settleIdentity = resolve;
    });
    const { start } = await import("../src/index");

    start();
    await new Promise((r) => setTimeout(r, 50));
    expect(httpHandleMock.app.listen).not.toHaveBeenCalled();

    settleIdentity();
    await vi.waitFor(() => {
      expect(httpHandleMock.app.listen).toHaveBeenCalledTimes(1);
    });
  });
});
