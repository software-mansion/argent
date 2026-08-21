/**
 * What a collector that is down, silent or rejecting costs the process that was
 * trying to reach it.
 *
 * Telemetry is a side effect of commands people are waiting on, so the property
 * that matters is not that an export succeeds - it is that a failing one is
 * bounded and invisible. `otel-endpoint.test.ts` pins the options that are meant
 * to deliver that; these drive the real exporter against real sockets and check
 * that the behaviour follows, because an option the SDK stops honouring keeps
 * every constructor assertion green.
 *
 * What bounds a drain is the exporter's `timeoutMillis`: the retrying
 * transport's deadline, plus the `req.setTimeout()` armed per attempt. The
 * processor's `exportTimeoutMillis` does not - `LoggerProvider.shutdown()`
 * awaits the in-flight export through `forceFlush()`, and the processor's timer
 * only reports into the global error handler rather than cancelling anything.
 * So every budget below is a claim about what `createExporter` passed.
 *
 * Three of the four states a collector address can be in are reachable from a
 * test: healthy (in `otel-wire.test.ts`), refused, and connected-but-silent. The
 * fourth - an address whose packets are dropped outright, which is what leaves a
 * socket stuck in connect where a request-level deadline cannot reach it -
 * depends on routing this suite cannot arrange portably. `otel-endpoint.test.ts`
 * pins the `httpAgentOptions.timeout` that covers it, since a socket timeout is
 * armed at socket creation rather than on connect.
 */
import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import net from "node:net";
import { diag, DiagLogLevel } from "@opentelemetry/api";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { createExporter } from "../src/otel.js";
import { listenLoopback, snapshotEnv } from "./helpers.js";

/** `exportTimeoutMillis` as `otel.ts` sets it, so the wiring below mirrors `OtelClient`'s. */
const EXPORT_TIMEOUT_MS = 1_500;

/**
 * What a failing export gets. Wide enough for the exporter's 1.5s deadline plus
 * a backoff, narrow enough to exclude the SDK's own 10s default - the bound
 * every case here would otherwise fall back to without saying so.
 */
const FAILURE_BUDGET_MS = 6_000;

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

function track(close: () => Promise<void>): void {
  closers.push(close);
}

interface RespondingServer {
  url: string;
  /** Paths of the requests the collector actually received. */
  requests: string[];
}

