import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Server } from "@modelcontextprotocol/sdk/server";
import { ensureToolsServer } from "./launcher.js";
import { toMcpContent, flowRunToMcpContent, type FlowExecuteResult } from "./content.js";
import {
  autoScreenshotEnabled,
  getUdidFromArgs,
  shouldAutoScreenshot,
  getAutoScreenshotDelayMs,
} from "./auto-screenshot.js";

export async function startMcpServer(): Promise<void> {
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
    if (process.env.ARGENT_TOOLS_URL) return;
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

  const parsedTimeout = parseInt(process.env.ARGENT_FETCH_TIMEOUT_MS ?? "30000", 10);
  const FETCH_TIMEOUT_MS =
    Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 30_000;

  async function fetchWithReconnect(getUrl: () => string, init?: RequestInit): Promise<Response> {
    const MAX_RETRIES = 4;
    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      if (init?.signal) {
        init.signal.addEventListener("abort", () => controller.abort(), { once: true });
      }
      try {
        const res = await fetch(getUrl(), { ...init, signal: controller.signal });
        clearTimeout(timer);
        return res;
      } catch (err) {
        clearTimeout(timer);
        lastError = err;
        if (attempt === MAX_RETRIES) break;
        if (attempt === 0) {
          try {
            await reconnect();
          } catch (reconnectErr) {
            process.stderr.write(
              `[argent] Reconnect failed: ${reconnectErr instanceof Error ? reconnectErr.message : reconnectErr}\n`
            );
          }
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

  type ToolMeta = {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    outputHint?: string;
  };

  async function fetchTools(): Promise<ToolMeta[]> {
    const res = await fetchWithReconnect(() => `${TOOLS_URL}/tools`);
    if (!res.ok) throw new Error(`/tools returned ${res.status}: ${res.statusText}`);
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
    { name: "argent", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Argent — iOS Simulator Control for interacting, testing, profiling and debugging mobile applications. " +
        "Always use discovery tools (describe / debugger-component-tree / screenshot) before tapping — never guess coordinates. " +
        "On session end: call stop-all-simulator-servers and perform any necessary cleanup. " +
        "Full guidance is in the argent rule loaded from .claude/rules/argent.md.",
    }
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
        // 10s: tool server is single-threaded — a busy tool call blocks /tools; only a truly dead server should trigger reconnect
        const timer = setTimeout(() => controller.abort(), 10_000);
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
