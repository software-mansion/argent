/**
 * What actually goes on the wire, proven against the REAL OpenTelemetry
 * exporter rather than a mock of it.
 *
 * `otel-endpoint.test.ts` mocks `@opentelemetry/exporter-logs-otlp-http`, so it
 * can only show what `otel.ts` passes to the constructor — it cannot show what
 * the SDK then does with `OTEL_EXPORTER_OTLP_*`. An SDK
 * upgrade that changed that handling would keep every assertion there green
 * while telemetry started going somewhere else, or carrying something extra.
 *
 * So this drives `createExporter` — the real function, including its env
 * handling — against loopback servers: one standing in for the hard-coded
 * collector, one for what a hostile env var would name. No network is involved.
 * `resolveConfig()` is what pins the endpoint itself to the production URL, and
 * `otel-endpoint.test.ts` covers that.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { diag, DiagLogLevel } from "@opentelemetry/api";
import { createExporter } from "../src/otel.js";
import { listenLoopback, snapshotEnv } from "./helpers.js";

interface Capture {
  url: string;
  requests: Array<{ path: string; headers: http.IncomingHttpHeaders }>;
}

const closers: Array<() => Promise<void>> = [];

async function startCapture(): Promise<Capture> {
  const requests: Capture["requests"] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      requests.push({ path: req.url ?? "", headers: req.headers });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  const port = await listenLoopback(server);
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${port}/v1/logs`, requests };
}

const OTLP_ENV_VARS = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_COMPRESSION",
  "OTEL_EXPORTER_OTLP_LOGS_COMPRESSION",
  "OTEL_EXPORTER_OTLP_CERTIFICATE",
  "OTEL_EXPORTER_OTLP_LOGS_CERTIFICATE",
  "OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE",
  "OTEL_EXPORTER_OTLP_LOGS_CLIENT_CERTIFICATE",
  "OTEL_EXPORTER_OTLP_CLIENT_KEY",
  "OTEL_EXPORTER_OTLP_LOGS_CLIENT_KEY",
];

let restoreEnv: () => void;
let code: Capture;
let hostile: Capture;

beforeEach(async () => {
  restoreEnv = snapshotEnv(OTLP_ENV_VARS);
  code = await startCapture();
  hostile = await startCapture();
});

afterEach(async () => {
  restoreEnv();
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** Emit one record through the same provider wiring `OtelClient` builds. */
async function exportOneRecord(endpoint: string, token: string): Promise<void> {
  const provider = new LoggerProvider({
    resource: resourceFromAttributes({ "service.name": "argent" }),
    processors: [
      new BatchLogRecordProcessor({
        exporter: createExporter({ endpoint, token, isUsable: true }),
        maxExportBatchSize: 20,
        scheduledDelayMillis: 10_000,
        exportTimeoutMillis: 1_500,
      }),
    ],
  });
  provider.getLogger("@argent/telemetry").emit({
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    body: "endpoint_invariance_probe",
    attributes: { "distinct_id": "probe", "event.name": "endpoint_invariance_probe" },
  });
  // shutdown() force-flushes the batch and then tears the provider down, so the
  // export has been attempted by the time it resolves.
  await provider.shutdown();
}

