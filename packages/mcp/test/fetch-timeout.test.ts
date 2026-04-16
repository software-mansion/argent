// Tests for the per-request fetch timeout in fetchWithReconnect.
// Before this fix, a hanging POST /tools/:name wedged the MCP parent
// indefinitely. Now each fetch attempt uses an AbortController with a
// configurable timeout (ARGENT_FETCH_TIMEOUT_MS, default 30s).

import { describe, it, expect } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import path from "node:path";

const MCP_CLI = path.resolve(import.meta.dirname, "..", "dist", "cli.js");

function startHangingToolServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/tools") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            tools: [
              {
                name: "hang-tool",
                description: "hangs forever",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          })
        );
        return;
      }
      if (req.method === "POST" && req.url === "/tools/hang-tool") {
        req.on("data", () => {});
        req.on("end", () => {
          /* never respond */
        });
        return;
      }
      res.writeHead(404);
      res.end();
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

function sendJsonRpc(child: ChildProcessWithoutNullStreams, msg: object): void {
  child.stdin.write(JSON.stringify(msg) + "\n");
}

describe("fetch timeout in fetchWithReconnect", () => {
  it("returns an error instead of hanging when tool-server never responds", async () => {
    const fake = await startHangingToolServer();

    // Use a short timeout (2s) so the test runs quickly.
    const child = spawn("node", [MCP_CLI, "mcp"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ARGENT_TOOLS_URL: `http://127.0.0.1:${fake.port}`,
        ARGENT_FETCH_TIMEOUT_MS: "2000",
      },
    });

    let stdoutBuf = "";
    const responses: object[] = [];
    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString();
      let idx;
      while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (line) {
          try {
            responses.push(JSON.parse(line));
          } catch {
            /* ignore non-JSON */
          }
        }
      }
    });

    sendJsonRpc(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    });
    sendJsonRpc(child, { jsonrpc: "2.0", method: "notifications/initialized" });

    await new Promise((r) => setTimeout(r, 500));

    sendJsonRpc(child, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "hang-tool", arguments: {} },
    });

    // With 2s timeout and up to 5 retries (each 2s + backoff),
    // the total wait is roughly 2*5 + backoff ~= 14s.
    // We give it 25s total to be safe.
    await new Promise((r) => setTimeout(r, 25_000));

    const toolCallResponse = responses.find(
      (r) => typeof r === "object" && r && (r as { id?: number }).id === 2
    );

    child.kill("SIGKILL");
    await fake.close();

    // The response MUST have arrived with an error, not hang forever.
    expect(toolCallResponse).toBeDefined();
    const result = toolCallResponse as { result?: { isError?: boolean; content?: unknown[] } };
    expect(result.result?.isError).toBe(true);
  }, 35_000);
});
