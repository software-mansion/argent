import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Server } from "@modelcontextprotocol/sdk/server";
import {
  canonicalToolId,
  ensureToolsServer,
  getResolvedToolsUrl,
  getDeviceIdFromArgs,
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
  autoDescribeEnabled,
  shouldAutoDescribe,
  AUTO_DESCRIBE_HEADER,
  CAPTURE_TIMEOUT_MS,
  PROFILING_CAPTURE_SKIPPED_NOTE,
} from "./auto-capture.js";
import { toMcpToolList } from "./tool-mapping.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { getInstalledVersion } from "./installed-version.js";
import { createToolCaller } from "./tool-caller.js";

export { fetchWithReconnect } from "./tool-caller.js";

export interface StartMcpServerOptions {
  /**
   * Locations of bundled artifacts in the published package, used when no
   * remote target is configured and this process must spawn tool-server itself.
   */
  paths: ToolsServerPaths;
  /** The editor connection. Defaults to stdio; a test passes an in-memory one. */
  transport?: Transport;
  /** Cap of the post-action capture. Defaults to CAPTURE_TIMEOUT_MS; a test passes a short one. */
  captureTimeoutMs?: number;
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
  const autoDescribeOn = autoDescribeEnabled();
  const captureTimeoutMs = options.captureTimeoutMs ?? CAPTURE_TIMEOUT_MS;

