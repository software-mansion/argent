import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  _resetConsentCacheForTest,
  getConsentState,
  markDisabled,
  markEnabled,
  writeConsentFlag,
  warmTelemetryIdentity,
  warmTelemetryIdentitySync,
  resetLocalTelemetryState,
  init,
  isEnabled,
  status,
  shutdown,
  track,
} from "../src/index.js";
import { getClient, resetClient } from "../src/otel.js";
import { _resetIdentityCacheForTest } from "../src/identity.js";
import { _resetBasePropsCacheForTest } from "../src/base-props.js";
import { scopeHome, snapshotEnv } from "./helpers.js";
import { configFilePath } from "../src/paths.js";

// Mock the OpenTelemetry Logs SDK. Each constructed LoggerProvider exposes the
// logger's `emit` and the provider's `shutdown` as spies so we can observe what
// track()/shutdown() drive, plus the batch-processor and exporter config — all
// without any network I/O.
interface ProviderInstance {
  config: { resource: unknown; processors: unknown[] };
  emit: ReturnType<typeof vi.fn>;
  shutdown: ReturnType<typeof vi.fn>;
}
const otelMock = vi.hoisted(() => ({
  providers: [] as ProviderInstance[],
  processors: [] as Array<{ opts: Record<string, unknown> }>,
  exporters: [] as Array<{ opts: Record<string, unknown> }>,
}));

// Telemetry resolves the host fingerprint internally for every entry point.
// Stub both the sync and async resolvers to a fixed 64-hex value so track() uses
// a deterministic id without spawning the real simulator-server binary. (The
// async resolver backs the background upgrade / warm-up; with the fingerprint
// resolved synchronously here it is a no-op, but the export must exist.)
vi.mock("../src/fingerprint.js", () => ({
  resolveHostFingerprint: () => "f".repeat(64),
  resolveHostFingerprintAsync: () => Promise.resolve("f".repeat(64)),
}));

vi.mock("@opentelemetry/api-logs", () => ({ SeverityNumber: { INFO: 9 } }));
vi.mock("@opentelemetry/resources", () => ({
  resourceFromAttributes: (attributes: Record<string, unknown>) => ({ attributes }),
}));
vi.mock("@opentelemetry/exporter-logs-otlp-http", () => ({
  OTLPLogExporter: vi.fn().mockImplementation(function (this: { opts: unknown }, opts: unknown) {
    this.opts = opts;
    otelMock.exporters.push(this as (typeof otelMock.exporters)[number]);
  }),
}));
vi.mock("@opentelemetry/sdk-logs", () => ({
  BatchLogRecordProcessor: vi.fn().mockImplementation(function (
    this: { opts: unknown },
    opts: unknown
  ) {
    this.opts = opts;
    otelMock.processors.push(this as (typeof otelMock.processors)[number]);
  }),
  LoggerProvider: vi.fn().mockImplementation(function (
    this: ProviderInstance,
    config: ProviderInstance["config"]
  ) {
    const emit = vi.fn();
    const shutdown = vi.fn().mockResolvedValue(undefined);
    Object.assign(this, { config, emit, shutdown, getLogger: () => ({ emit }) });
    otelMock.providers.push(this);
  }),
}));

/** The attributes of the Nth emitted log record on a provider. */
const attrsOf = (provider: ProviderInstance, n: number): Record<string, unknown> =>
  (provider.emit.mock.calls[n]![0] as { attributes: Record<string, unknown> }).attributes;

