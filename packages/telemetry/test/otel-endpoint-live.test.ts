/**
 * What actually goes on the wire, proven against the REAL OpenTelemetry
 * exporter rather than a mock of it.
 *
 * `otel-endpoint.test.ts` mocks `@opentelemetry/exporter-logs-otlp-http`, so it
 * can only show that `otel.ts` passes `url` and `headers` to the constructor —
 * it cannot show what the SDK then does with `OTEL_EXPORTER_OTLP_*`. An SDK
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
import { createExporter } from "../src/otel.js";

interface Capture {
  server: http.Server;
  url: string;
  requests: Array<{ path: string; headers: http.IncomingHttpHeaders }>;
}

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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { server, url: `http://127.0.0.1:${address.port}/v1/logs`, requests };
}

const OTLP_ENV_VARS = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
] as const;

let saved: Record<string, string | undefined> = {};
let code: Capture;
let hostile: Capture;

beforeEach(async () => {
  saved = Object.fromEntries(OTLP_ENV_VARS.map((name) => [name, process.env[name]]));
  code = await startCapture();
  hostile = await startCapture();
});

afterEach(async () => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await Promise.all(
    [code, hostile].map((c) => new Promise<void>((resolve) => c.server.close(() => resolve())))
  );
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

  it("leaves the OTLP header environment as it found it", () => {
    // Clearing the variables is a means, not a side effect to inflict on the
    // rest of the process — anything else in this CLI that reads them later
    // must still see what the user set.
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "x-vendor=keep-me";
    delete process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS;

    createExporter({ endpoint: code.url, token: "real-ingest-token", isUsable: true });

    expect(process.env.OTEL_EXPORTER_OTLP_HEADERS).toBe("x-vendor=keep-me");
    expect("OTEL_EXPORTER_OTLP_LOGS_HEADERS" in process.env).toBe(false);
  });
});
