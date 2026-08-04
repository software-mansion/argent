/**
 * What a collector that is down, silent or rejecting costs the process that was
 * trying to reach it.
 *
 * Telemetry is a side effect of commands people are waiting on, so the property
 * that matters is not that an export succeeds - it is that a failing one is
 * bounded and invisible. `otel-endpoint.test.ts` pins the options that are meant
 * to deliver that (`timeoutMillis`, `exportTimeoutMillis`, the agent's socket
 * timeout); these drive the real exporter against real sockets and check that
 * the behaviour follows, because an option the SDK stops honouring keeps every
 * constructor assertion green.
 *
 * Three of the four states a collector address can be in are reproducible here:
 * healthy (`otel-wire.test.ts`), refused, and connected-but-silent. The fourth -
 * an address whose packets are dropped outright, which is what leaves a socket
 * stuck in connect where a request-level deadline cannot reach it - depends on
 * routing this suite cannot arrange portably. `otel-endpoint.test.ts` pins the
 * `httpAgentOptions.timeout` that covers it, since a socket timeout is armed at
 * socket creation rather than on connect.
 */
import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import net from "node:net";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { createExporter } from "../src/otel.js";

/**
 * The export deadline `otel.ts` configures. A failing export has to end within
 * a small multiple of it; the SDK's own default is 10s, which is what these
 * bounds are chosen to exclude.
 */
const EXPORT_TIMEOUT_MS = 1_500;
const FAILURE_BUDGET_MS = 6_000;

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

function track(close: () => Promise<void>): void {
  closers.push(close);
}

/** An HTTP server that reads the request and answers with `status`. */
async function startResponding(status: number): Promise<string> {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  track(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${address.port}/v1/logs`;
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  track(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      })
  );
  return { url: `http://127.0.0.1:${address.port}/v1/logs`, connections };
}

/** A port with nothing on it, for the refused case. */
async function unusedUrl(): Promise<string> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  const { port } = address;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return `http://127.0.0.1:${port}/v1/logs`;
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
    // command open after its shutdown() already resolved.
    const silent = await startSilent();

    await exportAndDrain(silent.url);

    // The client closes; the server observes it on the next turn of its loop.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(silent.connections).not.toHaveLength(0);
    for (const connection of silent.connections) expect(connection.closed).toBe(true);
  }, 30_000);

  it("bounds the retry loop when the collector refuses the connection", async () => {
    // ECONNREFUSED is retryable to the exporter, which backs off and tries
    // again; the export timeout is the only thing that stops it. A drain that
    // outlives the budget means the cap is gone.
    const url = await unusedUrl();

    const elapsed = await exportAndDrain(url);

    expect(elapsed).toBeLessThan(FAILURE_BUDGET_MS);
  }, 30_000);

  it("swallows a rejected ingest token", async () => {
    // The collector answers 401 for a token it does not recognise - which is
    // what every already-released version gets once its token is retired. The
    // batch processor hands the failure to OpenTelemetry's global error handler,
    // so shutdown() resolves exactly as it does for a delivered batch and the
    // caller is told nothing. Asserted so the day someone wants that surfaced,
    // the test says where the silence is.
    const url = await startResponding(401);

    await expect(exportAndDrain(url)).resolves.toBeLessThan(FAILURE_BUDGET_MS);
  }, 30_000);

  it("treats any 2xx as delivered, including one that stored nothing", async () => {
    // The trap the ingestion side is built around: a hostname that is answered
    // by something other than the collector - a marketing site, a proxy, a
    // captive portal - returns 200, the exporter counts the batch as delivered
    // and drops it. There is no client-side signal to distinguish this from a
    // real ingest, which is why the check has to live at deploy time, against
    // the endpoint, rather than here.
    const url = await startResponding(204);

    await expect(exportAndDrain(url)).resolves.toBeLessThan(FAILURE_BUDGET_MS);
  }, 30_000);
});
