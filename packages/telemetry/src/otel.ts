import type { LogAttributes, Logger } from "@opentelemetry/api-logs";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { diag, DiagLogLevel } from "@opentelemetry/api";
import { isDebugEnabled, emitDebugError } from "./debug.js";

/**
 * Hard-coded so env-var overrides cannot redirect ingestion: an explicit
 * exporter option wins over the matching OTEL_EXPORTER_OTLP_* variable.
 * otel-endpoint-live.test.ts pins that precedence against the real exporter;
 * otel-endpoint.test.ts mocks it and so cannot see the SDK change its mind.
 *
 * An explicit value only wins for the keys the code sets, so the header
 * channel is closed separately, in createExporter.
 */
export const OTLP_LOGS_ENDPOINT = "https://argent-otel.swmansion.com/v1/logs";

/**
 * Build-time-injected ingest token (esbuild `define`, mirroring
 * ARGENT_CLI_VERSION in base-props.ts). Every bundle substitutes a string
 * literal — the release token, or "" when the build supplies none, which
 * leaves the client unconstructed. Unbundled source (tests) leaves it
 * undefined.
 *
 * Must stay a bare identifier: esbuild `define` rewrites identifiers, not
 * property accesses.
 */
declare const ARGENT_OTEL_INGEST_TOKEN: string | undefined;

const SERVICE_NAME = "argent";

const LOGGER_NAME = "@argent/telemetry";

// EXPORT_TIMEOUT_MS bounds each export AND caps the OTLP exporter's built-in
// retry loop, which treats a connection failure (ECONNREFUSED, timeout, DNS) as
// retryable. It is kept at or below index.ts's SHORT_FLUSH_TIMEOUT_MS drain
// budget so a stalled export can't hold a short-lived command's process open
// past shutdown()'s bounded drain: the exporter's in-flight socket and retry
// timer are the only things keeping the event loop alive. The deadline only
// starts once the socket is connected, hence the agent-level socket timeout
// below.
const MAX_EXPORT_BATCH_SIZE = 20;
const SCHEDULED_DELAY_MS = 10_000;
const EXPORT_TIMEOUT_MS = 1_500;

/** One analytics event; becomes a single OTLP log record. */
export interface EmitRecord {
  distinctId: string;
  event: string;
  properties: Record<string, unknown>;
}

interface ResolvedConfig {
  endpoint: string;
  token: string;
  /** True iff `token` is a real ingest token (not "" / "otel_disabled"). */
  isUsable: boolean;
}

/**
 * The build-time token wins over the `globalThis` seam, so the seam reaches only
 * unbundled source — tests. Nothing a shipped process can be made to set on
 * `globalThis` swaps the credential argent sends under or silently switches its
 * telemetry off.
 */
function readIngestToken(): string {
  if (typeof ARGENT_OTEL_INGEST_TOKEN === "string") return ARGENT_OTEL_INGEST_TOKEN;
  const g = globalThis as { __ARGENT_OTEL_TOKEN_TEST?: unknown };
  const override = g.__ARGENT_OTEL_TOKEN_TEST;
  if (typeof override === "string") return override;
  return "";
}

export function resolveConfig(): ResolvedConfig {
  const token = readIngestToken();

  const isUsable = token !== "" && token !== "otel_disabled";
  return { endpoint: OTLP_LOGS_ENDPOINT, token, isUsable };
}

/**
 * Thin transport wrapper around the OpenTelemetry Logs SDK: one analytics event
 * becomes one OTLP log record.
 */
export interface TelemetryClient {
  emit(record: EmitRecord): void;
  shutdown(timeoutMs: number): Promise<void>;
}

// OTel attribute values may not be null/undefined, and e.g. `cloud_agent` is
// null off the cloud path. Dropping those keys is lossless: absence carries the
// same meaning an explicit null would.
function toAttributes(record: EmitRecord): LogAttributes {
  const attributes: LogAttributes = {
    "distinct_id": record.distinctId,
    "event.name": record.event,
  };
  for (const [key, value] of Object.entries(record.properties)) {
    if (value === null || value === undefined) continue;
    attributes[key] = value as LogAttributes[string];
  }
  return attributes;
}

/**
 * OTLP header environment variables, cleared while the exporter is built.
 *
 * The SDK merges these into every request, keeping any key the code does not
 * set itself — so a machine already running OpenTelemetry would ship its own
 * observability credential (`x-honeycomb-team`, a Dynatrace `Api-Token`,
 * Grafana Cloud basic auth) to this collector on every batch, unsanitized.
 * Argent's telemetry needs no caller-supplied header, so drop the whole channel
 * rather than filter it.
 *
 * The exporter resolves its header set synchronously inside the constructor, so
 * clearing across that single call is enough and no other code sees the gap.
 */
