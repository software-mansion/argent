import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OTLP_LOGS_ENDPOINT, getClient, resetClient, resolveConfig } from "../src/otel.js";

// Mock the OpenTelemetry Logs SDK so constructing the client is cheap and the
// exporter/processor/provider config is observable without any network I/O.
interface ProviderInstance {
  config: { resource: unknown; processors: unknown[] };
  emit: ReturnType<typeof vi.fn>;
  shutdown: ReturnType<typeof vi.fn>;
}
const otelMock = vi.hoisted(() => ({
  exporters: [] as Array<{
    opts: {
      url: string;
      headers: Record<string, string>;
      timeoutMillis: number;
      httpAgentOptions?: { timeout?: number };
    };
  }>,
  processors: [] as Array<{ opts: Record<string, unknown> }>,
  providers: [] as ProviderInstance[],
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

describe("otel endpoint invariance", () => {
  beforeEach(() => {
    otelMock.exporters.length = 0;
    otelMock.processors.length = 0;
    otelMock.providers.length = 0;
    resetClient();
    (globalThis as Record<string, unknown>).__ARGENT_OTEL_TOKEN_TEST = "otel_real";
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__ARGENT_OTEL_TOKEN_TEST;
    resetClient();
  });

  it("OTLP_LOGS_ENDPOINT is the hard-coded Software Mansion collector URL", () => {
    expect(OTLP_LOGS_ENDPOINT).toBe("https://argent-otel.swmansion.com/v1/logs");
  });

  it.each([
    ["OTEL_EXPORTER_OTLP_ENDPOINT", "https://attacker.example"],
    ["OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "https://attacker.example/v1/logs"],
    ["OTEL_EXPORTER_OTLP_HEADERS", "authorization=Bearer steal-me"],
    ["OTEL_EXPORTER_OTLP_PROTOCOL", "grpc"],
    // Asserts only that the endpoint stays put — these mocks record constructor
    // args, so they cannot speak for what the real exporter does with the env.
    // otel-endpoint-live.test.ts drives the actual SDK for that.
  ])("keeps the code-supplied endpoint with %s=%s set", (envName, value) => {
    const old = process.env[envName];
    process.env[envName] = value;
    try {
      const client = getClient();
      expect(client).not.toBeNull();
      expect(otelMock.exporters).toHaveLength(1);
      expect(otelMock.exporters[0]!.opts.url).toBe("https://argent-otel.swmansion.com/v1/logs");
    } finally {
      if (old === undefined) delete process.env[envName];
      else process.env[envName] = old;
    }
  });

  it("authenticates with the configured ingest token as a bearer header", () => {
    getClient();
    expect(otelMock.exporters[0]!.opts.headers).toEqual({ authorization: "Bearer otel_real" });
  });

  it("does not construct a client when the token is sentinel-disabled", () => {
    (globalThis as Record<string, unknown>).__ARGENT_OTEL_TOKEN_TEST = "";
    resetClient();
    expect(getClient()).toBeNull();

    (globalThis as Record<string, unknown>).__ARGENT_OTEL_TOKEN_TEST = "otel_disabled";
    resetClient();
    expect(getClient()).toBeNull();

    expect(otelMock.providers).toHaveLength(0);
  });

  it("does construct a client when a real token is configured", () => {
    (globalThis as Record<string, unknown>).__ARGENT_OTEL_TOKEN_TEST = "otel_real";
    resetClient();
    expect(getClient()).not.toBeNull();
    expect(otelMock.providers).toHaveLength(1);
  });

  it("resolveConfig carries the ingest token and the fixed endpoint", () => {
    (globalThis as Record<string, unknown>).__ARGENT_OTEL_TOKEN_TEST = "otel_single";
    const config = resolveConfig();
    expect(config.token).toBe("otel_single");
    expect(config.endpoint).toBe("https://argent-otel.swmansion.com/v1/logs");
    expect(config.isUsable).toBe(true);
  });

  it("uses the queued batching config for the singleton client", () => {
    getClient();
    expect(otelMock.processors).toHaveLength(1);
    expect(otelMock.processors[0]!.opts).toEqual(
      expect.objectContaining({ maxExportBatchSize: 20, scheduledDelayMillis: 10_000 })
    );
  });

  it("bounds each export so a stalled flush can't hold the event loop open", () => {
    // The exporter retries connection failures with backoff, so the export timeout
    // is the only cap on that loop; it is kept at/below the caller's drain budget
    // (index.ts SHORT_FLUSH_TIMEOUT_MS) so a stalled export can't outlive shutdown().
    getClient();
    expect(otelMock.exporters[0]!.opts.timeoutMillis).toBe(1_500);
    expect(otelMock.processors[0]!.opts.exportTimeoutMillis).toBe(1_500);
  });

  it("bounds connection establishment too, not just the request", () => {
    // timeoutMillis alone is NOT enough: the exporter applies it with
    // req.setTimeout(), which Node arms only once the socket is CONNECTED. A
    // collector address that drops packets (corporate egress filter, dead host
    // behind a firewall) therefore leaves a socket stuck connecting that no
    // export deadline reaches, holding a short-lived command open for the OS
    // connect timeout (~75s on macOS) after shutdown() already resolved. The
    // agent's socket timeout is armed at socket CREATION, so it covers connect.
    //
    // keepAlive rides along because supplying httpAgentOptions replaces the
    // agent the SDK would build, whose default is keepAlive: true — dropping it
    // costs the long-lived tool-server a TCP+TLS handshake per 10s batch.
    getClient();
    expect(otelMock.exporters[0]!.opts.httpAgentOptions).toEqual({
      timeout: 1_500,
      keepAlive: true,
    });
  });
});
