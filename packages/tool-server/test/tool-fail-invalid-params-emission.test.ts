import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * Emission-level guard for zod invalid_params telemetry: the recordFailure
 * callback wired in src/index.ts picks meta fields EXPLICITLY (it does not
 * spread), so a new meta field silently vanishes unless it is forwarded. This
 * asserts the `tool:fail` event actually EMITTED via track() carries
 * invalid_params — not just that the HTTP layer put it on the meta object
 * (test/http-dep-gate.test.ts covers that half).
 */

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

// Keep every real export (index.ts also uses aiTelemetryFromMeta on the
// recordFailure path) and override only the lifecycle + track spies.
vi.mock("@argent/telemetry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@argent/telemetry")>();
  return { ...actual, ...telemetryMock };
});
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
  startUpdateChecker: vi.fn(() => ({ dispose: vi.fn() })),
}));
vi.mock("../src/utils/simulator-watcher", () => ({
  startSimulatorWatcher: vi.fn(() => ({
    stop: vi.fn(),
    ready: Promise.resolve(),
  })),
}));

import { createHttpApp } from "../src/http";

const ZOD_SIGNAL = {
  error_code: "HTTP_ZOD_VALIDATION_FAILED",
  failure_stage: "http_zod_validation",
  failure_area: "http",
  error_kind: "validation",
} as const;

describe("tool:fail emission carries invalid_params", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it("forwards meta.invalid_params into the emitted tool:fail event", async () => {
    const { start } = await import("../src/index");
    start();

    const options = vi.mocked(createHttpApp).mock.calls[0]![1]!;
    expect(options.recordFailure).toBeTypeOf("function");

    options.recordFailure!(
      "debugger-status",
      { platform: "ios", invalid_params: ["device_id"] },
      { ...ZOD_SIGNAL },
      12
    );

    expect(telemetryMock.track).toHaveBeenCalledWith(
      "tool:fail",
      expect.objectContaining({
        tool: "debugger-status",
        platform: "ios",
        invalid_params: ["device_id"],
        duration_ms: 12,
        error_code: "HTTP_ZOD_VALIDATION_FAILED",
      })
    );
  });

  it("omits the invalid_params key entirely when the meta has none (or an empty list)", async () => {
    const { start } = await import("../src/index");
    // start() may already have run in the previous test (module-level state is
    // shared within the file) — createHttpApp is re-called per start().
    start();

    const calls = vi.mocked(createHttpApp).mock.calls;
    const options = calls[calls.length - 1]![1]!;

    options.recordFailure!("gesture-tap", { platform: "android" }, { ...ZOD_SIGNAL }, 3);
    options.recordFailure!(
      "gesture-tap",
      { platform: "android", invalid_params: [] },
      { ...ZOD_SIGNAL },
      3
    );

    const toolFailProps = telemetryMock.track.mock.calls
      .filter(([event]) => event === "tool:fail")
      .map(([, props]) => props as Record<string, unknown>);
    expect(toolFailProps.length).toBeGreaterThanOrEqual(2);
    for (const props of toolFailProps) {
      expect("invalid_params" in props).toBe(false);
    }
  });
});
