/**
 * The encoding Argent actually puts on the wire, captured off a loopback socket
 * driven by the real OpenTelemetry exporter.
 *
 * This is the client half of a contract whose other half lives outside this
 * repo: the collector in front of ClickHouse is configured for OTLP/HTTP with a
 * 4 MiB body cap, and its ingest endpoint sits behind a reverse proxy that
 * allows exactly `POST /v1/logs`. Every column the analytics tables carry comes
 * from a specific place in this payload - the resource's `service.name` becomes
 * `ServiceName`, the scope's name becomes `ScopeName`, the record body becomes
 * `Body`. Nothing on the ingestion side notices if those move: an OTLP exporter
 * treats any 2xx as delivered, so a payload the collector maps differently is
 * still a successful export from here.
 *
 * `otel-endpoint.test.ts` mocks the SDK and so sees only the options passed to
 * the constructor; `otel-endpoint-live.test.ts` drives the real SDK but reads
 * only the request line and headers. Neither looks at the body, so where each
 * field sits inside it - which is what every column downstream is keyed on - is
 * pinned here and nowhere else.
 *
 * The emitted record mirrors what `OtelClient.emit` builds. It has to be a
 * mirror rather than a call: `getClient()` resolves its endpoint from the
 * hard-coded `OTLP_LOGS_ENDPOINT`, and that being unredirectable is the
 * anti-exfiltration property the client is meant to have, so there is
 * deliberately no seam to point it at a test server.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { createExporter } from "../src/otel.js";
import { listenLoopback } from "./helpers.js";

/** The subset of OTLP/JSON these assertions read. */
interface OtlpAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;
}
interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}
interface OtlpLogRecord {
  body?: OtlpAnyValue;
  severityNumber?: number;
  severityText?: string;
  attributes?: OtlpKeyValue[];
}
interface OtlpPayload {
  resourceLogs: Array<{
    resource?: { attributes?: OtlpKeyValue[] };
    scopeLogs: Array<{
      scope?: { name?: string };
      logRecords: OtlpLogRecord[];
    }>;
  }>;
}

interface CapturedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  raw: Buffer;
}

interface Capture {
  url: string;
  requests: CapturedRequest[];
}

const closers: Array<() => Promise<void>> = [];

