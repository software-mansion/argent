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
import {
  toMcpContent,
  flowRunToMcpContent,
  type FlowExecuteResult,
} from "./content.js";
import {
  autoScreenshotEnabled,
  getUdidFromArgs,
  shouldAutoScreenshot,
  getAutoScreenshotDelayMs,
} from "./auto-screenshot.js";

let TOOLS_URL: string;
if (process.env.ARGENT_TOOLS_URL) {
  TOOLS_URL = process.env.ARGENT_TOOLS_URL;
} else {
  try {
    TOOLS_URL = await ensureToolsServer();
  } catch (err) {
    process.stderr.write(`[argent] Failed to start tools server: ${err}\n`);
    process.exit(1);
  }
}

let reconnectPromise: Promise<void> | null = null;

async function reconnect(): Promise<void> {
  if (process.env.ARGENT_TOOLS_URL) return; // env-var path: never managed by launcher
  if (!reconnectPromise) {
    reconnectPromise = ensureToolsServer()
      .then((url) => {
        TOOLS_URL = url;
      })
      .finally(() => {
        reconnectPromise = null;
      });
  }
  return reconnectPromise;
}

async function fetchWithReconnect(
  getUrl: () => string,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await fetch(getUrl(), init);
  } catch {
    // Network-level failure (e.g. ECONNREFUSED) — server may have idle-timed-out.
    // Attempt to restart it, then retry once.
    await reconnect();
    return fetch(getUrl(), init); // TOOLS_URL is now updated
  }
}

const LOG_FILE =
  process.env.ARGENT_MCP_LOG ?? `${homedir()}/.argent/mcp-calls.log`;
let logDirReady = false;

async function spyLog(entry: Record<string, unknown>) {
  try {
    if (!logDirReady) {
      await mkdir(dirname(LOG_FILE), { recursive: true });
      logDirReady = true;
    }
    await appendFile(LOG_FILE, JSON.stringify(entry) + "\n");
  } catch {
    /* non-fatal */
  }
}

type ToolMeta = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputHint?: string;
};

async function fetchTools(): Promise<ToolMeta[]> {
  const res = await fetchWithReconnect(() => `${TOOLS_URL}/tools`);
  const json = (await res.json()) as { tools: ToolMeta[] };
  return json.tools;
}

async function callTool(
  name: string,
  args: unknown,
): Promise<{ result: unknown; outputHint?: string }> {
  const tools = await fetchTools();
  const meta = tools.find((t) => t.name === name);
  const res = await fetchWithReconnect(
    () => `${TOOLS_URL}/tools/${name}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args ?? {}),
    },
  );
  const json = (await res.json()) as {
    data?: unknown;
    error?: string;
    message?: string;
  };
  if (!res.ok) throw new Error(json.error ?? json.message ?? res.statusText);
  return { result: json.data, outputHint: meta?.outputHint };
}

const server = new Server(
  { name: "argent", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "Argent — iOS Simulator Control for interacting, testing, profiling and debugging mobile applications. " +
      "Always use discovery tools (describe / debugger-component-tree / screenshot) before tapping — never guess coordinates. " +
      "License errors: call activate-sso or activate-license-key. " +
      "On session end: call stop-all-simulator-servers and perform any necessary cleanup. " +
      "Full guidance is in the argent rule loaded from .claude/rules/argent.md.",
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = await fetchTools();
  await spyLog({
    ts: new Date().toISOString(),
    event: "list_tools",
    count: tools.length,
  });
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
  await spyLog({
    ts: new Date().toISOString(),
    event: "tool_called",
    name: params.name,
    args: params.arguments,
  });
  try {
    const { result, outputHint } = await callTool(
      params.name,
      params.arguments,
    );
    await spyLog({
      ts: new Date().toISOString(),
      event: "tool_result",
      name: params.name,
      durationMs: Date.now() - t0,
      isError: false,
      result,
    });

    let content =
      params.name === "flow-execute" &&
      result &&
      typeof result === "object" &&
      "flow" in result &&
      "steps" in result
        ? await flowRunToMcpContent(result as FlowExecuteResult)
        : await toMcpContent(result, outputHint);

    const udid = getUdidFromArgs(params.arguments);
    if (autoScreenshotEnabled() && udid && shouldAutoScreenshot(params.name)) {
      const delayMs = getAutoScreenshotDelayMs(params.name);
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));

      try {
        const screenshotResult = await callTool("screenshot", { udid });
        const screenshotContent = await toMcpContent(
          screenshotResult.result,
          "image",
        );
        content = [
          ...content,
          { type: "text" as const, text: "--- Screen after action ---" },
          ...screenshotContent,
        ];
      } catch (ssErr) {
        content = [
          ...content,
          {
            type: "text" as const,
            text: `(Auto-screenshot skipped: ${ssErr instanceof Error ? ssErr.message : String(ssErr)})`,
          },
        ];
      }
    }

    return { content };
  } catch (err) {
    await spyLog({
      ts: new Date().toISOString(),
      event: "tool_result",
      name: params.name,
      durationMs: Date.now() - t0,
      isError: true,
      error: String(err instanceof Error ? err.message : err),
    });
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

// When ARGENT_AUTO_SHUTDOWN is set and Cursor closes stdin (session end),
// tell the tools-server to shut down so simulator processes are cleaned up.
if (process.env.ARGENT_AUTO_SHUTDOWN === "1") {
  process.stdin.on("close", () => {
    fetch(`${TOOLS_URL}/shutdown`, { method: "POST" }).catch(() => {});
    setTimeout(() => process.exit(0), 5_000);
  });
}
