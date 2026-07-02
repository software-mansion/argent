import * as fs from "node:fs";
import * as path from "node:path";
import {
  createToolsClient,
  materializeArtifacts,
  getDeviceIdFromArgs,
  type ToolMeta,
  type ToolsServerPaths,
  type MaterializedImage,
} from "@argent/tools-client";
import { init as telemetryInit, shutdown as telemetryShutdown, track } from "@argent/telemetry";
import { FAILURE_CODES, type FailureCode, type FailureKind } from "@argent/registry";
import {
  parseFlags,
  formatSchemaUsage,
  FlagParseException,
  type JsonSchema,
} from "./flag-parser.js";

export interface RunCommandOptions {
  paths: ToolsServerPaths;
}

interface RunOptions {
  json: boolean;
  outPath: string | null;
  argvForFlags: string[];
}

function splitOptions(argv: string[]): RunOptions {
  // Pull out CLI-only options (--json, --out) before passing the rest to the
  // schema-driven flag parser. We do this here so they don't get mistaken for
  // tool fields when a tool happens to have a "json" or "out" property.
  let json = false;
  let outPath: string | null = null;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === "--json") {
      json = true;
      continue;
    }
    if (tok === "--out") {
      const v = argv[i + 1];
      if (!v) throw new FlagParseException("--out requires a path");
      outPath = v;
      i += 1;
      continue;
    }
    if (tok.startsWith("--out=")) {
      outPath = tok.slice("--out=".length);
      continue;
    }
    rest.push(tok);
  }

  return { json, outPath, argvForFlags: rest };
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function printToolHelp(meta: ToolMeta): void {
  const description = meta.description?.trim() ?? "";
  console.log(`argent run ${meta.name} [flags]`);
  if (description) console.log(`\n${description}\n`);
  console.log("Flags:");
  console.log(formatSchemaUsage(meta.inputSchema as JsonSchema));
  console.log("\nGlobal flags:");
  console.log("  --args <json>          Pass the entire payload as JSON (overrides flags)");
  console.log("  --args -               Read the entire payload as JSON from stdin");
  console.log("  --<field>-json <json>  Pass a single field as JSON (objects/nested arrays)");
  console.log("  --json                 Print the raw JSON result");
  console.log("  --out <path>           For image results, save to <path> instead of fetching URL");
  console.log("  --help, -h             Show this help");
}

async function fetchImageToFile(
  result: { url?: string; path?: string },
  outPath: string
): Promise<void> {
  const url = result.url;
  if (!url) {
    throw new Error("Tool result did not include a `url`; cannot save image");
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download image: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, buf);
}

function renderResult(
  result: unknown,
  outputHint: string | undefined,
  images: MaterializedImage[],
  json: boolean
): string {
  if (json) return JSON.stringify(result, null, 2);

  if (outputHint === "image") {
    // New tool-servers return an artifact handle that the materializer has
    // already resolved to a local file.
    if (images.length > 0) return `Saved screenshot: ${images[0]!.localPath}`;
    // Legacy `{ url, path }` shape from older tool-servers.
    if (
      result &&
      typeof result === "object" &&
      "path" in result &&
      typeof (result as { path: unknown }).path === "string"
    ) {
      return `Saved screenshot: ${(result as { path: string }).path}`;
    }
  }

  if (typeof result === "string") return result;
  return JSON.stringify(result, null, 2);
}

const SAFE_TOOL_RE = /^[a-z][a-z0-9_-]{0,63}$/;

function safeToolName(toolName: string | undefined): string {
  return toolName && SAFE_TOOL_RE.test(toolName) ? toolName : "unknown";
}

async function trackRunFailure(
  toolName: string | undefined,
  startedAt: number,
  signal: {
    error_code: FailureCode;
    failure_stage: string;
    failure_area: "cli";
    error_kind: FailureKind;
  }
): Promise<void> {
  track("cli:run_fail", {
    tool: safeToolName(toolName),
    duration_ms: performance.now() - startedAt,
    ...signal,
  });
  await telemetryShutdown();
}