describe("telemetry public surface", () => {
  const { tmp } = scopeHome();

  beforeEach(() => {
    otelMock.providers.length = 0;
    otelMock.processors.length = 0;
    otelMock.exporters.length = 0;
    resetClient();
    // is_ci and friends are memoized per process; reset so a test that sets CI
    // env vars sees them recomputed rather than a value cached by a prior test.
    _resetBasePropsCacheForTest();
    // Isolate the module-level id / fingerprint / consent caches between tests.
    _resetIdentityCacheForTest();
    _resetConsentCacheForTest();
    (globalThis as Record<string, unknown>).__ARGENT_OTEL_TOKEN_TEST = "otel_real";
    init("tool_server");
    markEnabled();
  });

  // Helpers for the identity-wiring tests below.
  const idFile = () => path.join(tmp(), ".argent", "telemetry-id");
  const readId = () => {
    try {
      return fs.readFileSync(idFile(), "utf8").trim();
    } catch {
      return null;
    }
  };
  const flushUpgrade = async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  };

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__ARGENT_OTEL_TOKEN_TEST;
    resetClient();
    vi.restoreAllMocks();
  });

  it("markDisabled persists disabled state and drains prior events without emitting an opt-out event", async () => {
    track("toolserver:start", {});
    const provider = otelMock.providers[0]!;

    provider.shutdown.mockImplementation(async () => {
      expect(isEnabled()).toBe(false);
    });

    await markDisabled();

    expect(otelMock.providers).toHaveLength(1);
    expect(provider.emit).toHaveBeenCalledTimes(1);
    expect(provider.emit).toHaveBeenCalledWith(
      expect.objectContaining({ body: "toolserver:start" })
    );
    // Opting out emits nothing extra — only the one event that was already queued.
    expect(provider.shutdown).toHaveBeenCalledTimes(1);
    expect(isEnabled()).toBe(false);
  });

  it("does not provision the anon-id file when the ingest token is unusable", () => {
    // An intentionally-disabled/empty token means nothing can ever transmit, so
    // track() must not write a persistent identifier to the user's disk.
    (globalThis as Record<string, unknown>).__ARGENT_OTEL_TOKEN_TEST = "";
    resetClient();

    track("toolserver:start", {});

    expect(otelMock.providers).toHaveLength(0);
    expect(status().hasAnonIdOnDisk).toBe(false);
  });

  it("track queues without flushing so command shutdown drains later", async () => {
    track("toolserver:start", {});
    track("toolserver:stop", {
      reason: "signal",
      uptime_ms: 1,
      total_tool_calls: 0,
    });

    const provider = otelMock.providers[0]!;

    expect(otelMock.providers).toHaveLength(1);
    expect(provider.emit).toHaveBeenCalledTimes(2);
    expect(provider.emit).toHaveBeenCalledWith(
      expect.objectContaining({ body: "toolserver:stop" })
    );
    expect(provider.shutdown).not.toHaveBeenCalled();
    // The batching config lives on the batch log-record processor.
    expect(otelMock.processors[0]!.opts).toEqual(
      expect.objectContaining({ maxExportBatchSize: 20, scheduledDelayMillis: 10_000 })
    );
  });

  it("uses the host fingerprint verbatim as the distinctId", () => {
    // The fingerprint module is stubbed (top of file) to a fixed 64-hex value,
    // so the id is that fingerprint rather than a random v4.
    track("toolserver:start", {});

    const provider = otelMock.providers[0]!;
    expect(provider.emit).toHaveBeenCalledTimes(1);
    const distinctId = attrsOf(provider, 0).distinct_id;
    // The distinctId is the fingerprint hash itself, not a random v4 UUID.
    expect(distinctId).toBe("f".repeat(64));
    // Persisted to disk as the migrated id.
    expect(status().anonIdPrefix).toBe("f".repeat(64).slice(0, 8));
    // Migration is local-only: exactly one record is emitted (the tracked event),
    // never an extra identity/alias record.
    expect(provider.emit).toHaveBeenCalledTimes(1);
  });

  it("self-heals a fallback id to the fingerprint via the background upgrade wired into track()", async () => {
    // Regression guard for the reviewer's C2: a legacy random id on disk. The
    // first event emits under it (no blocking migrate), then buildPayload's
    // scheduleFingerprintUpgrade (fed the async resolver, mocked to the
    // fingerprint) migrates the on-disk id so subsequent events converge. If the
    // scheduleFingerprintUpgrade call in buildPayload were removed, the on-disk
    // id would never migrate and the second event would still be the legacy id.
    const LEGACY = "11111111-1111-4111-8111-111111111111";
    const FP = "f".repeat(64);
    fs.mkdirSync(path.join(tmp(), ".argent"), { recursive: true });
    fs.writeFileSync(idFile(), LEGACY, { mode: 0o600 });

    track("toolserver:start", {});
    const provider = otelMock.providers[0]!;
    expect(attrsOf(provider, 0).distinct_id).toBe(LEGACY);

    await flushUpgrade();
    expect(readId()).toBe(FP); // background upgrade migrated the file

    track("toolserver:start", {});
    expect(attrsOf(provider, 1).distinct_id).toBe(FP);
  });

  it("warmTelemetryIdentity establishes the fingerprint id off the hot path", async () => {
    expect(status().hasAnonIdOnDisk).toBe(false);
    await warmTelemetryIdentity();
    // The async resolver (mocked) yields the fingerprint, persisted before any event.
    expect(readId()).toBe("f".repeat(64));
    // A subsequent event then finds it on disk (no truly-fresh sync resolve).
    track("toolserver:start", {});
    const provider = otelMock.providers[0]!;
    expect(attrsOf(provider, 0).distinct_id).toBe("f".repeat(64));
  });

  it("warmTelemetryIdentity mints no identity when telemetry is disabled", async () => {
    writeConsentFlag(false);
    _resetConsentCacheForTest();
    expect(isEnabled()).toBe(false);
    await warmTelemetryIdentity();
    // A disabled machine must not have a persistent identifier provisioned.
    expect(readId()).toBeNull();
    expect(status().hasAnonIdOnDisk).toBe(false);
  });

  it("warmTelemetryIdentity provisions no identity when the ingest token is unusable", async () => {
    // Consent-enabled but an unusable token: like track()/buildPayload, warm-up must
    // resolve the client first and bail before spawning the fingerprint binary or
    // writing a durable per-machine id for events that can never be transmitted.
    // The async resolver is mocked to a fingerprint, so without the getClient()
    // gate warmIdentity would persist "f".repeat(64); asserting no id proves the
    // short-circuit.
    (globalThis as Record<string, unknown>).__ARGENT_OTEL_TOKEN_TEST = "";
    resetClient();
    _resetConsentCacheForTest();
    expect(isEnabled()).toBe(true);

    await warmTelemetryIdentity();

    expect(readId()).toBeNull();
    expect(status().hasAnonIdOnDisk).toBe(false);
  });

  // The SHORT-LIVED-CLI (installer) counterpart of warmTelemetryIdentity, wired
  // into `argent init`/`update` so the very first event (cli_init_start) carries
  // the stable fingerprint instead of a random fallback the background upgrade
  // would only migrate to afterward.
  it("warmTelemetryIdentitySync migrates a legacy fallback to the fingerprint before the first event (the cli_init_start fix)", () => {
    const LEGACY = "11111111-1111-4111-8111-111111111111";
    const FP = "f".repeat(64);
    fs.mkdirSync(path.join(tmp(), ".argent"), { recursive: true });
    fs.writeFileSync(idFile(), LEGACY, { mode: 0o600 });

    // Without the sync warm, track() would serve the legacy fallback (hot-path
    // contract). The warm forces the resolve+migrate up front...
    warmTelemetryIdentitySync();
    expect(readId()).toBe(FP);

    // ...so the first tracked event already carries the fingerprint.
    track("installation:cli_init_start", {
      package_manager: "npm",
      is_non_interactive: false,
    });
    const provider = otelMock.providers[0]!;
    expect(attrsOf(provider, 0).distinct_id).toBe(FP);
  });

  it("warmTelemetryIdentitySync mints no identity when telemetry is disabled", () => {
    writeConsentFlag(false);
    _resetConsentCacheForTest();
    expect(isEnabled()).toBe(false);
    warmTelemetryIdentitySync();
    expect(readId()).toBeNull();
    expect(status().hasAnonIdOnDisk).toBe(false);
  });

  it("warmTelemetryIdentitySync provisions no identity when the ingest token is unusable", () => {
    (globalThis as Record<string, unknown>).__ARGENT_OTEL_TOKEN_TEST = "";
    resetClient();
    _resetConsentCacheForTest();
    expect(isEnabled()).toBe(true);
    warmTelemetryIdentitySync();
    expect(readId()).toBeNull();
    expect(status().hasAnonIdOnDisk).toBe(false);
  });

  it("captures events in CI and annotates payloads with is_ci", () => {
    const restore = snapshotEnv(["CI"]);
    try {
      process.env.CI = "1";

      track("toolserver:start", {});

      const provider = otelMock.providers[0]!;
      expect(provider.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          body: "toolserver:start",
          attributes: expect.objectContaining({ is_ci: true }),
        })
      );
    } finally {
      restore();
    }
  });

  it("shutdown drains the constructed client", async () => {
    track("toolserver:start", {});
    track("toolserver:stop", {
      reason: "signal",
      uptime_ms: 1,
      total_tool_calls: 0,
    });

    const provider = otelMock.providers[0]!;

    await shutdown();

    expect(otelMock.providers).toHaveLength(1);
    expect(provider.shutdown).toHaveBeenCalledTimes(1);
  });

  it("resetLocalTelemetryState removes local state without a delete-person event and leaves consent untouched", async () => {
    track("toolserver:start", {});
    expect(status().hasAnonIdOnDisk).toBe(true);

    const result = await resetLocalTelemetryState();
    const provider = otelMock.providers[0]!;

    expect(otelMock.providers).toHaveLength(1);
    // The reset is local-only: it emits nothing beyond the already-tracked event
    // and never shuts the client down.
    expect(provider.emit).toHaveBeenCalledTimes(1);
    expect(provider.shutdown).not.toHaveBeenCalled();
    expect(result.localIdRemoved).toBe(true);
    expect(result.noticeReset).toBe(true);
    expect(status().hasAnonIdOnDisk).toBe(false);
    // Consent is deliberately left untouched — a lasting opt-out is `markDisabled()`.
    expect(isEnabled()).toBe(true);
  });

  it("removes the local telemetry id file but the deterministic id re-derives on the next event while consent stays enabled", async () => {
    fs.unlinkSync(configFilePath());
    _resetConsentCacheForTest();
    track("toolserver:start", {});
    const derivedId = readId();

    const result = await resetLocalTelemetryState();

    const provider = otelMock.providers[0]!;
    // The reset itself emits no erasure record — it is a purely local removal.
    expect(provider.emit).toHaveBeenCalledTimes(1);
    expect(result.localIdRemoved).toBe(true);
    expect(status().hasAnonIdOnDisk).toBe(false);
    // No config file is created just to clear a marker that was never set.
    expect(fs.existsSync(configFilePath())).toBe(false);
    expect(isEnabled()).toBe(true);

    // Deleting the id file with consent still enabled is a LOCAL removal, not a
    // permanent erasure: the fingerprint-derived id is re-created identically on
    // the next tracked event. A genuine reset comes from the opt-out path
    // (`markDisabled()` / `argent telemetry disable`).
    track("toolserver:start", {});
    expect(status().hasAnonIdOnDisk).toBe(true);
    expect(readId()).toBe(derivedId);
  });

  it("leaves an explicit opt-out untouched", async () => {
    fs.writeFileSync(configFilePath(), JSON.stringify({ telemetry: { enabled: false } }) + "\n");
    _resetConsentCacheForTest();

    await resetLocalTelemetryState();

    expect(getConsentState({}).enabled).toBe(false);
    expect(getConsentState({}).source.source).toBe("config_file");
  });

  it("leaves an explicit opt-in untouched", async () => {
    markEnabled();

    await resetLocalTelemetryState();

    expect(getConsentState({}).enabled).toBe(true);
    expect(getConsentState({}).source.source).toBe("config_file");
  });

  it("removes the local telemetry id", async () => {
    track("toolserver:start", {});
    expect(status().hasAnonIdOnDisk).toBe(true);

    const result = await resetLocalTelemetryState();

    expect(result.localIdRemoved).toBe(true);
    expect(status().hasAnonIdOnDisk).toBe(false);
  });
});

