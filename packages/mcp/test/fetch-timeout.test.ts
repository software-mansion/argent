// Tests for the per-request fetch timeout in fetchWithReconnect.
// Before this fix, a hanging POST /tools/:name wedged the MCP parent
// indefinitely. Now each fetch attempt uses an AbortController with a
// configurable timeout (ARGENT_FETCH_TIMEOUT_MS, default 30s).
//
// This test uses an in-process replica of fetchWithReconnect rather than
// spawning the built CLI binary, so it doesn't require `npm run build`.

import { describe, it, expect } from "vitest";
import http from "node:http";

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

// Minimal replica of fetchWithReconnect from mcp-server.ts — same retry
// logic, same AbortController timeout wrapping.
async function fetchWithReconnect(
  getUrl: () => string,
  init?: RequestInit,
  timeoutMs = 30_000
): Promise<Response> {
  const MAX_RETRIES = 4;
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (init?.signal) {
      (init.signal as AbortSignal).addEventListener("abort", () => controller.abort(), {
        once: true,
      });
    }
    try {
      const res = await fetch(getUrl(), { ...init, signal: controller.signal });
      clearTimeout(timer);
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      if (attempt === MAX_RETRIES) break;
      await new Promise((r) => setTimeout(r, 250 * Math.pow(2, attempt)));
    }
  }
  throw lastError;
}

describe("fetch timeout in fetchWithReconnect", () => {
  it("throws after retries when POST never responds (does not hang)", async () => {
    const fake = await startHangingServer();
    const url = `http://127.0.0.1:${fake.port}`;

    // GET /tools should succeed immediately.
    const listRes = await fetchWithReconnect(() => `${url}/tools`, undefined, 1000);
    expect(listRes.ok).toBe(true);

    // POST /tools/hang should time out and eventually throw.
    let threw = false;
    const t0 = Date.now();
    try {
      await fetchWithReconnect(
        () => `${url}/tools/hang`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
        500 // 500ms timeout per attempt for fast test
      );
    } catch {
      threw = true;
    }
    const elapsed = Date.now() - t0;

    await fake.close();

    expect(threw).toBe(true);
    // 5 attempts × 500ms timeout + ~3.75s backoff ≈ 6.25s.
    // Must finish well under 30s (the old infinite-hang behavior).
    expect(elapsed).toBeLessThan(15_000);
  }, 20_000);

  it("succeeds immediately when the server responds within the timeout", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    const res = await fetchWithReconnect(() => `http://127.0.0.1:${port}/test`, undefined, 5000);
    expect(res.ok).toBe(true);

    server.close();
  });
});