describe("what reaches the collector, against the real OTLP exporter", () => {
  it("delivers to the url passed in code while every OTLP env var names another host", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = hostile.url.replace("/v1/logs", "");
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = hostile.url;
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "grpc";

    await exportOneRecord(code.url, "real-ingest-token");

    expect(hostile.requests).toHaveLength(0);
    expect(code.requests).toHaveLength(1);
    expect(code.requests[0]!.path).toBe("/v1/logs");
  }, 15_000);

  it("keeps the code-supplied bearer token when an env var supplies another", async () => {
    // Getting redirected is one failure; shipping to the right collector under
    // an attacker's token is another. The explicit header has to win.
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "authorization=Bearer steal-me";
    process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS = "authorization=Bearer steal-me-logs";

    await exportOneRecord(code.url, "real-ingest-token");

    expect(code.requests).toHaveLength(1);
    expect(code.requests[0]!.headers.authorization).toBe("Bearer real-ingest-token");
  }, 15_000);

  it("forwards no third-party header the environment names", async () => {
    // A developer who already runs OpenTelemetry keeps their own vendor
    // credential in exactly this variable. The SDK merges any key the code does
    // not set, so without createExporter clearing it, that secret would ship to
    // Software Mansion's collector on every batch.
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "x-honeycomb-team=hcaik_REAL_CUSTOMER_KEY";
    process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS = "x-dt-api-token=dt0c01.LEAKED";

    await exportOneRecord(code.url, "real-ingest-token");

    expect(code.requests).toHaveLength(1);
    const headers = code.requests[0]!.headers;
    expect(headers["x-honeycomb-team"]).toBeUndefined();
    expect(headers["x-dt-api-token"]).toBeUndefined();
    expect(headers.authorization).toBe("Bearer real-ingest-token");
  }, 15_000);

  it("posts the encoding the code chose when an env var asks for gzip", async () => {
    // A machine that already runs OpenTelemetry sets this for its own collector,
    // and the encoding argent posts is not that machine's to pick.
    // otel-wire.test.ts captures the uncompressed request the ingestion side is
    // sized and smoke-tested against.
    process.env.OTEL_EXPORTER_OTLP_COMPRESSION = "gzip";
    process.env.OTEL_EXPORTER_OTLP_LOGS_COMPRESSION = "gzip";

    await exportOneRecord(code.url, "real-ingest-token");

    expect(code.requests).toHaveLength(1);
    expect(code.requests[0]!.headers["content-encoding"]).toBeUndefined();
  }, 15_000);

  it("reads no file an OTLP certificate variable names", () => {
    // The SDK resolves these with a synchronous fs.readFileSync while the
    // exporter is constructed, and only then discards the https agent it built
    // from them in favour of the explicit httpAgentOptions. So the file is read
    // for nothing - and a path that never answers, a dead network mount or a
    // fifo with no writer, hangs the command that emitted the event instead
    // (measured: the constructor never returned).
    const warnings: string[] = [];
    diag.setLogger(
      {
        error: () => {},
        warn: (message) => warnings.push(String(message)),
        info: () => {},
        debug: () => {},
        verbose: () => {},
      },
      DiagLogLevel.WARN
    );
    // Both spellings: the SDK reads `signalSpecific ?? nonSignalSpecific`, so
    // the _LOGS_ form wins - and it is the one a machine already exporting logs
    // elsewhere has set.
    process.env.OTEL_EXPORTER_OTLP_CERTIFICATE = "/nonexistent/argent-probe-ca.pem";
    process.env.OTEL_EXPORTER_OTLP_LOGS_CERTIFICATE = "/nonexistent/argent-probe-logs-ca.pem";
    process.env.OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE = "/nonexistent/argent-probe-cert.pem";
    process.env.OTEL_EXPORTER_OTLP_LOGS_CLIENT_CERTIFICATE =
      "/nonexistent/argent-probe-logs-cert.pem";
    process.env.OTEL_EXPORTER_OTLP_CLIENT_KEY = "/nonexistent/argent-probe-key.pem";
    process.env.OTEL_EXPORTER_OTLP_LOGS_CLIENT_KEY = "/nonexistent/argent-probe-logs-key.pem";

    try {
      createExporter({ endpoint: code.url, token: "real-ingest-token", isUsable: true });
    } finally {
      diag.disable();
    }

    expect(warnings).toEqual([]);
  });

  it("leaves the OTLP environment as it found it", () => {
    // Clearing the header variables is a means, not a side effect to inflict on
    // the rest of the process — anything else in this CLI that reads them later
    // must still see what the user set. The compression variable is here for the
    // opposite reason: the explicit option already beats it, so winning by
    // clobbering it would be a strictly worse implementation this suite would
    // otherwise be unable to tell from the shipped one.
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "x-vendor=keep-me";
    delete process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS;
    process.env.OTEL_EXPORTER_OTLP_CERTIFICATE = "/etc/ssl/corp-ca.pem";
    process.env.OTEL_EXPORTER_OTLP_COMPRESSION = "gzip";

    createExporter({ endpoint: code.url, token: "real-ingest-token", isUsable: true });

    expect(process.env.OTEL_EXPORTER_OTLP_HEADERS).toBe("x-vendor=keep-me");
    expect("OTEL_EXPORTER_OTLP_LOGS_HEADERS" in process.env).toBe(false);
    expect(process.env.OTEL_EXPORTER_OTLP_CERTIFICATE).toBe("/etc/ssl/corp-ca.pem");
    expect(process.env.OTEL_EXPORTER_OTLP_COMPRESSION).toBe("gzip");
  });
});
