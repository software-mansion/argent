#!/usr/bin/env node
/**
 * Calls tools through the real Argent MCP server of this checkout and saves exactly what
 * an MCP client receives: every content block of every result, including the
 * auto-screenshot and element tree appended after interaction tools.
 *
 * It runs the same pipeline a coding agent talks to, in one process:
 *
 *   createRegistry() -> tool-server HTTP app -> startMcpServer() -> MCP client (here)
 *
 * so a result is what the agent gets, before its harness adds anything of its own
 * (Claude Code, for example, adds an `[Image: source: <path>]` line after each image).
 *
 * Usage:
 *   npm run capture:tool-output -- --call 'list-devices {}'
 *   npm run capture:tool-output -- --call 'describe {"udid":"<id>"}' --call 'screenshot {"udid":"<id>"}'
 *   npm run capture:tool-output -- --steps steps.json [--var udid=<id>]... [--out <dir>]
 *
 * steps.json is a list of { "tool": "...", "args": {...}, "id"?: "...", "timeoutMs"?: n }
 * or { "sleep": ms }. An arg value "$name" is replaced by --var name=value.
 *
 * Output (default: a new folder in the temp directory), per call:
 *   NN-<id>.txt   the result as the model reads it, each image shown as [image WxH]
 *   NN-<id>.json  the content blocks; images as { mimeType, bytes, w, h, file }
 *   NN-<id>-imgK.png
 * and a table on stdout: characters of text and image sizes per call.
 *
 * The checkout is compiled first, so the results come from its current code.
 *
 * Devices are real: the calls act on the simulators, emulators and apps you name. The
 * script uses your HOME (device folders, Argent flags and config), sends no telemetry and
 * leaves no tool-server running when it exits.
 *
 * The capture reaches the tool-server as a link, so the e2e recording tools and e2e-execute
 * behave as they do over `argent link`. A `script:` step is refused, for example.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { values } = parseArgs({
  options: {
    call: { type: "string", multiple: true, default: [] },
    steps: { type: "string" },
    var: { type: "string", multiple: true, default: [] },
    out: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help || (values.call.length === 0 && !values.steps)) {
  const header = readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0];
  process.stdout.write(header.replace(/^#!.*\n\/\*\*\n/, "").replace(/^ \* ?/gm, "") + "\n");
  process.exit(values.help ? 0 : 1);
}

// Workspace packages load from dist/, so stale output would capture old results.
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const projects = ["packages/tool-server", "packages/argent-tools-client", "packages/argent-mcp"];
execFileSync(process.execPath, [tsc, "--build", ...projects], { cwd: REPO, stdio: "inherit" });
// tsc skips the .mjs runner files and the Instruments template. stdout is the result table.
const copyAssets = path.join(REPO, "packages/tool-server/scripts/copy-build-assets.mjs");
execFileSync(process.execPath, [copyAssets], { cwd: REPO, stdio: ["inherit", 2, "inherit"] });

function parseCall(spec) {
  const space = spec.indexOf(" ");
  const tool = space === -1 ? spec : spec.slice(0, space);
  const args = space === -1 ? {} : JSON.parse(spec.slice(space + 1));
  return { tool, args };
}

const steps = values.steps
  ? JSON.parse(readFileSync(values.steps, "utf8"))
  : values.call.map(parseCall);
const vars = Object.fromEntries(values.var.map((kv) => kv.split(/=(.*)/s).slice(0, 2)));
function fill(v) {
  if (typeof v === "string" && v.startsWith("$")) {
    const name = v.slice(1);
    if (!(name in vars)) throw new Error(`no --var ${name}`);
    return vars[name];
  }
  if (Array.isArray(v)) return v.map(fill);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
  }
  return v;
}

const out = values.out ?? mkdtempSync(path.join(os.tmpdir(), "argent-tool-output-"));
mkdirSync(out, { recursive: true });

// Before any Argent module loads: some read the environment at import time.
process.env.DO_NOT_TRACK = "1";
const token = `capture-${process.pid}`;
process.env.ARGENT_AUTH_TOKEN = token;
// The MCP client reads results in this process; tool-server logs go to stderr.
console.log = console.info = console.error;

const require = createRequire(path.join(REPO, "packages/argent-mcp/package.json"));
const { createRegistry } = require(
  path.join(REPO, "packages/tool-server/dist/utils/setup-registry.js")
);
const { createHttpApp } = require(path.join(REPO, "packages/tool-server/dist/http.js"));
const { app } = createHttpApp(createRegistry());
const httpServer = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
process.env.ARGENT_TOOLS_URL = `http://127.0.0.1:${httpServer.address().port}`;
process.env.ARGENT_TOOLS_TOKEN = token;

const sdk = (p) => import(require.resolve(`@modelcontextprotocol/sdk/${p}`));
const { startMcpServer } = await import(path.join(REPO, "packages/argent-mcp/dist/mcp-server.js"));
const { InMemoryTransport } = await sdk("inMemory.js");
const { Client } = await sdk("client/index.js");
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await startMcpServer({ paths: {}, transport: serverSide });
const client = new Client({ name: "argent-capture-tool-output", version: "1" });
await client.connect(clientSide);

function pngSize(buf) {
  if (buf.length > 24 && buf.toString("ascii", 12, 16) === "IHDR") {
    return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  }
  return [null, null];
}

const rows = [];
let n = 0;
for (const step of steps) {
  if (step.sleep) {
    await new Promise((r) => setTimeout(r, step.sleep));
    continue;
  }
  n++;
  const nn = String(n).padStart(2, "0");
  const id = (step.id ?? step.tool).replace(/[^\w.-]+/g, "_");
  const args = fill(step.args ?? {});
  const started = Date.now();
  let res;
  try {
    res = await client.callTool({ name: step.tool, arguments: args }, undefined, {
      timeout: step.timeoutMs ?? 300_000,
    });
  } catch (e) {
    res = {
      isError: true,
      content: [{ type: "text", text: `MCP client error: ${e?.message ?? e}` }],
    };
  }
  const ms = Date.now() - started;

  let k = 0;
  const blocks = (res.content ?? []).map((b) => {
    if (b.type !== "image") return b;
    const buf = Buffer.from(b.data, "base64");
    const [w, h] = pngSize(buf);
    const file = `${nn}-${id}-img${k++}.png`;
    writeFileSync(path.join(out, file), buf);
    return { type: "image", mimeType: b.mimeType, bytes: buf.length, w, h, file };
  });
  writeFileSync(
    path.join(out, `${nn}-${id}.json`),
    JSON.stringify({ tool: step.tool, args, ms, isError: !!res.isError, blocks }, null, 2)
  );
  const text = blocks
    .map((b) =>
      b.type === "image" ? `[image ${b.w}x${b.h}]` : b.type === "text" ? b.text : JSON.stringify(b)
    )
    .join("\n");
  writeFileSync(path.join(out, `${nn}-${id}.txt`), text);

  const row = {
    n: nn,
    tool: step.tool,
    ms,
    error: res.isError ? "yes" : "",
    textBlocks: blocks.filter((b) => b.type === "text").length,
    textChars: blocks.filter((b) => b.type === "text").reduce((sum, b) => sum + b.text.length, 0),
    images: blocks
      .filter((b) => b.type === "image")
      .map((b) => `${b.w}x${b.h}`)
      .join(" "),
  };
  rows.push(row);
  appendFileSync(path.join(out, "index.jsonl"), JSON.stringify(row) + "\n");
}

await client.close();
httpServer.close();

const cols = ["n", "tool", "ms", "error", "textBlocks", "textChars", "images"];
const width = Object.fromEntries(
  cols.map((c) => [c, Math.max(c.length, ...rows.map((r) => String(r[c]).length))])
);
const line = (r) => cols.map((c) => String(r[c]).padEnd(width[c])).join("  ");
process.stdout.write(
  [
    line(Object.fromEntries(cols.map((c) => [c, c]))),
    ...rows.map(line),
    "",
    `Saved to ${out}`,
  ].join("\n") + "\n"
);
process.exit(0);
