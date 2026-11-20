#!/usr/bin/env node
/**
 * The real Argent MCP server, run from a built checkout, for harness-check.mjs.
 *
 *   node server.mjs --repo <checkout> --home <dir> --log <file>
 *     A stdio MCP server, the one a harness spawns. Appends each handshake's clientInfo
 *     to <file>.
 *
 *   node server.mjs --repo <checkout> --home <dir> --reference
 *     Prints { instructions, tools } as JSON: the server's instructions, and its tool list
 *     with no client-specific text added (toMcpToolList with default options).
 *
 * The tool-server HTTP app runs in this process instead of as a separate one. HOME points
 * at <dir> and telemetry is off, so nothing is written to ~/.argent and nothing is sent.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    repo: { type: "string" },
    home: { type: "string" },
    log: { type: "string" },
    reference: { type: "boolean", default: false },
  },
});
const repo = values.repo;
if (!repo || !values.home) throw new Error("server.mjs needs --repo and --home");

// Before any Argent module loads: some read HOME at import time.
mkdirSync(values.home, { recursive: true });
process.env.HOME = values.home;
process.env.DO_NOT_TRACK = "1";
process.env.ARGENT_MCP_LOG = join(values.home, "mcp-calls.log");
const token = "harness-check";
process.env.ARGENT_AUTH_TOKEN = token;
// stdout carries JSON-RPC (stdio mode) or the reference JSON; logs go to stderr.
console.log = console.info = console.error;

const require = createRequire(join(repo, "packages/argent-mcp/package.json"));
const { createRegistry } = require(join(repo, "packages/tool-server/dist/utils/setup-registry.js"));
const { createHttpApp } = require(join(repo, "packages/tool-server/dist/http.js"));
const { app } = createHttpApp(createRegistry());
const http = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
const toolsUrl = `http://127.0.0.1:${http.address().port}`;
process.env.ARGENT_TOOLS_URL = toolsUrl;
process.env.ARGENT_TOOLS_TOKEN = token;

const sdk = (path) => import(require.resolve(`@modelcontextprotocol/sdk/${path}`));
const { startMcpServer } = await import(join(repo, "packages/argent-mcp/dist/mcp-server.js"));

if (values.reference) {
  const res = await fetch(`${toolsUrl}/tools`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`GET /tools failed: ${res.status}`);
  const { tools: metas } = await res.json();
  const { toMcpToolList } = await import(join(repo, "packages/argent-mcp/dist/tool-mapping.js"));

  const { InMemoryTransport } = await sdk("inMemory.js");
  const { Client } = await sdk("client/index.js");
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await startMcpServer({ paths: {}, transport: serverSide });
  const client = new Client({ name: "argent-harness-check", version: "1" });
  await client.connect(clientSide);

  const reference = { instructions: client.getInstructions() ?? "", tools: toMcpToolList(metas) };
  process.stdout.write(JSON.stringify(reference) + "\n", () => process.exit(0));
} else {
  const { StdioServerTransport } = await sdk("server/stdio.js");
  const transport = new StdioServerTransport();
  let handler;
  Object.defineProperty(transport, "onmessage", {
    get: () =>
      handler &&
      ((message, extra) => {
        if (message.method === "initialize" && values.log) {
          const entry = { ts: new Date().toISOString(), clientInfo: message.params?.clientInfo };
          appendFileSync(values.log, JSON.stringify(entry) + "\n");
        }
        return handler(message, extra);
      }),
    set: (h) => {
      handler = h;
    },
  });
  await startMcpServer({ paths: {}, transport });
  // The in-process tool-server would keep this process alive after the harness exits.
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("close", () => process.exit(0));
}
