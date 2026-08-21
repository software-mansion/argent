import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Server } from "@modelcontextprotocol/sdk/server";
import {
  ensureToolsServer,
  getResolvedToolsUrl,
  isRemoteRouted,
  getDeviceIdFromArgs,
  prepareFileInputs,
  applyClientFileDirectives,
  type ToolMeta,
  type ToolsServerPaths,
} from "@argent/tools-client";
import {
  canonicalizeAiClient,
  FIRST_RUN_NOTICE,
  markFirstRunNoticeShown,
  shouldShowFirstRunNotice,
} from "@argent/telemetry";
import {
  toMcpContent,
  flowRunToMcpContent,
  screenshotDiffToMcpContent,
  isScreenshotDiffResult,
  type ContentContext,
  type ContentBlock,
  type FlowExecuteResult,
} from "./content.js";
import {
  autoScreenshotEnabled,
  containsSecretPlaceholder,
  getUdidFromArgs,
  shouldAutoScreenshot,
  getAutoScreenshotDelayMs,
} from "./auto-screenshot.js";
import { toMcpTool } from "./tool-mapping.js";
import { getInstalledVersion } from "./installed-version.js";

const MAX_RETRIES = 4;
const EXP_BACKOFF_BASE = 250;
const FETCH_TIMEOUT_MS = 30_000;

