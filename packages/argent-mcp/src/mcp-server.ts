import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Server } from "@modelcontextprotocol/sdk/server";
import { ensureToolsServer, type ToolMeta, type ToolsServerPaths } from "@argent/tools-client";
import { toMcpContent, flowRunToMcpContent, type FlowExecuteResult } from "./content.js";
import {
  autoScreenshotEnabled,
  getUdidFromArgs,
  shouldAutoScreenshot,
  getAutoScreenshotDelayMs,
} from "./auto-screenshot.js";
import { toMcpTool } from "./tool-mapping.js";

export interface StartMcpServerOptions {
  /**
   * Locations of bundled artifacts in the published package. Required when
   * ARGENT_TOOLS_URL is not set, since the MCP server may need to spawn
   * tool-server itself.
   */
  paths: ToolsServerPaths;
}

export async function startMcpServer(options: StartMcpServerOptions): Promise<void> {
  let TOOLS_URL: string;
  if (process.env.ARGENT_TOOLS_URL) {
    TOOLS_URL = process.env.ARGENT_TOOLS_URL;
  } else {
    try {
      TOOLS_URL = await ensureToolsServer(options.paths);
    } catch (err) {
      process.stderr.write(`[argent] Failed to start tools server: ${err}\n`);
      process.exit(1);
    }
  }

  let reconnectPromise: Promise<void> | null = null;

  async function reconnect(): Promise<void> {
    if (process.env.ARGENT_TOOLS_URL) return;
    if (!reconnectPromise) {
      reconnectPromise = ensureToolsServer(options.paths)
        .then((url) => {
          TOOLS_URL = url;
        })
        .finally(() => {
          reconnectPromise = null;
        });
    }
    return reconnectPromise;
  }

  async function fetchWithReconnect(getUrl: () => string, init?: RequestInit): Promise<Response> {
    const MAX_RETRIES = 4;
    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fetch(getUrl(), init);
      } catch (err) {
        lastError = err;
        if (attempt === MAX_RETRIES) break;
        if (attempt === 0) {
          // First failure: trigger reconnect (spawns new server if dead)
          await reconnect();
        }
        // Exponential backoff: 250ms, 500ms, 1s, 2s (~3.75s total + reconnect time)
        await new Promise((r) => setTimeout(r, 250 * Math.pow(2, attempt)));
      }
    }
    throw lastError;
  }

  const LOG_FILE = process.env.ARGENT_MCP_LOG ?? `${homedir()}/.argent/mcp-calls.log`;
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

  async function fetchTools(): Promise<ToolMeta[]> {
    const res = await fetchWithReconnect(() => `${TOOLS_URL}/tools`);
    const json = (await res.json()) as { tools: ToolMeta[] };
    return json.tools;
  }

  interface ToolAPIResponse {
    data?: unknown;
    error?: string;
    message?: string;
    note?: string;
  }

  async function callTool(
    name: string,
    args: unknown
  ): Promise<{ result: unknown; outputHint?: string; note?: string }> {
    const tools = await fetchTools();
    const meta = tools.find((t) => t.name === name);
    const res = await fetchWithReconnect(() => `${TOOLS_URL}/tools/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args ?? {}),
    });

    const json = (await res.json()) as ToolAPIResponse;

    if (!res.ok) throw new Error(json.error ?? json.message ?? res.statusText);

    return { result: json.data, outputHint: meta?.outputHint, note: json.note };
  }

  const server = new Server(
    { name: "argent", version: "0.5.3" },
    {
      capabilities: { tools: {} },
      instructions:
        "Argent — iOS Simulator and Android Emulator control for interacting, testing, profiling and debugging mobile applications. " +
        "Always use discovery tools (describe / debugger-component-tree / screenshot) before tapping — never guess coordinates. " +
        "On session end: call stop-all-simulator-servers and perform any necessary cleanup. " +
        "Full guidance is in the argent rule loaded from .claude/rules/argent.md.",
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const tools = await fetchTools();
      await spyLog({
        ts: new Date().toISOString(),
        event: "list_tools",
        count: tools.length,
      });
      return { tools: tools.map(toMcpTool) };
    } catch (err) {
      process.stderr.write(
        `[argent] Failed to list tools: ${err instanceof Error ? err.message : err}\n`
      );
      return { tools: [] };
    }
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
      const { result, outputHint, note } = await callTool(params.name, params.arguments);

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
          const screenshotContent = await toMcpContent(screenshotResult.result, "image");
          content = [
            ...content,
            {
              type: "text" as const,
              text: "--- Screen after action ---",
            },
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

      if (note) {
        content = [{ type: "text" as const, text: note }, ...content];
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

  // Proactive health monitoring — restart tool server if it dies between requests
  if (!process.env.ARGENT_TOOLS_URL) {
    const HEALTH_INTERVAL_MS = 30_000;
    const healthInterval = setInterval(async () => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3_000);
        try {
          const res = await fetch(`${TOOLS_URL}/tools`, { signal: controller.signal });
          if (!res.ok) throw new Error(`health check returned ${res.status}`);
        } finally {
          clearTimeout(timer);
        }
      } catch {
        process.stderr.write("[argent] Health check failed — reconnecting tool server\n");
        reconnect().catch(() => {});
      }
    }, HEALTH_INTERVAL_MS);
    healthInterval.unref();
  }

  if (process.env.ARGENT_AUTO_SHUTDOWN === "1") {
    process.stdin.on("close", () => {
      fetch(`${TOOLS_URL}/shutdown`, { method: "POST" }).catch(() => {});
      setTimeout(() => process.exit(0), 5_000);
    });
  }
}