async function startCapture(): Promise<Capture> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        raw: Buffer.concat(chunks),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  const port = await listenLoopback(server);
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${port}/v1/logs`, requests };
}

/**
 * Emit through the same provider wiring `OtelClient` builds, with the record
 * shape `OtelClient.emit` produces, and wait for the export to be attempted.
 * `shutdown()` force-flushes the batch before tearing the provider down.
 */
async function exportRecords(
  endpoint: string,
  events: Array<{ event: string; attributes: Record<string, string | number | boolean> }>
): Promise<void> {
  const provider = new LoggerProvider({
    resource: resourceFromAttributes({ "service.name": "argent" }),
    processors: [
      new BatchLogRecordProcessor({
        exporter: createExporter({ endpoint, token: "wire-probe-token", isUsable: true }),
        maxExportBatchSize: 20,
        scheduledDelayMillis: 10_000,
        exportTimeoutMillis: 1_500,
      }),
    ],
  });
  const logger = provider.getLogger("@argent/telemetry");
  for (const { event, attributes } of events) {
    logger.emit({
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      body: event,
      attributes: { "distinct_id": "a".repeat(64), "event.name": event, ...attributes },
    });
  }
  await provider.shutdown();
}

function attributeMap(pairs: OtlpKeyValue[] | undefined): Record<string, OtlpAnyValue> {
  return Object.fromEntries((pairs ?? []).map((pair) => [pair.key, pair.value]));
}

let capture: Capture;

beforeEach(async () => {
  capture = await startCapture();
});

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe("the OTLP request Argent sends", () => {
  it("is uncompressed OTLP/JSON posted to /v1/logs", async () => {
    await exportRecords(capture.url, [{ event: "tool:invoke", attributes: {} }]);

    expect(capture.requests).toHaveLength(1);
    const request = capture.requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/v1/logs");

    // JSON, not protobuf. @opentelemetry/otlp-transformer ships both
    // serializers, but the exporter package this one depends on hardcodes the
    // JSON one and sends this content-type alongside it; protobuf-over-HTTP for
    // logs is a separate package. So this pins a dependency choice rather than a
    // default anything could flip.
    expect(request.headers["content-type"]).toBe("application/json");

    // No compression - which `createExporter` has to pin, because the SDK
    // otherwise takes it from OTEL_EXPORTER_OTLP_COMPRESSION and any machine
    // that already runs OpenTelemetry sets that. Nothing here would notice: the
    // exporter treats a gzipped 2xx as delivered just the same, and the request
    // this suite and the deploy-time smoke test are written against silently
    // stops being the request argent sends.
    expect(request.headers["content-encoding"]).toBeUndefined();

    expect(request.headers.authorization).toBe("Bearer wire-probe-token");
    expect(() => JSON.parse(request.raw.toString("utf8")) as OtlpPayload).not.toThrow();
  }, 15_000);

  it("puts every column the analytics table reads where the collector looks for it", async () => {
    await exportRecords(capture.url, [
      {
        event: "tool:invoke",
        attributes: { tool: "screenshot", is_ci: false, duration_ms: 412 },
      },
    ]);

    const payload = JSON.parse(capture.requests[0]!.raw.toString("utf8")) as OtlpPayload;
    const resourceLogs = payload.resourceLogs[0]!;
    const scopeLogs = resourceLogs.scopeLogs[0]!;
    const record = scopeLogs.logRecords[0]!;

    // -> ClickHouse ServiceName. The ingestion smoke test asserts "argent".
    expect(attributeMap(resourceLogs.resource?.attributes)["service.name"]?.stringValue).toBe(
      "argent"
    );
    // -> ScopeName.
    expect(scopeLogs.scope?.name).toBe("@argent/telemetry");
    // -> Body. Where argent puts the event name - OTLP's own eventName field is
    // left unset.
    expect(record.body?.stringValue).toBe("tool:invoke");
    // -> SeverityNumber. 9 is INFO.
    expect(record.severityNumber).toBe(SeverityNumber.INFO);
    expect(record.severityText).toBe("INFO");

    const attributes = attributeMap(record.attributes);
    expect(attributes["event.name"]?.stringValue).toBe("tool:invoke");
    expect(attributes["distinct_id"]?.stringValue).toBe("a".repeat(64));

    // Attributes keep their OTLP type on the wire and are flattened to strings
    // only on the way into ClickHouse's Map(LowCardinality(String), String),
    // which is why a query that aggregates a numeric property has to cast it.
    // Sending them pre-stringified would be indistinguishable there and wrong
    // everywhere else.
    expect(attributes["tool"]?.stringValue).toBe("screenshot");
    expect(attributes["is_ci"]?.boolValue).toBe(false);
    expect(String(attributes["duration_ms"]?.intValue)).toBe("412");
  }, 15_000);

  it("never puts more than one batch of records in a single request", async () => {
    // maxExportBatchSize is what keeps a request small enough that the body caps
    // in front of ClickHouse - 4 MB at the proxy, 4 MiB at the collector behind
    // it - are unreachable in normal operation. A batch that grew past the
    // proxy's would be refused there, and a refusal at the edge is invisible
    // from here.
    const events = Array.from({ length: 25 }, (_, index) => ({
      event: `tool:invoke:${index}`,
      attributes: {},
    }));
    await exportRecords(capture.url, events);

    const perRequest = capture.requests.map((request) => {
      const payload = JSON.parse(request.raw.toString("utf8")) as OtlpPayload;
      return payload.resourceLogs.flatMap((resource) =>
        resource.scopeLogs.flatMap((scope) => scope.logRecords)
      ).length;
    });

    expect(perRequest.reduce((sum, count) => sum + count, 0)).toBe(25);
    for (const count of perRequest) expect(count).toBeLessThanOrEqual(20);
  }, 15_000);
});