  let TOOLS_URL: string;
  let AUTH_TOKEN: string;
  // Honor a configured remote target (ARGENT_TOOLS_URL env or ~/.argent/link.json)
  // before auto-spawning; it carries its own token, while the local auto-spawn
  // path mints one.
  const resolved = await getResolvedToolsUrl();
  // Frozen with the URL: a remote-routed session never falls back to a local
  // spawn, and a call never uses one tool-server with the file rules of
  // another. `argent link` and `argent unlink` ask for an editor restart.
  const remote = resolved.url !== null;
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
    const aiClient = canonicalizeAiClient(rawName, process.env);
    if (aiClient) return { "X-Argent-AI-Client": aiClient };
    if (rawName) return { "X-Argent-AI-Client": "other" };
    return {};
  }

  let reconnectPromise: Promise<void> | null = null;

  async function reconnect(): Promise<void> {
    if (remote) return;
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

  const { fetchTools, callTool } = createToolCaller({
    getHandle: () => ({ url: TOOLS_URL, token: AUTH_TOKEN }),
    remote,
    reconnect,
    extraHeaders: aiClientHeaders,
  });

  /**
   * Lets the screen settle before capturing, bounded by the per-tool budget:
   * `await-screen-idle` polls the tree server-side and usually returns well
   * under the cap. If the call fails (e.g. a tool-server without that tool),
   * falls back to sleeping out the rest of the budget. Resolves whether it
   * settled.
   */
  async function awaitScreenSettled(udid: string, toolName: string): Promise<boolean> {
    const maxWaitMs = getAutoScreenshotDelayMs(toolName);
    if (maxWaitMs === 0) return true;
    const started = Date.now();
    try {
      const idle = await callTool(
        "await-screen-idle",
        { udid, timeoutMs: maxWaitMs },
        // The tool bounds its poll to maxWaitMs; the rest covers its setup.
        { signal: AbortSignal.timeout(maxWaitMs + captureTimeoutMs) }
      );
      await spyLog({
        ts: new Date().toISOString(),
        event: "auto_screenshot_readiness",
        name: toolName,
        maxWaitMs,
        ...(idle.result as Record<string, unknown>),
      });
      return (idle.result as { settled?: unknown } | null)?.settled === true;
    } catch {
      await new Promise((r) => setTimeout(r, Math.max(0, maxWaitMs - (Date.now() - started))));
      return false;
    }
  }

  async function captureScreenshotBlocks(
    udid: string,
    signal: AbortSignal
  ): Promise<ContentBlock[]> {
    try {
      const { result } = await callTool("screenshot", { udid }, { signal });
      const blocks = await toMcpContent(result, "image", {
        toolsUrl: TOOLS_URL,
        authToken: AUTH_TOKEN,
        deviceId: udid,
      });
      if (!blocks.some((b) => b.type === "image")) return [];
      return [{ type: "text" as const, text: "--- Screen after action ---" }, ...blocks];
    } catch {
      return []; /* best-effort */
    }
  }

  /**
   * The element tree the agent would otherwise have to fetch with a `describe`
   * round-trip before its next tap. Measured on Sonnet over 70 runs: −21%
   * turns, −23% wall time, −17% cost at equal task success (see PR #958). The
   * tree is a few hundred tokens per action.
   */
  async function captureTreeBlocks(
    udid: string,
    toolName: string,
    signal: AbortSignal
  ): Promise<ContentBlock[]> {
    const t1 = Date.now();
    try {
      const d = await callTool("describe", { udid }, { signal });
      const { description: desc, hint } =
        (d.result as { description?: unknown; hint?: unknown } | null) ?? {};
      await spyLog({
        ts: new Date().toISOString(),
        event: "auto_describe",
        name: toolName,
        durationMs: Date.now() - t1,
        chars: typeof desc === "string" ? desc.length : 0,
      });
      if (typeof desc !== "string" || desc.length === 0) return [];
      // The agent reads this tree in place of describe, so it needs describe's warnings too.
      const hintLine = typeof hint === "string" && hint ? `Hint: ${hint}\n` : "";
      return [{ type: "text" as const, text: `${AUTO_DESCRIBE_HEADER}\n${hintLine}${desc}` }];
    } catch (e) {
      await spyLog({
        ts: new Date().toISOString(),
        event: "auto_describe",
        name: toolName,
        durationMs: Date.now() - t1,
        error: String(e instanceof Error ? e.message : e),
      });
      return [];
    }
  }

  const server = new Server(
    { name: "argent", version: getInstalledVersion() },
    {
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS,
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const tools = toMcpToolList(await fetchTools());
      await spyLog({
        ts: new Date().toISOString(),
        event: "list_tools",
        count: tools.length,
      });
      return { tools };
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
      const { result, outputHint, note, profiling } = await callTool(params.name, params.arguments);

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
        canonicalToolId(params.name) === "e2e-execute" &&
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
      const wantScreenshot =
        autoScreenshotOn && shouldAutoScreenshot(params.name, params.arguments);
      const wantTree = autoDescribeOn && shouldAutoDescribe(params.name, params.arguments);
      if (udid && (wantScreenshot || wantTree) && containsSecretPlaceholder(params.arguments)) {
        // The tool-server typed the *resolved* secret; a screenshot of a
        // non-secure-entry field would hand the plaintext back to the model as
        // pixels, and the element tree would hand it back as text. Every
        // instruction in the note must be safe to follow AFTER the typing,
        // since this branch only fires on a call that already typed it: hence
        // it forbids re-sending the typing step (a rebuilt `run-sequence`
        // would type the secret a second time on top of the first) and states
        // that only this call is skipped, the decision being per call's args.
        content = [
          ...content,
          {
            type: "text" as const,
            text: "Auto-screenshot and element tree skipped: the input contains a {{secret:…}} placeholder, and a capture of this screen could reveal the typed secret. The secret is already typed — do not send the typing step again, or the field will hold two copies of it. Submit or navigate away, then verify the resulting screen as usual. Only this call is covered: the next call is captured normally, and shows the secret if the field is still on screen. To cover the submit as well, put the typing and the submit in ONE `run-sequence` the next time you type a secret.",
          },
        ];
      } else if (udid && (wantScreenshot || wantTree) && profiling) {
        // The screenshot and describe load the app a profiler is recording on
        // this device, distorting the profile. The idle wait stays: without it,
        // a `describe` sent right after the action reads the screen from before
        // it. `describe` has already answered with the tree, so it needs no
        // pointer to itself.
        if (params.name !== "describe") {
          await awaitScreenSettled(udid, params.name);
          content = [...content, { type: "text" as const, text: PROFILING_CAPTURE_SKIPPED_NOTE }];
        }
      } else if (udid && (wantScreenshot || wantTree)) {
        const screenSettled = await awaitScreenSettled(udid, params.name);
        const signal = AbortSignal.timeout(captureTimeoutMs);
        const screenshot = wantScreenshot
          ? captureScreenshotBlocks(udid, signal)
          : Promise.resolve([]);
        // An unsettled screen can leave a tree read in flight, which a
        // concurrent describe would reuse (physical iPhone).
        if (!screenSettled) await screenshot;
        const tree = wantTree ? captureTreeBlocks(udid, params.name, signal) : Promise.resolve([]);
        content = [...content, ...(await screenshot), ...(await tree)];
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

  await server.connect(options.transport ?? new StdioServerTransport());

  // Restart the tool server if it dies between requests. Auto-spawned servers
  // only: a remote-routed target is the user's responsibility, and a silent
  // local respawn would mask its outage.
  if (!remote) {
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