export async function run(argv: string[], options: RunCommandOptions): Promise<void> {
  telemetryInit("cli");
  const startedAt = performance.now();
  const { fetchTool, callTool, baseUrl } = createToolsClient({ paths: options.paths });
  const [toolName, ...rest] = argv;

  if (!toolName || toolName === "--help" || toolName === "-h") {
    console.log(`Usage: argent run <tool> [flags]

Invoke a tool exposed by the argent tool-server. Run \`argent tools\` to list
available tools, or \`argent tools describe <name>\` to see one tool's flags.

Examples:
  argent run list-devices
  argent run gesture-tap --udid <UDID> --x 0.5 --y 0.5
  argent run screenshot --udid <UDID> --out ./screen.png
  argent run run-sequence --udid <UDID> --steps-json '[{"tool":"button","args":{"button":"home"}}]'
  argent run gesture-tap --args '{"udid":"<UDID>","x":0.5,"y":0.5}'
`);
    return;
  }

  const { json, outPath, argvForFlags } = splitOptions(rest);

  const meta = await fetchTool(toolName);
  if (!meta) {
    console.error(`Tool "${toolName}" not found. Run \`argent tools\` to list available tools.`);
    await trackRunFailure(toolName, startedAt, {
      error_code: FAILURE_CODES.CLI_RUN_TOOL_NOT_FOUND,
      failure_stage: "cli_run_fetch_tool",
      failure_area: "cli",
      error_kind: "not_found",
    });
    process.exit(1);
  }

  let parsed;
  try {
    parsed = parseFlags(argvForFlags, meta.inputSchema as JsonSchema);
  } catch (err) {
    if (err instanceof FlagParseException) {
      console.error(`Error: ${err.message}\n`);
      printToolHelp(meta);
      await trackRunFailure(toolName, startedAt, {
        error_code: FAILURE_CODES.CLI_RUN_FLAG_PARSE_FAILED,
        failure_stage: "cli_run_parse_flags",
        failure_area: "cli",
        error_kind: "validation",
      });
      process.exit(2);
    }
    throw err;
  }

  if (parsed.helpRequested) {
    printToolHelp(meta);
    return;
  }

  // Build the final args payload. Precedence: --args JSON, then per-flag values
  // merged on top so users can mix `--args '{...}' --x 0.5` to override one
  // field. (Last write wins; flags override --args.)
  let payload: Record<string, unknown> = {};
  if (parsed.rawArgs !== null) {
    let rawJson = parsed.rawArgs;
    if (rawJson === "-") {
      rawJson = await readStdin();
    }
    try {
      const parsedRaw = JSON.parse(rawJson);
      if (parsedRaw === null || typeof parsedRaw !== "object" || Array.isArray(parsedRaw)) {
        console.error("--args must be a JSON object");
        await trackRunFailure(toolName, startedAt, {
          error_code: FAILURE_CODES.CLI_RUN_ARGS_NOT_OBJECT,
          failure_stage: "cli_run_parse_raw_args",
          failure_area: "cli",
          error_kind: "validation",
        });
        process.exit(2);
      }
      payload = parsedRaw as Record<string, unknown>;
    } catch (err) {
      console.error(`--args is not valid JSON: ${err instanceof Error ? err.message : err}`);
      await trackRunFailure(toolName, startedAt, {
        error_code: FAILURE_CODES.CLI_RUN_ARGS_JSON_INVALID,
        failure_stage: "cli_run_parse_raw_args",
        failure_area: "cli",
        error_kind: "validation",
      });
      process.exit(2);
    }
  }
  for (const [k, v] of Object.entries(parsed.args)) {
    payload[k] = v;
  }

  let result: unknown;
  let note: string | undefined;
  let images: MaterializedImage[] = [];
  try {
    const resp = await callTool(toolName, payload);
    // Resolve any artifact handles to local files (using the file already on
    // disk when the tool-server is co-located, downloading otherwise). After
    // this the result holds real local paths, so rendering is location-agnostic.
    const { url, token } = await baseUrl();
    const materialized = await materializeArtifacts(resp.data, {
      toolsUrl: url,
      authToken: token,
      deviceId: getDeviceIdFromArgs(payload),
    });
    result = materialized.result;
    images = materialized.images;
    note = resp.note;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    await trackRunFailure(toolName, startedAt, {
      error_code: FAILURE_CODES.CLI_RUN_TOOL_CALL_FAILED,
      failure_stage: "cli_run_call_tool",
      failure_area: "cli",
      error_kind: "unknown",
    });
    process.exit(1);
  }

  // Image side-effect: save before rendering so --out works in non-JSON mode
  // and --json mode still prints the structured result. Prefer the bytes the
  // materializer already resolved; fall back to the legacy `{ url }` fetch for
  // older tool-servers that don't emit artifact handles.
  if (outPath && meta.outputHint === "image") {
    try {
      if (images.length > 0) {
        fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
        fs.writeFileSync(outPath, images[0]!.data);
      } else if (result && typeof result === "object") {
        await fetchImageToFile(result as { url?: string; path?: string }, outPath);
      }
    } catch (err) {
      console.error(`Failed to save image: ${err instanceof Error ? err.message : err}`);
      await trackRunFailure(toolName, startedAt, {
        error_code: FAILURE_CODES.CLI_RUN_SAVE_IMAGE_FAILED,
        failure_stage: "cli_run_save_image",
        failure_area: "cli",
        error_kind: "unknown",
      });
      process.exit(1);
    }
  }

  if (note) console.error(note);
  console.log(renderResult(result, meta.outputHint, images, json));

  if (outPath && meta.outputHint === "image" && !json) {
    console.log(`Wrote: ${outPath}`);
  }
}
