import { afterEach, describe, expect, it } from "vitest";
import * as http from "node:http";
import { probeArgentToolServer } from "../src/utils/probe-argent-tool-server";

// Bind an ephemeral loopback server with a given handler; returns its port.
function listen(handler: http.RequestListener): Promise<{ port: number; server: http.Server }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ port: typeof addr === "object" && addr ? addr.port : 0, server });
    });
  });
}

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

describe("probeArgentToolServer", () => {
  it("returns true for an argent peer answering /tools with 200", async () => {
    const { port, server } = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ tools: [] }));
    });
    servers.push(server);
    await expect(probeArgentToolServer("127.0.0.1", port)).resolves.toBe(true);
  });

  it("returns true for a token-protected peer answering /tools with 401", async () => {
    const { port, server } = await listen((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Missing or invalid Authorization header." }));
    });
    servers.push(server);
    await expect(probeArgentToolServer("127.0.0.1", port)).resolves.toBe(true);
  });

  it("returns false for a foreign server answering with a non-argent status (500)", async () => {
    const { port, server } = await listen((_req, res) => {
      res.writeHead(500);
      res.end("nope");
    });
    servers.push(server);
    await expect(probeArgentToolServer("127.0.0.1", port)).resolves.toBe(false);
  });

  it("returns false when nothing is listening (connection refused)", async () => {
    // Grab a port then immediately release it so the connection is refused.
    const { port, server } = await listen((_req, res) => res.end());
    await new Promise<void>((r) => server.close(() => r()));
    await expect(probeArgentToolServer("127.0.0.1", port)).resolves.toBe(false);
  });

  it("returns false when the peer accepts but never responds (wedged) before the timeout", async () => {
    const { port, server } = await listen(() => {
      /* accept the request but never write a response → probe must time out */
    });
    servers.push(server);
    await expect(probeArgentToolServer("127.0.0.1", port, 150)).resolves.toBe(false);
  });
});