const OTLP_HEADER_ENV_VARS = [
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
] as const;

export function createExporter(config: ResolvedConfig): OTLPLogExporter {
  const saved = OTLP_HEADER_ENV_VARS.map((name) => [name, process.env[name]] as const);
  for (const name of OTLP_HEADER_ENV_VARS) delete process.env[name];
  try {
    return new OTLPLogExporter({
      url: config.endpoint,
      headers: { authorization: `Bearer ${config.token}` },
      timeoutMillis: EXPORT_TIMEOUT_MS,
      // The exporter bounds a request with `req.setTimeout()`, which Node only
      // arms once the socket is CONNECTED — so a collector whose address drops
      // packets (corporate egress filter, dead host behind a firewall) leaves a
      // socket stuck connecting that no export deadline can reach, holding the
      // process open for the OS connect timeout after shutdown() has resolved.
      // The agent's socket timeout is armed when the socket is CREATED, so it
      // covers connect too: it fires, the request emits 'timeout', and the
      // exporter's handler destroys it.
      //
      // keepAlive is restated because supplying httpAgentOptions at all
      // replaces the agent the SDK would otherwise build, whose default is
      // keepAlive: true; without it the long-lived tool-server pays a fresh
      // TCP+TLS handshake for every batch.
      httpAgentOptions: { timeout: EXPORT_TIMEOUT_MS, keepAlive: true },
    });
  } finally {
    for (const [name, value] of saved) {
      if (value !== undefined) process.env[name] = value;
    }
  }
}

/**
 * Route the SDK's own diagnostics into the debug channel, once per process.
 *
 * A failed export never reaches the caller: the batch processor hands each
 * error to OpenTelemetry's global error handler, so `LoggerProvider.shutdown()`
 * resolves just as happily for a 404, a rejected ingest token or a dead
 * collector as for a delivered batch. Installing a global logger is confined to
 * ARGENT_TELEMETRY_DEBUG, so a normal run leaves a host application's own diag
 * logger alone.
 */
let diagLoggerInstalled = false;

function installDiagLogger(): void {
  if (diagLoggerInstalled || !isDebugEnabled()) return;
  diagLoggerInstalled = true;
  diag.setLogger(
    {
      error: (message, ...args) => emitDebugError(`otel: ${message}`, args),
      warn: (message, ...args) => emitDebugError(`otel: ${message}`, args),
      info: () => {},
      debug: () => {},
      verbose: () => {},
    },
    DiagLogLevel.WARN
  );
}

class OtelClient implements TelemetryClient {
  private readonly provider: LoggerProvider;
  private readonly logger: Logger;

  constructor(config: ResolvedConfig) {
    installDiagLogger();
    const exporter = createExporter(config);
    this.provider = new LoggerProvider({
      resource: resourceFromAttributes({ "service.name": SERVICE_NAME }),
      processors: [
        new BatchLogRecordProcessor({
          exporter,
          maxExportBatchSize: MAX_EXPORT_BATCH_SIZE,
          scheduledDelayMillis: SCHEDULED_DELAY_MS,
          exportTimeoutMillis: EXPORT_TIMEOUT_MS,
        }),
      ],
    });
    this.logger = this.provider.getLogger(LOGGER_NAME);
  }

  emit(record: EmitRecord): void {
    this.logger.emit({
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      body: record.event,
      attributes: toAttributes(record),
    });
  }

  async shutdown(_timeoutMs: number): Promise<void> {
    // LoggerProvider.shutdown() force-flushes the batch processor, then tears it
    // down. The time bound is enforced by the caller's Promise.race and the
    // processor's exportTimeoutMillis, so the argument is part of the
    // TelemetryClient contract rather than something this implementation reads.
    await this.provider.shutdown();
  }
}

let client: TelemetryClient | null | undefined;

export function getClient(): TelemetryClient | null {
  if (client !== undefined) return client;
  const config = resolveConfig();
  if (!config.isUsable) {
    client = null;
    return null;
  }

  try {
    client = new OtelClient(config);
  } catch {
    client = null;
    return null;
  }

  return client;
}

export function getConstructedClient(): TelemetryClient | null {
  return client ?? null;
}

export function resetClient(): void {
  client = undefined;
}
