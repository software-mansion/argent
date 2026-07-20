import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Verifies the RUNTIME wiring between the variant-proposal store's events and the
// telemetry events they are relayed as in index.ts's `start()`. Typos in an event
// name are compile-caught, but two failure classes are NOT: (a) dropping one of
// the six `variantProposalStore.events.on(...)` registrations, and (b) cross-
// wiring — e.g. `RoundAbandonedStats` is structurally assignable to
// `LensPreviewOpenedProps`, so relaying `roundAbandoned` as `"lens:preview_opened"`
// would type-check and silently mislabel the funnel. This test emits each store
// event and asserts it lands as the correct telemetry event name.

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
  aiTelemetryFromMeta: vi.fn(() => ({})),
}));

const registryMock = vi.hoisted(() => ({
  dispose: vi.fn().mockResolvedValue(undefined),
}));

const httpHandleMock = vi.hoisted(() => ({
  dispose: vi.fn(),
  app: { listen: vi.fn() },
}));

vi.mock("@argent/telemetry", () => telemetryMock);
vi.mock("@argent/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@argent/registry")>();
  return { ...actual, attachRegistryLogger: vi.fn() };
});
vi.mock("../src/utils/setup-registry", () => ({
  createRegistry: vi.fn(() => registryMock),
}));
vi.mock("../src/http", () => ({ createHttpApp: vi.fn(() => httpHandleMock) }));
vi.mock("../src/utils/update-checker", () => ({
  startUpdateChecker: vi.fn(() => ({ dispose: vi.fn() })),
}));
// The watcher's `ready` never settles, so `start()` attaches the store-event
// relays and then parks: the HTTP server never binds and shutdown never runs, so
// the relays stay registered for the duration of the test with no exit race.
vi.mock("../src/utils/simulator-watcher", () => ({
  startSimulatorWatcher: vi.fn(() => ({
    stop: vi.fn(),
    ready: new Promise<void>(() => {}),
  })),
}));

describe("tool-server Lens telemetry relay wiring", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it("relays each store event to its matching telemetry event name (no drop, no cross-wire)", async () => {
    const { start } = await import("../src/index");
    const { variantProposalStore } = await import("../src/utils/variant-proposals");
    // Clean slate: no relays from a prior import of this singleton in-process.
    variantProposalStore.events.removeAllListeners();

    start(); // attaches the relays synchronously; watcher never settles.

    telemetryMock.track.mockClear();

    const completedStats = {
      round: 1,
      element_count: 2,
      variant_count: 3,
      annotation_count: 0,
      element_comment_count: 0,
      skipped_comment_count: 0,
      has_global_comment: false,
      inspector_used: false,
      offscreen_revealed: false,
      is_cli_session: false,
      had_parked_await: true,
      round_duration_ms: 42,
    } as const;
    const abandonedStats = {
      round: 2,
      element_count: 1,
      variant_count: 1,
      had_parked_await: false,
      is_cli_session: true,
    } as const;
    const cliStartedStats = { agent_choice_count: 2 } as const;

    variantProposalStore.events.emit("roundCompleted", completedStats);
    variantProposalStore.events.emit("roundAbandoned", abandonedStats);
    variantProposalStore.events.emit("cliSessionStarted", cliStartedStats);

    const lensCalls = telemetryMock.track.mock.calls.filter(([name]) =>
      String(name).startsWith("lens:")
    );

    // Exactly one relay per emit — a dropped registration makes its event absent,
    // a cross-wire makes it land under the wrong name (both fail these).
    expect(lensCalls).toContainEqual(["lens:round_completed", completedStats]);
    expect(lensCalls).toContainEqual(["lens:round_abandoned", abandonedStats]);
    expect(lensCalls).toContainEqual(["lens:cli_session_started", cliStartedStats]);
    expect(lensCalls).toHaveLength(3);

    // Explicit cross-wire guard: the abandoned stats (assignable to
    // LensPreviewOpenedProps) must NOT have been relayed as an opened event.
    expect(lensCalls.some(([name]) => name === "lens:preview_opened")).toBe(false);
  });
});