describe("the log record that goes on the wire", () => {
  const { tmp: _tmp } = scopeHome();

  beforeEach(() => {
    otelMock.providers.length = 0;
    otelMock.processors.length = 0;
    otelMock.exporters.length = 0;
    resetClient();
    _resetBasePropsCacheForTest();
    _resetIdentityCacheForTest();
    _resetConsentCacheForTest();
    (globalThis as Record<string, unknown>).__ARGENT_OTEL_TOKEN_TEST = "otel_real";
    init("tool_server");
    markEnabled();
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__ARGENT_OTEL_TOKEN_TEST;
    resetClient();
    vi.restoreAllMocks();
  });

  it("routes properties through the sanitizer's allowlist", () => {
    // `toolserver:start` allows no properties at all, so an absolute path handed
    // to it must not survive. This is what pins track() to sanitize(): read the
    // caller's props straight onto the record and the path ships verbatim.
    track("toolserver:start", { cwd: "/Users/someone/private-project" } as never);

    const attributes = attrsOf(otelMock.providers[0]!, 0);
    expect(attributes).not.toHaveProperty("cwd");
    expect(Object.values(attributes)).not.toContain("/Users/someone/private-project");
  });

  it("omits a null-valued property rather than sending an explicit null", () => {
    // OTel rejects null attribute values, so toAttributes drops those keys.
    const client = getClient()!;
    client.emit({
      distinctId: "d",
      event: "toolserver:start",
      properties: { kept: "yes", nulled: null, missing: undefined },
    });

    const attributes = attrsOf(otelMock.providers[0]!, 0);
    expect(attributes.kept).toBe("yes");
    expect("nulled" in attributes).toBe(false);
    expect("missing" in attributes).toBe(false);
  });

  it("identifies the record by service.name resource and event.name attribute", () => {
    track("toolserver:start", {});

    const provider = otelMock.providers[0]!;
    expect(
      (provider.config.resource as { attributes: Record<string, unknown> }).attributes
    ).toEqual({ "service.name": "argent" });
    expect(attrsOf(provider, 0)["event.name"]).toBe("toolserver:start");
  });
});