/** An HTTP server that reads the request and answers with `status`. */
async function startResponding(status: number): Promise<RespondingServer> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      requests.push(req.url ?? "");
      res.writeHead(status, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  const port = await listenLoopback(server);
  track(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${port}/v1/logs`, requests };
}

interface SilentServer {
  url: string;
  /** Sockets the client opened, and whether each has since been torn down. */
  connections: Array<{ closed: boolean }>;
}

/**
 * A TCP listener that accepts and never speaks - the connected-but-silent case.
 * A collector wedged behind a load balancer looks exactly like this, and it is
 * the state that hangs a client with no deadline: the connection succeeds, so
 * nothing fails, and no response ever arrives.
 */
async function startSilent(): Promise<SilentServer> {
  const connections: SilentServer["connections"] = [];
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    const entry = { closed: false };
    connections.push(entry);
    sockets.push(socket);
    socket.on("close", () => {
      entry.closed = true;
    });
    socket.resume();
  });
  const port = await listenLoopback(server);
  track(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      })
  );
  return { url: `http://127.0.0.1:${port}/v1/logs`, connections };
}

/** A port with nothing on it, for the refused case. */
async function unusedUrl(): Promise<string> {
  const probe = net.createServer();
  const port = await listenLoopback(probe);
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return `http://127.0.0.1:${port}/v1/logs`;
}

/**
 * Collect what the SDK says about an export. A failure never reaches the
 * caller - the batch processor hands it to OpenTelemetry's global error handler,
 * which logs it through `diag` - so without this channel every case below is
 * just a `shutdown()` that resolved without complaint. It is what says WHY: the collector
 * count says a request was answered, this says whether the answer was taken.
 */
function captureExportErrors(): string[] {
  const errors: string[] = [];
  diag.setLogger(
    {
      error: (message, ...args) => errors.push([message, ...args.map(String)].join(" ")),
      warn: () => {},
      info: () => {},
      debug: () => {},
      verbose: () => {},
    },
    DiagLogLevel.ERROR
  );
  track(async () => diag.disable());
  return errors;
}

/**
 * Poll until `condition` holds, returning how long that took measured from
 * `started` - or Infinity if it still did not hold within `budgetMs`, so the
 * caller asserts on one number rather than on a flag plus a clock.
 */
async function settle(
  condition: () => boolean,
  started: number,
  budgetMs: number
): Promise<number> {
  while (performance.now() - started < budgetMs) {
    if (condition()) return performance.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return Infinity;
}

/**
 * Emit one record through the wiring `OtelClient` builds and drain it, returning
 * how long the drain took. Mirrors `OtelClient.emit`; see the note in
 * otel-wire.test.ts on why this is a mirror and not a call.
 */
async function exportAndDrain(endpoint: string): Promise<number> {
  const provider = new LoggerProvider({
    resource: resourceFromAttributes({ "service.name": "argent" }),
    processors: [
      new BatchLogRecordProcessor({
        exporter: createExporter({ endpoint, token: "unreachable-probe", isUsable: true }),
        maxExportBatchSize: 20,
        scheduledDelayMillis: 10_000,
        exportTimeoutMillis: EXPORT_TIMEOUT_MS,
      }),
    ],
  });
  provider.getLogger("@argent/telemetry").emit({
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    body: "tool:invoke",
    attributes: { "distinct_id": "a".repeat(64), "event.name": "tool:invoke" },
  });
  const started = performance.now();
  await provider.shutdown();
  return performance.now() - started;
}

describe("a collector that cannot take the batch", () => {
  it("gives up on a silent collector instead of waiting on it", async () => {
    // Under an environment naming a far longer deadline, because the SDK
    // resolves OTEL_EXPORTER_OTLP_TIMEOUT the way it resolves compression - from
    // the environment only when the code passes nothing - and a flipped
    // precedence there is the worse payload: a short-lived command would sit on
    // a dead collector for 12s after its shutdown() already resolved.
    // Well over FAILURE_BUDGET_MS and well under this test's own timeout, so a
    // flipped precedence fails on the budget rather than as a harness timeout.
    const restoreEnv = snapshotEnv([
      "OTEL_EXPORTER_OTLP_TIMEOUT",
      "OTEL_EXPORTER_OTLP_LOGS_TIMEOUT",
    ]);
    track(async () => restoreEnv());
    process.env.OTEL_EXPORTER_OTLP_TIMEOUT = "12000";
    process.env.OTEL_EXPORTER_OTLP_LOGS_TIMEOUT = "12000";
    const silent = await startSilent();

    const elapsed = await exportAndDrain(silent.url);

    // Connected, so nothing errors; without a deadline this drain never ends.
    expect(elapsed).toBeLessThan(FAILURE_BUDGET_MS);
    expect(silent.connections.length).toBeGreaterThan(0);
  }, 30_000);

  it("tears down the stalled socket rather than parking it in the keep-alive pool", async () => {
    // The exporter runs a keep-alive agent, so a socket surviving its request is
    // normal and wanted - for a request that COMPLETED. One abandoned at the
    // deadline has to be destroyed instead: it is attached to a request nothing
    // is waiting for any more, and a live handle is what holds a short-lived
    // command open after its shutdown() already resolved. Which makes WHEN the
    // teardown happens the whole point - the SDK's own 10s default also gets
    // there eventually, and eventually is the failure.
    const silent = await startSilent();
    const started = performance.now();

    await exportAndDrain(silent.url);
    // The client closes; the server observes it on a later turn of its loop.
    const closedAfter = await settle(
      () => silent.connections.every((c) => c.closed),
      started,
      FAILURE_BUDGET_MS
    );

    expect(silent.connections).not.toHaveLength(0);
    expect(closedAfter).toBeLessThan(FAILURE_BUDGET_MS);
  }, 30_000);

  it("bounds the retry loop when the collector refuses the connection", async () => {
    // ECONNREFUSED is retryable to the exporter, which backs off and tries
    // again. At a 1s initial backoff the transport's own retry cap never binds -
    // the export deadline is what ends the loop, on the second attempt - so a
    // drain that outlives the budget means that deadline is gone.
    const errors = captureExportErrors();
    const url = await unusedUrl();

    const elapsed = await exportAndDrain(url);

    expect(elapsed).toBeLessThan(FAILURE_BUDGET_MS);
    expect(errors.join("\n")).toContain("ECONNREFUSED");
  }, 30_000);

  it("re-sends once on a retryable status and still stops inside the budget", async () => {
    // 503 is a collector behind a restarting load balancer, and the only case
    // where it receives the same batch twice. The status never reaches the error
    // channel - the SDK reports the class, not the code - so a retried failure
    // and a rejected one are told apart by the request count, not the message.
    const errors = captureExportErrors();
    const collector = await startResponding(503);

    const elapsed = await exportAndDrain(collector.url);

    expect(elapsed).toBeLessThan(FAILURE_BUDGET_MS);
    expect(collector.requests).toEqual(["/v1/logs", "/v1/logs"]);
    expect(errors.join("\n")).toContain("retryable");
  }, 30_000);

  it("swallows a rejected ingest token", async () => {
    // The collector answers 401 for a token it does not recognise - which is
    // what every already-released version gets once its token is retired. The
    // batch processor hands the failure to OpenTelemetry's global error handler,
    // so shutdown() resolves exactly as it does for a delivered batch and the
    // caller is told nothing. Asserted so the day someone wants that surfaced,
    // the test says where the silence is.
    const errors = captureExportErrors();
    const collector = await startResponding(401);

    await expect(exportAndDrain(collector.url)).resolves.toBeLessThan(FAILURE_BUDGET_MS);

    expect(collector.requests).toEqual(["/v1/logs"]);
    expect(errors.join("\n")).toContain("401");
  }, 30_000);

  it("treats any 2xx as delivered, including one that stored nothing", async () => {
    // The trap the ingestion side is built around: a hostname that is answered
    // by something other than the collector - a marketing site, a proxy, a
    // captive portal - returns 200, the exporter counts the batch as delivered
    // and drops it. There is no client-side signal to distinguish this from a
    // real ingest, which is why the check has to live at deploy time, against
    // the endpoint, rather than here. The empty error channel IS that missing
    // signal: it is what a delivered batch and a discarded one both look like.
    const errors = captureExportErrors();
    const collector = await startResponding(204);

    await expect(exportAndDrain(collector.url)).resolves.toBeLessThan(FAILURE_BUDGET_MS);

    expect(collector.requests).toEqual(["/v1/logs"]);
    expect(errors).toEqual([]);
  }, 30_000);
});
