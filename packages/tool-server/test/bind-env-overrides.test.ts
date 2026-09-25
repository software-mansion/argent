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
  describeCrash: vi.fn(() => ({ crash_phase: "startup" })),
  aiTelemetryFromMeta: vi.fn(() => ({})),
  attachRegistryEventLogger: vi.fn(),
}));

const registryMock = vi.hoisted(() => ({
  dispose: vi.fn().mockResolvedValue(undefined),
}));

// listen() deliberately never invokes its success callback: the assertions are
// on the arguments it was handed, and leaving `listening` false keeps the
// startup banner off the suite's stdout.
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
vi.mock("../src/utils/probe-argent-tool-server", () => ({
  probeArgentToolServer: vi.fn().mockResolvedValue(false),
}));
vi.mock("../src/http", () => ({
  createHttpApp: vi.fn(() => httpHandleMock),
}));
vi.mock("../src/utils/update-checker", () => ({
  startUpdateChecker: vi.fn(() => ({ dispose: vi.fn() })),
}));
vi.mock("../src/utils/simulator-watcher", () => ({
  startSimulatorWatcher: vi.fn(() => ({
    stop: vi.fn(),
    ready: Promise.resolve(),
  })),
}));

async function startAndReadBind(): Promise<{ port: unknown; host: unknown }> {
  const { start } = await import("../src/index");
  start();
  await vi.waitFor(() => {
    expect(httpHandleMock.app.listen).toHaveBeenCalled();
  });
  const [port, host] = httpHandleMock.app.listen.mock.calls[0] as unknown as [unknown, unknown];
  return { port, host };
}

describe("tool-server bind overrides", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    delete process.env.ARGENT_HOST;
    delete process.env.ARGENT_PORT;
  });

  it("binds loopback when ARGENT_HOST is exported empty", async () => {
    process.env.ARGENT_HOST = "";

    expect(await startAndReadBind()).toEqual({ port: 3001, host: "127.0.0.1" });
  });

  it("binds loopback when ARGENT_HOST is whitespace only", async () => {
    process.env.ARGENT_HOST = "   ";

    expect(await startAndReadBind()).toEqual({ port: 3001, host: "127.0.0.1" });
  });

  it("binds the default port when ARGENT_PORT is exported empty", async () => {
    process.env.ARGENT_PORT = "";

    expect(await startAndReadBind()).toEqual({ port: 3001, host: "127.0.0.1" });
  });

  it("honours a non-empty override, whitespace around it trimmed", async () => {
    process.env.ARGENT_HOST = " 0.0.0.0 ";
    process.env.ARGENT_PORT = " 43123 ";

    expect(await startAndReadBind()).toEqual({ port: 43123, host: "0.0.0.0" });
  });
});
