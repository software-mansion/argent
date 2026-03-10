#!/usr/bin/env node
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Server } from "@modelcontextprotocol/sdk/server";
import { ensureToolsServer } from "./launcher.js";

let TOOLS_URL: string;
if (process.env.RADON_TOOLS_URL) {
  TOOLS_URL = process.env.RADON_TOOLS_URL;
} else {
  try {
    TOOLS_URL = await ensureToolsServer();
  } catch (err) {
    process.stderr.write(`[argent] Failed to start tools server: ${err}\n`);
    process.exit(1);
  }
}

const LOG_FILE = process.env.RADON_MCP_LOG ?? `${homedir()}/.argent/mcp-calls.log`;
let logDirReady = false;

async function spyLog(entry: Record<string, unknown>) {
  try {
    if (!logDirReady) {
      await mkdir(dirname(LOG_FILE), { recursive: true });
      logDirReady = true;
    }
    await appendFile(LOG_FILE, JSON.stringify(entry) + "\n");
  } catch { /* non-fatal */ }
}

type ToolMeta = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputHint?: string;
};

async function fetchTools(): Promise<ToolMeta[]> {
  const res = await fetch(`${TOOLS_URL}/tools`);
  const json = (await res.json()) as { tools: ToolMeta[] };
  return json.tools;
}

async function callTool(
  name: string,
  args: unknown
): Promise<{ result: unknown; outputHint?: string }> {
  const tools = await fetchTools();
  const meta = tools.find((t) => t.name === name);
  const res = await fetch(`${TOOLS_URL}/tools/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args ?? {}),
  });
  const json = (await res.json()) as { data?: unknown; error?: string; message?: string };
  if (!res.ok) throw new Error(json.error ?? json.message ?? res.statusText);
  return { result: json.data, outputHint: meta?.outputHint };
}

async function toMcpContent(result: unknown, outputHint?: string) {
  if (
    outputHint === "image" &&
    result &&
    typeof result === "object" &&
    "url" in result
  ) {
    const imgRes = await fetch((result as { url: string }).url);
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const filePath = (result as { path?: string }).path ?? "";
    return [
      {
        type: "image" as const,
        data: buf.toString("base64"),
        mimeType: "image/png" as const,
      },
      { type: "text" as const, text: `Saved: ${filePath}` },
    ];
  }
  return [{ type: "text" as const, text: JSON.stringify(result, null, 2) }];
}

const server = new Server(
  { name: "argent", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "Radon Lite — iOS Simulator Control. " +
      "Most tools require a valid license. If any tool returns an error containing " +
      "'No Radon Lite license found', call the activate-sso tool first — it opens a " +
      "browser on the user's machine for sign-in and returns { success: true, plan }. " +
      "If the browser cannot open, it returns { ssoUrl } — show that URL to the user. " +
      "Alternatively, call activate-license-key with the user's license key.",
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = await fetchTools();
  await spyLog({ ts: new Date().toISOString(), event: "list_tools", count: tools.length });
  return {
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: { type: "object" as const, ...t.inputSchema },
    })),
  };
});

server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  const t0 = Date.now();
  await spyLog({ ts: new Date().toISOString(), event: "tool_called", name: params.name, args: params.arguments });
  try {
    const { result, outputHint } = await callTool(
      params.name,
      params.arguments
    );
    await spyLog({ ts: new Date().toISOString(), event: "tool_result", name: params.name, durationMs: Date.now() - t0, isError: false, result });
    return { content: await toMcpContent(result, outputHint) };
  } catch (err) {
    await spyLog({ ts: new Date().toISOString(), event: "tool_result", name: params.name, durationMs: Date.now() - t0, isError: true, error: String(err instanceof Error ? err.message : err) });
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: String(err instanceof Error ? err.message : err),
        },
      ],
    };
  }
});

await server.connect(new StdioServerTransport());
