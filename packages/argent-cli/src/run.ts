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
import {
  FAILURE_CODES,
  canonicalToolId,
  type FailureCode,
  type FailureKind,
} from "@argent/registry";
import {
  parseFlags,
  formatSchemaUsage,
  FlagParseException,
  type JsonSchema,
} from "./flag-parser.js";
import {
  findMissingRequired,
  describeServerValidationFailure,
  formatValidationError,
  missingFlagNames,
  type ValidationReport,
} from "./run-validation.js";
import { exitAfterFlush } from "./e2e.js";

export interface RunCommandOptions {
  paths: ToolsServerPaths;
}

interface RunOptions {
  json: boolean;
  outPath: string | null;
  argvForFlags: string[];
}

function outFlagPath(value: string | undefined): string {
  const out = value?.trim();
  if (!out) throw new FlagParseException("--out requires a path");
  return out;
}

function splitOptions(argv: string[]): RunOptions {
  // Consumed here rather than by the schema-driven flag parser, so a tool with its
  // own "json" or "out" property can't capture them.
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
      outPath = outFlagPath(argv[i + 1]);
      i += 1;
      continue;
    }
    if (tok.startsWith("--out=")) {
      outPath = outFlagPath(tok.slice("--out=".length));
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
  const schema = meta.inputSchema as JsonSchema | undefined;
  // A tool with its own `args` field (e.g. flow-add-step) shows `--args` as a per-field
  // flag in the schema block, so the whole-payload escape hatch no longer applies.
  const hasOwnArgsField = schema?.properties?.args !== undefined;
  console.log(`argent run ${meta.name} [flags]`);
  if (description) console.log(`\n${description}\n`);
  console.log("Flags:");
  console.log(formatSchemaUsage(withoutGlobalFlags(schema)));
  console.log("\nGlobal flags:");
  if (!hasOwnArgsField) {
    console.log("  --args <json>          Pass the entire payload as JSON (overrides flags)");
    console.log("  --args -               Read the entire payload as JSON from stdin");
  }
  console.log("  --<field>-json <json>  Pass a single field as JSON (objects/nested arrays)");
  console.log("  --json                 Print the raw JSON result");
  console.log(
    "  --out <path>           For image results, save to <path>; outranks a payload `out`"
  );
  console.log("  --help, -h             Show this help");
}

function withoutGlobalFlags(schema: JsonSchema | undefined): JsonSchema | undefined {
  if (!schema?.properties) return schema;
  const { out: _out, ...properties } = schema.properties;
  return { ...schema, properties };
}

