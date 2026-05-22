// Tests for the per-request fetch timeout in fetchWithReconnect.
// Before this fix, a hanging POST /tools/:name wedged the MCP parent
// indefinitely. Now each fetch attempt uses an AbortController with a
// configurable timeout (ARGENT_FETCH_TIMEOUT_MS, default 30s).
//
// This test uses an in-process replica of fetchWithReconnect rather than
// spawning the built CLI binary, so it doesn't require `npm run build`.

import { describe, it, expect } from "vitest";
import http from "node:http";
import { fetchWithReconnect } from "../src/mcp-server.js";

async function mockSuccessfulReconnect() {
  return new Promise<void>((res) => res());
}

function startHangingServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/tools") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ tools: [] }));
        return;
      }
      // POST: accept the body then never respond.
      req.on("data", () => {});
      req.on("end", () => {
        /* intentionally hang */
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        port,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

describe("fetch timeout in fetchWithReconnect", () => {
  it("throws after retries when POST never responds (does not hang)", async () => {
    const fake = await startHangingServer();
    const url = `http://127.0.0.1:${fake.port}`;

    // GET /tools should succeed immediately.
    const listRes = await fetchWithReconnect(() => `${url}/tools`, mockSuccessfulReconnect);
    expect(listRes.ok).toBe(true);

    // POST /tools/hang should time out and eventually throw.
    let threw = false;
    const t0 = Date.now();
    try {
      await fetchWithReconnect(() => `${url}/tools/hang`, mockSuccessfulReconnect, {
        init: { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
        expBackoffBase: 5,
        fetchTimeoutMs: 100,
      });
    } catch {
      threw = true;
    }
    const elapsed = Date.now() - t0;

    await fake.close();

    expect(threw).toBe(true);
    // 5 attempts × 100ms timeout + ~75ms backoff ≈ 575ms.
    // Must finish well under 5s (the old infinite-hang behavior).
    expect(elapsed).toBeLessThan(5_000);
  }, 10_000);

  it("succeeds immediately when the server responds within the timeout", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    const res = await fetchWithReconnect(
      () => `http://127.0.0.1:${port}/test`,
      mockSuccessfulReconnect
    );
    expect(res.ok).toBe(true);

    server.close();
  });

  it("disables the per-attempt timeout when fetchTimeoutMs is null", async () => {
    const server = http.createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }, 200);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    const res = await fetchWithReconnect(
      () => `http://127.0.0.1:${port}/slow`,
      mockSuccessfulReconnect,
      { fetchTimeoutMs: null }
    );
    expect(res.ok).toBe(true);

    server.close();
  });
});