export async function fetchWithReconnect(
  getUrl: () => string,
  reconnect: () => Promise<void>,
  config?: {
    init?: RequestInit;
    expBackoffBase?: number;
    maxRetries?: number;
    fetchTimeoutMs?: number | null;
  }
): Promise<Response> {
  const {
    expBackoffBase = EXP_BACKOFF_BASE,
    maxRetries = MAX_RETRIES,
    fetchTimeoutMs = FETCH_TIMEOUT_MS,
    init,
  } = config ?? {};

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer =
      fetchTimeoutMs !== null ? setTimeout(() => controller.abort(), fetchTimeoutMs) : undefined;
    try {
      return await fetch(getUrl(), { ...init, signal: controller.signal });
    } catch (err) {
      lastError = err;
      if (attempt === maxRetries) break;
      if (attempt === 0) {
        // First failure: trigger reconnect (spawns new server if dead)
        await reconnect();
      }
      // Exponential backoff: 250ms, 500ms, 1s, 2s (~3.75s total + reconnect time)
      await new Promise((r) => setTimeout(r, expBackoffBase * Math.pow(2, attempt)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

export interface StartMcpServerOptions {
  /**
   * Locations of bundled artifacts in the published package, used when no
   * remote target is configured and this process must spawn tool-server itself.
   */
  paths: ToolsServerPaths;
}

export async function startMcpServer(options: StartMcpServerOptions): Promise<void> {
  // Once per installation. `argent update` runs the OLD binary, so the editor
  // relaunching `argent mcp` is often the first run of the new code. stdout is
  // the JSON-RPC channel — the notice MUST go to stderr.
  if (shouldShowFirstRunNotice()) {
    process.stderr.write(`[argent] ${FIRST_RUN_NOTICE}\n`);
    markFirstRunNoticeShown();
  }

  // isFlagEnabled hits disk, so resolve it once at startup rather than on every
  // tool call. A flag change therefore needs an MCP restart to take effect.
  const autoScreenshotOn = autoScreenshotEnabled();

  let TOOLS_URL: string;
  let AUTH_TOKEN: string;
  // Honor a configured remote target (ARGENT_TOOLS_URL env or ~/.argent/link.json)
  // before auto-spawning; it carries its own token, while the local auto-spawn
  // path mints one.
  const resolved = await getResolvedToolsUrl();
  if (resolved.url) {
    TOOLS_URL = resolved.url;
    AUTH_TOKEN = resolved.token ?? "";
  } else {
    try {
      const handle = await ensureToolsServer(options.paths);
      TOOLS_URL = handle.url;
      AUTH_TOKEN = handle.token;
    } catch (err) {
      process.stderr.write(`[argent] Failed to start tools server: ${err}\n`);
      process.exit(1);
    }
  }

  function authHeader(): Record<string, string> {
    return AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {};
  }

  // Coarse identity of the AI tool driving this MCP server, taken from the MCP
  // handshake clientInfo.name and forwarded to the tool-server, which owns tool
  // telemetry. Unrecognized names collapse to `other`; the raw name is never sent.
  function aiClientHeaders(): Record<string, string> {
    const rawName = server.getClientVersion()?.name?.trim() || undefined;
    const aiClient = canonicalizeAiClient(rawName);
    if (aiClient) return { "X-Argent-AI-Client": aiClient };
    if (rawName) return { "X-Argent-AI-Client": "other" };
    return {};
  }

  let reconnectPromise: Promise<void> | null = null;

  async function reconnect(): Promise<void> {
    if (await isRemoteRouted()) return;
    if (!reconnectPromise) {
      reconnectPromise = ensureToolsServer(options.paths)
        .then((handle) => {
          TOOLS_URL = handle.url;
          AUTH_TOKEN = handle.token;
        })
        .finally(() => {
          reconnectPromise = null;
        });
    }
    return reconnectPromise;
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
    const res = await fetchWithReconnect(() => `${TOOLS_URL}/tools`, reconnect, {
      init: { headers: authHeader() },
    });
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

    // File boundary, outbound: wrap declared file-path args so the tool-server
    // can read them in place (co-located) or from inlined content (remote).
    // An older server that declares no fileInputs gets the args verbatim.
    let finalArgs = args;
    if (meta?.fileInputs?.length) {
      finalArgs = await prepareFileInputs(meta.fileInputs, args ?? {}, {
        // An external target may not share this process's filesystem, so the
        // file bytes have to ride along.
        includeContent: resolved.url !== null,
      });
    }

    const res = await fetchWithReconnect(() => `${TOOLS_URL}/tools/${name}`, reconnect, {
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader(), ...aiClientHeaders() },
        body: JSON.stringify(finalArgs ?? {}),
      },
      fetchTimeoutMs: meta?.longRunning ? null : FETCH_TIMEOUT_MS,
    });

    const json = (await res.json()) as ToolAPIResponse;

    if (!res.ok) throw new Error(json.error ?? json.message ?? res.statusText);

    // File boundary, inbound: persist any client-write directives (files that
    // belong in the agent's project, e.g. recorded flow YAMLs) and rewrite
    // them to the written paths.
    const { result: data } = await applyClientFileDirectives(json.data);
    return { result: data, outputHint: meta?.outputHint, note: json.note };
  }

  const server = new Server(
    { name: "argent", version: getInstalledVersion() },
    {
      capabilities: { tools: {} },
      instructions:
        "Argent — iOS Simulator, Android Emulator, and Chromium app control for interacting, testing, profiling and debugging mobile and Chromium applications. " +
        "Always use discovery tools (describe / debugger-component-tree / screenshot) before tapping — never guess coordinates. " +
        "On session end: call stop-all-simulator-servers with devices: [...] naming the devices this session used, and perform any necessary cleanup. " +
        "One tool-server is shared by every agent using this argent install, so an unscoped call tears down their devices too — reserve it for a deliberate machine-wide cleanup. " +
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

      const ctx: ContentContext = {
        toolsUrl: TOOLS_URL,
        authToken: AUTH_TOKEN,
        deviceId: getDeviceIdFromArgs(params.arguments),
      };

      let content: ContentBlock[];
      if (
        params.name === "flow-execute" &&
        result &&
        typeof result === "object" &&
        "flow" in result &&
        "steps" in result
      ) {
        content = await flowRunToMcpContent(result as FlowExecuteResult, ctx);
      } else if (params.name === "screenshot-diff" && isScreenshotDiffResult(result)) {
        content = await screenshotDiffToMcpContent(result, ctx);
      } else {
        content = await toMcpContent(result, outputHint, ctx, params.arguments);
      }

      const udid = getUdidFromArgs(params.arguments);
      if (
        autoScreenshotOn &&
        udid &&
        shouldAutoScreenshot(params.name) &&
        containsSecretPlaceholder(params.arguments)
      ) {
        // The tool-server typed the *resolved* secret; a screenshot of a
        // non-secure-entry field would hand the plaintext back to the model as
        // pixels. Every instruction in the note must be safe to follow AFTER the
        // typing, since this branch only fires on a call that already typed it:
        // hence it forbids re-sending the typing step (a rebuilt `run-sequence`
        // would type the secret a second time on top of the first) and states
        // that only this call is skipped, the decision being per call's args.
        content = [
          ...content,
          {
            type: "text" as const,
            text: "Auto-screenshot skipped: the input contains a {{secret:…}} placeholder, and a screenshot of this screen could reveal the typed secret. The secret is already typed — do not send the typing step again, or the field will hold two copies of it. Submit or navigate away, then verify the resulting screen as usual. Only this call is covered: the next call is screenshotted normally, and captures the secret if the field is still on screen. To cover the submit as well, put the typing and the submit in ONE `run-sequence` the next time you type a secret.",
          },
        ];
      } else if (autoScreenshotOn && udid && shouldAutoScreenshot(params.name)) {
        // Let the screen settle before capturing, bounded by the per-tool
        // budget: `await-screen-idle` polls the tree server-side and usually
        // returns well under the cap. If the call fails (e.g. a tool-server
        // without that tool), fall back to sleeping the full budget.
        const maxWaitMs = getAutoScreenshotDelayMs(params.name);
        if (maxWaitMs > 0) {
          try {
            const idle = await callTool("await-screen-idle", { udid, timeoutMs: maxWaitMs });
            await spyLog({
              ts: new Date().toISOString(),
              event: "auto_screenshot_readiness",
              name: params.name,
              maxWaitMs,
              ...(idle.result as Record<string, unknown>),
            });
          } catch {
            await new Promise((r) => setTimeout(r, maxWaitMs));
          }
        }

        try {
          const screenshotResult = await callTool("screenshot", { udid });
          const screenshotContent = await toMcpContent(screenshotResult.result, "image", {
            toolsUrl: TOOLS_URL,
            authToken: AUTH_TOKEN,
            deviceId: udid,
          });
          const hasImage = screenshotContent.some((b) => b.type === "image");
          if (hasImage) {
            content = [
              ...content,
              {
                type: "text" as const,
                text: "--- Screen after action ---",
              },
              ...screenshotContent,
            ];
          }
        } catch {
          /* best-effort */
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

  // Restart the tool server if it dies between requests. Auto-spawned servers
  // only: a remote-routed target is the user's responsibility, and a silent
  // local respawn would mask its outage.
  if (!(await isRemoteRouted())) {
    const HEALTH_INTERVAL_MS = 30_000;
    const healthInterval = setInterval(async () => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3_000);
        try {
          const res = await fetch(`${TOOLS_URL}/tools`, {
            signal: controller.signal,
            headers: authHeader(),
          });
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

  if (process.env.ARGENT_TOOL_SERVER_SHUTDOWN_ON_MCP_EXIT === "1") {
    process.stdin.on("close", () => {
      fetch(`${TOOLS_URL}/shutdown`, { method: "POST", headers: authHeader() }).catch(() => {});
      setTimeout(() => process.exit(0), 5_000);
    });
  }
}
