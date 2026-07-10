import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createToolsClient } from "../src/tools-client.js";

let server: Server | undefined;

/**
 * Stand up a stub tool-server: GET /tools advertises one tool ("streamy",
 * no fileInputs so the file boundary stays out of the way); POST behavior is
 * supplied per test. ARGENT_TOOLS_URL routes the client at it.
 */
async function startServer(
  onInvoke: (req: IncomingMessage, res: ServerResponse) => void
): Promise<void> {
  server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/tools") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ tools: [{ name: "streamy", description: "", inputSchema: {} }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/tools/streamy") {
      onInvoke(req, res);
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server!.address() as AddressInfo;
  vi.stubEnv("ARGENT_TOOLS_URL", `http://127.0.0.1:${port}`);
}

afterEach(async () => {
  vi.unstubAllEnvs();
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

describe("callTool progress streaming", () => {
  it("fires onProgress per NDJSON line and resolves with the terminal result", async () => {
    await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(`${JSON.stringify({ event: "progress", data: { index: 0 } })}\n`);
      res.write(`${JSON.stringify({ event: "progress", data: { index: 1 } })}\n`);
      res.end(`${JSON.stringify({ event: "result", data: { ok: true }, note: "hi" })}\n`);
    });

    const events: unknown[] = [];
    const { callTool } = createToolsClient();
    const result = await callTool("streamy", {}, { onProgress: (e) => events.push(e) });

    expect(events).toEqual([{ index: 0 }, { index: 1 }]);
    expect(result.data).toEqual({ ok: true });
    expect(result.note).toBe("hi");
  });

  it("sends the Accept header only when a progress consumer is attached", async () => {
    const accepts: Array<string | undefined> = [];
    await startServer((req, res) => {
      accepts.push(req.headers.accept);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: { ok: true } }));
    });

    const { callTool } = createToolsClient();
    await callTool("streamy", {});
    await callTool("streamy", {}, { onProgress: () => {} });

    expect(accepts[0] ?? "").not.toContain("application/x-ndjson");
    expect(accepts[1]).toContain("application/x-ndjson");
  });

  it("falls back to the buffered path against a pre-streaming server", async () => {
    // An old server ignores the Accept header and replies plain JSON.
    await startServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: { ok: true } }));
    });

    const events: unknown[] = [];
    const { callTool } = createToolsClient();
    const result = await callTool("streamy", {}, { onProgress: (e) => events.push(e) });

    expect(events).toEqual([]);
    expect(result.data).toEqual({ ok: true });
  });

  it("rejects with the in-band terminal error", async () => {
    await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(`${JSON.stringify({ event: "progress", data: { index: 0 } })}\n`);
      res.end(`${JSON.stringify({ event: "error", error: "kaput" })}\n`);
    });

    const events: unknown[] = [];
    const { callTool } = createToolsClient();
    await expect(callTool("streamy", {}, { onProgress: (e) => events.push(e) })).rejects.toThrow(
      "kaput"
    );
    expect(events).toEqual([{ index: 0 }]);
  });

  it("rejects when the stream ends without a terminal line (connection lost)", async () => {
    await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(`${JSON.stringify({ event: "progress", data: { index: 0 } })}\n`);
      res.end();
    });

    const { callTool } = createToolsClient();
    await expect(callTool("streamy", {}, { onProgress: () => {} })).rejects.toThrow(
      /without a result/
    );
  });
});