async function fetchImageToFile(
  result: { url?: string; path?: string } | null,
  outPath: string
): Promise<void> {
  const url = result?.url;
  if (!url) {
    throw new Error("Tool result did not include a `url`; cannot save image");
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download image: ${res.status} ${res.statusText}`);
  writeImageFile(outPath, Buffer.from(await res.arrayBuffer()));
}

function writeImageFile(file: string, data: Buffer): void {
  // Not normalized: path.resolve treats `..` and a trailing separator unlike the kernel.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A FIFO would block the write and a device would take the bytes.
  if (fs.statSync(file, { throwIfNoEntry: false })?.isFile() === false) {
    throw new Error(`${file} is not a regular file`);
  }
  fs.writeFileSync(file, data);
}

function renderResult(
  result: unknown,
  outputHint: string | undefined,
  images: MaterializedImage[],
  json: boolean
): string {
  if (json) return JSON.stringify(result, null, 2);

  if (outputHint === "image") {
    // Artifact handle, already resolved to a local file by the materializer.
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
  // Record the canonical id, as tool:fail does, so a call by a former id
  // (flow-execute) counts under the tool it reached.
  const tool = toolName ? canonicalToolId(toolName) : toolName;
  track("cli:run_fail", {
    tool: safeToolName(tool),
    ...(tool !== toolName ? { alias_used: true } : {}),
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

Exits 1 when the tool fails. Also exits 1 when the result reports that the
call did not do its job: an e2e test that does not pass, an await-ui-element
wait with success=false, a run-sequence that a step stopped, a debugger tool
with no connection or an error, a native-devtools precheck that stopped the
tool, a native-profiler-analyze with status analysis_failed, an e2e recording
call that recorded nothing, or a baseline that was not written on this client.
Other results exit 0, also a negative answer such as await-screen-idle's
settled=false or debugger-status's not_connected.
`);
    return;
  }

  // Parsed before the tool is known, so a bad option here can only point at the tool's own help
  // rather than print it. Guarded so an unhandled throw doesn't surface as a raw stack.
  let cliOptions: RunOptions;
  try {
    cliOptions = splitOptions(rest);
  } catch (err) {
    if (err instanceof FlagParseException) {
      console.error(`Error: ${err.message}\n`);
      console.error(`Run \`argent run ${toolName} --help\` to see this tool's flags.`);
      await trackRunFailure(toolName, startedAt, {
        error_code: FAILURE_CODES.CLI_RUN_FLAG_PARSE_FAILED,
        failure_stage: "cli_run_split_options",
        failure_area: "cli",
        error_kind: "validation",
      });
      process.exit(2);
    }
    throw err;
  }
  const { json, outPath, argvForFlags } = cliOptions;

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

  const schema = meta.inputSchema as JsonSchema | undefined;

  // The one place a rejected invocation is reported, so the three ways one can be refused
  // (unparseable flags, locally detected, server-reported) cannot drift apart in wording, output
  // channel or exit code.
  const failInvocation = async (
    summary: string,
    report: ValidationReport | null,
    failure: { error_code: FailureCode; failure_stage: string }
  ): Promise<never> => {
    if (json) {
      // One object on stderr and nothing on stdout, so `--json | jq` on a failed run reads an
      // empty stream and a non-zero status.
      // The keys stay present when flags never parsed and carry no report, so one reader
      // handles every rejected invocation.
      console.error(
        JSON.stringify(
          {
            error: summary,
            missing: report ? missingFlagNames(report, schema) : [],
            issues: report?.rawIssues ?? [],
          },
          null,
          2
        )
      );
    } else {
      console.error(`Error: ${summary}\n`);
      printToolHelp(meta);
    }
    await trackRunFailure(toolName, startedAt, {
      ...failure,
      failure_area: "cli",
      error_kind: "validation",
    });
    process.exit(2);
  };

  const failValidation = (report: ValidationReport, stage: string): Promise<never> =>
    failInvocation(formatValidationError(report, schema), report, {
      error_code: FAILURE_CODES.CLI_RUN_INPUT_VALIDATION_FAILED,
      failure_stage: stage,
    });

  let parsed;
  try {
    parsed = parseFlags(argvForFlags, schema);
  } catch (err) {
    if (err instanceof FlagParseException) {
      await failInvocation(err.message, null, {
        error_code: FAILURE_CODES.CLI_RUN_FLAG_PARSE_FAILED,
        failure_stage: "cli_run_parse_flags",
      });
    }
    throw err;
  }

  if (parsed.helpRequested) {
    printToolHelp(meta);
    return;
  }

  // `argent run` takes no positionals, so anything left here was typed and dropped —
  // e.g. `--flag yes`, since a boolean consumes only `true`/`false`/`1`/`0`. Dropping it
  // silently is the failure this warning exists to stop (#586). stderr keeps `--json`
  // output parseable.
  if (parsed.positional.length > 0) {
    console.error(
      `Note: ignoring unused argument(s): ${parsed.positional.join(", ")}. ` +
        `Pass values as --flag <value> or --flag=<value>.`
    );
  }

  // Precedence: --args JSON first, per-flag values merged on top, so
  // `--args '{...}' --x 0.5` overrides a single field.
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

  // `--out` wins, so the server must not refuse the payload's `out`.
  if (outPath && meta.outputHint === "image") delete payload.out;

  // Checked against the merged payload, so a required field supplied through `--args` or
  // `--<field>-json` counts. Answering here spares a round trip — and, for a tool that takes
  // file inputs, spares uploading those files only to be told a flag was missing.
  const missing = findMissingRequired(payload, schema);
  if (missing.length > 0) {
    await failValidation({ missing, invalid: [], rawIssues: null }, "cli_run_required_flags");
  }

  // Not left to the tool-server: its message would name the global `--out`, and it accepts
  // Windows-absolute paths, which are cwd-relative on POSIX.
  const payloadOut = typeof payload.out === "string" ? payload.out.trim() : null;
  if (meta.outputHint === "image" && payloadOut !== null && !path.isAbsolute(payloadOut)) {
    await failInvocation(
      "`out` must be an absolute path on this computer; `--out <path>` also takes a relative one",
      null,
      {
        error_code: FAILURE_CODES.CLI_RUN_INPUT_VALIDATION_FAILED,
        failure_stage: "cli_run_payload_out",
      }
    );
  }

  let result: unknown;
  let note: string | undefined;
  let failure: string | undefined;
  let images: MaterializedImage[] = [];
  try {
    const resp = await callTool(toolName, payload);
    // Resolve artifact handles to local files (the file already on disk when the
    // tool-server is co-located, downloaded otherwise), so rendering is
    // location-agnostic.
    const { url, token } = await baseUrl();
    const materialized = await materializeArtifacts(resp.data, {
      toolsUrl: url,
      authToken: token,
      deviceId: getDeviceIdFromArgs(payload),
    });
    result = materialized.result;
    images = materialized.images;
    note = resp.note;
    failure = resp.failure;
  } catch (err) {
    // The tool rejected the input rather than failing to run it — report it like any other bad
    // invocation.
    const report = describeServerValidationFailure(err, payload, schema);
    if (report) {
      await failValidation(report, "cli_run_server_validation");
    }
    console.error(err instanceof Error ? err.message : String(err));
    await trackRunFailure(toolName, startedAt, {
      error_code: FAILURE_CODES.CLI_RUN_TOOL_CALL_FAILED,
      failure_stage: "cli_run_call_tool",
      failure_area: "cli",
      error_kind: "unknown",
    });
    process.exit(1);
  }

  // Prefer the bytes the materializer already resolved; fall back to fetching the
  // legacy `{ url }` for older tool-servers that don't emit artifact handles.
  const imageOut = outPath ?? payloadOut;
  if (imageOut && meta.outputHint === "image") {
    try {
      if (images.length > 0) {
        writeImageFile(imageOut, images[0]!.data);
      } else {
        await fetchImageToFile(result as { url?: string; path?: string } | null, imageOut);
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

  if (imageOut && meta.outputHint === "image" && !json) {
    console.log(`Wrote: ${imageOut}`);
  }

  if (failure) {
    // Drain stdout first, or a merged log splices the reason into a large report.
    await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
    console.error(failure);
    await trackRunFailure(toolName, startedAt, {
      error_code: FAILURE_CODES.CLI_RUN_TOOL_RESULT_FAILED,
      failure_stage: "cli_run_tool_result",
      failure_area: "cli",
      error_kind: "unknown",
    });
    // Not stdout: a write after EPIPE throws.
    await exitAfterFlush(1, [process.stderr]);
  }
}
