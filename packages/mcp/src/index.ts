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
  autoScreenshotEnabled,
  getUdidFromArgs,
  shouldAutoScreenshot,
  getAutoScreenshotDelayMs,
  normalizeToolName,
} from "./auto-screenshot.js";

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

const LOG_FILE =
  process.env.RADON_MCP_LOG ?? `${homedir()}/.argent/mcp-calls.log`;
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
  const res = await fetch(`${TOOLS_URL}/tools`);
  const json = (await res.json()) as { tools: ToolMeta[] };
  return json.tools;
}

async function callTool(
  name: string,
  args: unknown,
): Promise<{ result: unknown; outputHint?: string }> {
  const tools = await fetchTools();
  const meta = tools.find((t) => t.name === name);
  const res = await fetch(`${TOOLS_URL}/tools/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args ?? {}),
  });
  const json = (await res.json()) as {
    data?: unknown;
    error?: string;
    message?: string;
  };
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
      "Argent — iOS Simulator Control. " +
      "Most tools require a valid license. If any tool returns an error containing " +
      "'No Argent license found', call the activate-sso tool first — it opens a " +
      "browser on the user's machine for sign-in and returns { success: true, plan }. " +
      "If the browser cannot open, it returns { ssoUrl } — show that URL to the user. " +
      "Alternatively, call activate-license-key with the user's license key. " +
      "When your session ends or the user says they are done, call " +
      "stop-all-simulator-servers to clean up running simulators. " +
      "If the user started Metro separately, ask whether they would like you to " +
      "call stop-metro (specify the port if it is not 8081). " +
      "IMPORTANT — React Native apps: When you detect the target app is a React Native app " +
      "(react-native in package.json, metro.config.js present, etc.), resolve the " +
      "react-native-app-workflow skill and use debugger-component-tree " +
      "to find element positions before tapping. " +
      "IMPORTANT — Finding tap targets: Before tapping, use describe (any iOS app) or " +
      "debugger-component-tree (React Native apps) to get exact element coordinates. " +
      "If a tap fails after 2 attempts, stop retrying and use a discovery tool to verify positions. " +
      "IMPORTANT — iOS system popups: Permission dialogs and other OS-level popups can be " +
      "dismissed by pressing Enter via the keyboard tool — this is more reliable than tapping.",
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
    await spyLog({ ts: new Date().toISOString(), event: "tool_result", name: params.name, durationMs: Date.now() - t0, isError: false, result });

    let content = await toMcpContent(result, outputHint);

    const udid = getUdidFromArgs(params.arguments);
    if (
      autoScreenshotEnabled() &&
      udid &&
      shouldAutoScreenshot(params.name)
    ) {
      const delayMs = getAutoScreenshotDelayMs(params.name);
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));

      try {
        const screenshotResult = await callTool("screenshot", { udid });
        const screenshotContent = await toMcpContent(
          screenshotResult.result,
          "image"
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