describe("drain budgets", () => {
  const { tmp: _t } = scopeHome();

  beforeEach(() => {
    otelMock.providers.length = 0;
    otelMock.processors.length = 0;
    otelMock.exporters.length = 0;
    resetClient();
    _resetBasePropsCacheForTest();
    _resetIdentityCacheForTest();
    _resetConsentCacheForTest();
    (globalThis as Record<string, unknown>).__ARGENT_OTEL_TOKEN_TEST = "otel_real";
    init("tool_server");
    markEnabled();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as Record<string, unknown>).__ARGENT_OTEL_TOKEN_TEST;
    resetClient();
    vi.restoreAllMocks();
  });

  /**
   * Both drains race the client against a timer. The timer has to sit strictly
   * later than the exporter's own export deadline (EXPORT_TIMEOUT_MS, equal to
   * this budget), or it fires at the same instant and the batch is abandoned
   * rather than given the chance to finish failing.
   */
  async function assertRacedWithGrace(drain: () => Promise<unknown>): Promise<void> {
    vi.useFakeTimers();
    track("toolserver:start", {});
    otelMock.providers[0]!.shutdown.mockImplementation(() => new Promise(() => {}));

    let settled = false;
    const pending = drain().then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(1_500);
    expect(settled, "resolved at the export deadline, leaving no grace").toBe(false);

    await vi.advanceTimersByTimeAsync(250);
    await pending;
    expect(settled).toBe(true);
  }

  it("bounds shutdown() so a wedged exporter cannot stall a command", async () => {
    await assertRacedWithGrace(() => shutdown());
  });

  it("bounds markDisabled()'s drain on the same budget as shutdown()", async () => {
    await assertRacedWithGrace(() => markDisabled());
  });
});
