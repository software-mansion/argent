import type { LogAttributes, Logger } from "@opentelemetry/api-logs";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { diag, DiagLogLevel } from "@opentelemetry/api";
import { isDebugEnabled, emitDebugError } from "./debug.js";

/**
 * Hard-coded OTLP/HTTP logs endpoint so env-var overrides cannot redirect
 * ingestion. Argent telemetry is exported as OpenTelemetry log records to
 * Software Mansion's own collector; the endpoint and the authorization header
 * are passed to the exporter explicitly in code, and an explicit value wins over
 * the corresponding OTEL_EXPORTER_OTLP_* environment variable — the same
 * anti-exfiltration guarantee a fixed ingestion host gives.
 *
 * otel-endpoint-live.test.ts pins that precedence against the real exporter,
 * because otel-endpoint.test.ts mocks it and so cannot see the SDK change its
 * mind.
 *
 * The header channel is closed separately, in createExporter — an explicit
 * value only wins for the keys the code sets, which would leave every other
 * header the environment names riding along.
 */
export const OTLP_LOGS_ENDPOINT = "https://argent-otel.swmansion.com/v1/logs";

/**
 * Build-time-injected ingest token (esbuild `define`, mirroring the
 * ARGENT_CLI_VERSION identifier in base-props.ts). Every bundle substitutes a
 * string literal here — the release token, or "" when the build environment
 * supplies none, which leaves the client unconstructed and telemetry inert.
 * Unbundled source (tests, emergency-local builds) leaves the identifier
 * undefined.
 *
 * It has to be this bare identifier: esbuild `define` rewrites identifiers, not
 * property accesses, so a `globalThis.__ARGENT_OTEL_TOKEN_TEST`-shaped read
 * could never receive the substitution.
 */
declare const ARGENT_OTEL_INGEST_TOKEN: string | undefined;

/** Resource `service.name` attribute value. */
const SERVICE_NAME = "argent";

/** Logger instrumentation-scope name. */
const LOGGER_NAME = "@argent/telemetry";

// Batching parameters: queue up to 20 records and flush every 10s.
// EXPORT_TIMEOUT_MS bounds each export AND caps the OTLP exporter's built-in
// retry loop, which treats a connection failure (ECONNREFUSED, timeout, DNS) as
// retryable and would otherwise keep re-sending with backoff. It is deliberately kept at or below index.ts's
// SHORT_FLUSH_TIMEOUT_MS drain budget so a stalled export to an unreachable/slow
// collector can't hold a short-lived command's process open past shutdown()'s
// bounded drain: the exporter's in-flight socket and retry timer are the only
// things keeping the event loop alive, and this deadline is what abandons them —
// but only once the socket is connected, so it is paired with an agent-level
// socket timeout below that covers connection establishment as well. A reachable
// collector answers in well under this bound, so delivery is unaffected.
const MAX_EXPORT_BATCH_SIZE = 20;
const SCHEDULED_DELAY_MS = 10_000;
const EXPORT_TIMEOUT_MS = 1_500;

/** One analytics event, ready to become a single OTLP log record. */
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
 * unbundled source — which is to say tests. Every bundle defines the identifier
 * as a string literal (the release token, or ""), so nothing a shipped process
 * can be made to set on `globalThis` swaps the credential argent sends under or
 * silently switches its telemetry off.
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

  // Sentinel guard for tests and emergency local builds.
  const isUsable = token !== "" && token !== "otel_disabled";
  return { endpoint: OTLP_LOGS_ENDPOINT, token, isUsable };
}

/**
 * Thin transport wrapper around the OpenTelemetry Logs SDK. One analytics event
 * becomes one OTLP log record: the event name is the record body, and the
 * per-machine distinct id plus the sanitized/base properties are its attributes.
 */
export interface TelemetryClient {
  emit(record: EmitRecord): void;
  shutdown(timeoutMs: number): Promise<void>;
}

