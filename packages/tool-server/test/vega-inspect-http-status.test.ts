/**
 * Regression for PR #366 review thread r3442921231.
 *
 * The Vega automation toolkit is reached over a forwarded HTTP port, so `postJson`
 * must honor the response status: a non-2xx toolkit answer has to surface as a
 * thrown error (which `describeVega` degrades to its empty-tree + relaunch-hint
 * fallback), never be handed downstream as page source. Otherwise a success-shaped
 * 500 body is parsed into a real-looking tree, and a structured/empty error body is
 * misreported as an empty screen.
 *
 * vega-inspect's only host deps (adb forward + serial discovery) are stubbed so the
 * real fetchVegaPageSource/postJson talk to a fake local toolkit instead of a VVD.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";

const runAdb = vi.fn(async (..._a: unknown[]) => ({ stdout: "", stderr: "", code: 0 }));
const emulatorSerial = vi.fn();
vi.mock("../src/utils/adb", () => ({ runAdb: (...a: unknown[]) => runAdb(...a) }));
vi.mock("../src/utils/vega-automation", () => ({
  emulatorSerial: (...a: unknown[]) => emulatorSerial(...a),
}));

import { fetchVegaPageSource } from "../src/utils/vega-inspect";
import { describeVega } from "../src/tools/describe/platforms/vega";

// Must match HOST_PORT_OFFSET in vega-inspect.ts: forwarded host port = consolePort + 10000.
const HOST_PORT_OFFSET = 10_000;

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    server.close();
    await once(server, "close").catch(() => {});
    server = undefined;
  }
});

/** Stand up a fake toolkit on a free port and point emulatorSerial at it. */
async function fakeToolkit(status: number, body: string): Promise<void> {
  server = createServer((_req, res) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const hostPort = (server.address() as AddressInfo).port;
  emulatorSerial.mockResolvedValue({
    serial: "emulator-5554",
    consolePort: hostPort - HOST_PORT_OFFSET,
  });
}

// A success-shaped page source with one focusable "Search" button — non-empty when
// parsed, so a 500 body leaking through would be observable as a populated tree.
const PAGE =
  '<root><window width="1920" height="1080">' +
  '<view role="button" focusable="true" focused="true" x="0" y="0" width="200" height="80">' +
  "<text>Search</text></view></window></root>";

describe("fetchVegaPageSource honors the toolkit HTTP status", () => {
  it("rejects a non-2xx response even when its body is success-shaped", async () => {
    await fakeToolkit(500, JSON.stringify({ jsonrpc: "2.0", id: 1, result: PAGE }));
    await expect(fetchVegaPageSource(2000)).rejects.toThrow(/HTTP 500/);
  });

  it("resolves the page source on a 2xx response", async () => {
    await fakeToolkit(200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: PAGE }));
    await expect(fetchVegaPageSource(2000)).resolves.toContain("<root>");
  });
});

describe("describeVega degrades a failing toolkit, never acts on bad data", () => {
  it("does not surface a populated tree from an HTTP 500 body", async () => {
    await fakeToolkit(500, JSON.stringify({ jsonrpc: "2.0", id: 1, result: PAGE }));
    const out = await describeVega("amazon-test");
    expect(out.source).toBe("vega-automation");
    // Would be a "Search" button if the 500 body leaked past the status check.
    expect(out.tree.children).toEqual([]);
    expect(out.hint).toMatch(/relaunch the foreground app/i);
  });

  it("degrades a non-XML 2xx body to empty tree + hint without crashing", async () => {
    // The parse guard half of the same thread: a 200 whose result is non-XML and
    // over the 50-char empty gate must be caught, not escape as a raw parse error.
    const nonXml = "automation toolkit returned an opaque non-XML diagnostic payload string";
    expect(nonXml.length).toBeGreaterThan(50);
    await fakeToolkit(200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: nonXml }));
    const out = await describeVega("amazon-test");
    expect(out.tree.children).toEqual([]);
    expect(out.hint).toMatch(/relaunch the foreground app/i);
  });
});