// The SDK accepts a null attribute and serializes it as an empty OTLP value,
// which is stored as, and unrecoverable from, a property that really was empty.
// Drop those keys instead — for every property here (e.g. `cloud_agent`, null on
// the common non-cloud path), absence carries the same meaning an explicit null
// would.
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
 * OTLP environment variables cleared while the exporter is built — the ones the
 * SDK acts on whatever the code passes.
 *
 * Headers it MERGES, keeping any key the code does not set itself. Out in the
 * world that variable holds the developer's OWN observability credential —
 * `x-honeycomb-team`, a Dynatrace `Api-Token`, Grafana Cloud basic auth — so a
 * machine that already runs OpenTelemetry would ship that third-party secret to
 * this collector on every batch, without it ever passing the sanitizer. Argent's
 * telemetry needs no caller-supplied header, so drop the whole channel rather
 * than filter it.
 *
 * The certificate paths never reach the wire: the https agent the SDK builds
 * from them loses to the explicit httpAgentOptions below. But it reads them to
 * build it, with a synchronous fs.readFileSync — so a path that never answers,
 * a dead network mount or a fifo with no writer, hangs the command that emitted
 * the event, on a read whose result is then discarded.
 *
 * Everything else the SDK takes from the environment only when the code passes
 * nothing — compression, timeout — so an explicit value settles those and they
 * are not listed here.
 *
 * All of this is resolved synchronously inside the constructor, so clearing the
 * variables across that single call is enough, and no other code can observe
 * the gap.
 */
const CLEARED_OTLP_ENV_VARS = [
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
  "OTEL_EXPORTER_OTLP_CERTIFICATE",
  "OTEL_EXPORTER_OTLP_LOGS_CERTIFICATE",
  "OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE",
  "OTEL_EXPORTER_OTLP_LOGS_CLIENT_CERTIFICATE",
  "OTEL_EXPORTER_OTLP_CLIENT_KEY",
  "OTEL_EXPORTER_OTLP_LOGS_CLIENT_KEY",
] as const;

/**
 * `CompressionAlgorithm.NONE`, spelled as its wire value: the enum lives in
 * @opentelemetry/otlp-exporter-base, which reaches this package only as a
 * transitive dependency of the http exporter.
 */
const NO_COMPRESSION = "none" as NonNullable<
  ConstructorParameters<typeof OTLPLogExporter>[0]
>["compression"];

export function createExporter(config: ResolvedConfig): OTLPLogExporter {
  const saved = CLEARED_OTLP_ENV_VARS.map((name) => [name, process.env[name]] as const);
  for (const name of CLEARED_OTLP_ENV_VARS) delete process.env[name];
  try {
    return new OTLPLogExporter({
      url: config.endpoint,
      headers: { authorization: `Bearer ${config.token}` },
      timeoutMillis: EXPORT_TIMEOUT_MS,
      // Left unset, the SDK takes this from OTEL_EXPORTER_OTLP_COMPRESSION (or
      // its _LOGS_ variant), so a machine that already runs OpenTelemetry would
      // gzip argent's batches - a request shaped differently from the one the
      // ingestion side is sized and tested against, decided by a variable set
      // for something else. Unlike the variables cleared above, one explicit
      // value settles it: the SDK takes user-provided over env here rather than
      // merging the two or reading anything to decide.
      compression: NO_COMPRESSION,
      // The exporter bounds a request with `req.setTimeout()`, which Node only
      // arms once the socket is CONNECTED — so a collector whose address drops
      // packets (corporate egress filter, dead host behind a firewall) leaves a
      // socket stuck in the connecting state that no export deadline can reach,
      // holding the process open for the OS connect timeout (~75s on macOS)
      // after shutdown() has already resolved. The agent's socket timeout is
      // armed when the socket is CREATED, so it also covers connect: it fires,
      // the request emits 'timeout', and the exporter's handler destroys it.
      //
      // keepAlive is restated because supplying httpAgentOptions at all
      // replaces the agent the SDK would otherwise build, and its default is
      // keepAlive: true. Without it the long-lived tool-server pays a fresh
      // TCP+TLS handshake for every 10s batch — measured as one socket per
      // request against a loopback collector, versus one socket shared.
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
 * collector as for a delivered batch. Without this, ARGENT_TELEMETRY_DEBUG=1
 * prints the payload argent meant to send and gives no way at all to find out
 * whether it arrived.
 *
 * Installing a global logger is only acceptable because it is confined to the
 * debug flag — a normal run leaves OpenTelemetry's diagnostics untouched, and
 * so leaves any host application's own diag logger alone.
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
    // LoggerProvider.shutdown() force-flushes the batch processor and then tears
    // it down. The time bound comes from the caller's Promise.race and from the
    // exporter's timeoutMillis — NOT from exportTimeoutMillis, which the
    // force-flush awaits straight past (otel-unreachable.test.ts measures it) —
    // so the argument is part of the TelemetryClient contract rather than
    // something this implementation reads.
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
