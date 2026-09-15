import {
  createToolsClient,
  materializeArtifacts,
  getDeviceIdFromArgs,
  resolveOutPath,
  writeOutFile,
  type ToolMeta,
  type ToolsServerPaths,
  type MaterializedImage,
  type OutWriteResult,
} from "@argent/tools-client";
import { init as telemetryInit, shutdown as telemetryShutdown, track } from "@argent/telemetry";
import { FAILURE_CODES, type FailureCode, type FailureKind } from "@argent/registry";
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

export interface RunCommandOptions {
  paths: ToolsServerPaths;
}

interface RunOptions {
  json: boolean;
  outPath: string | null;
  argvForFlags: string[];
}

// Global flags that already do what a tool property of the same name asks — the
// `--out` below writes an image result wherever it is pointed. Listing such a
// property in the per-tool Flags block would print the same flag twice in one
// help screen (e.g. `screenshot`'s `out`).
const GLOBAL_FLAG_NAMES = new Set(["json", "out"]);

function splitOptions(argv: string[]): RunOptions {
  // Consumed here rather than by the schema-driven flag parser, so a tool with its
  // own "json" or "out" property can't capture the bare `--out`/`--json` spellings.
  // Others (`--out-json`, `--args`) still reach the payload, where `outFromPayload`
  // picks the property up.
  let json = false;
  let outPath: string | null = null;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === "--json") {
      json = true;
      continue;
    }
    // Trimmed, and empty refused: an empty `--out=` outranks a payload `out` on
    // precedence and would write neither, and a stray space makes `path.resolve`
    // read the value as relative, burying the PNG under a directory named " ".
    if (tok === "--out") {
      const v = argv[i + 1]?.trim();
      if (!v) throw new FlagParseException("--out requires a path");
      outPath = v;
      i += 1;
      continue;
    }
    if (tok.startsWith("--out=")) {
      const v = tok.slice("--out=".length).trim();
      if (!v) throw new FlagParseException("--out requires a path");
      outPath = v;
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
  console.log(formatSchemaUsage(withoutGlobalFlagProps(schema)));
  console.log("\nGlobal flags:");
  if (!hasOwnArgsField) {
    console.log("  --args <json>          Pass the entire payload as JSON (overrides flags)");
    console.log("  --args -               Read the entire payload as JSON from stdin");
  }
  console.log("  --<field>-json <json>  Pass a single field as JSON (objects/nested arrays)");
  console.log("  --json                 Print the raw JSON result");
  console.log("  --out <path>           For image results, save to <path> instead of fetching URL");
  console.log("  --help, -h             Show this help");
}

/** Drop schema properties a global flag already covers, so the per-tool Flags block
 *  never prints a second row for a flag the Global flags block lists below it. */
function withoutGlobalFlagProps(schema: JsonSchema | undefined): JsonSchema | undefined {
  if (!schema?.properties) return schema;
  const kept = Object.entries(schema.properties).filter(([name]) => !GLOBAL_FLAG_NAMES.has(name));
  if (kept.length === Object.keys(schema.properties).length) return schema;
  return { ...schema, properties: Object.fromEntries(kept) };
}

/** A tool's own `out` property, when it named a path. */
function outFromPayload(payload: Record<string, unknown>): string | null {
  const out = payload.out;
  return typeof out === "string" && out.trim() ? out.trim() : null;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The legacy `{ url }` bytes for an older tool-server that emits no artifact handle. */
async function fetchLegacyImage(result: unknown): Promise<Buffer | null> {
  const url =
    result && typeof result === "object" && typeof (result as { url?: unknown }).url === "string"
      ? (result as { url: string }).url
      : null;
  if (!url) return null;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download image: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // A legacy server's media URL is a plain HTTP endpoint, so a proxy or an error
  // page answers 200 with HTML just as readily as it answers PNG bytes. Writing
  // that to `out` and reporting a `Wrote:` puts a file that is not an image where
  // the caller will hand it to `screenshot-diff` as a baseline. argent-mcp's
  // fetchPngBytes screens the same bytes the same way.
  if (!buf.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error(`${url} answered ${buf.length} bytes that are not a PNG`);
  }
  return buf;
}

/**
 * Write an image result where the caller asked, and say where it landed. Shares
 * {@link resolveOutPath} with argent-mcp's writer so `out` cannot mean two things
 * depending on which client reads it, and reports the absolute path because that
 * is the spelling `screenshot-diff` can be handed. A failure is returned rather
 * than thrown: the capture already succeeded and its own path still has to print.
 */
async function saveImageTo(
  out: string,
  images: MaterializedImage[],
  result: unknown
): Promise<OutWriteResult> {
  const resolved = resolveOutPath(out);
  if ("refusal" in resolved) return { failure: `Could not save to ${out}: ${resolved.refusal}` };
  try {
    const bytes = images[0]?.data ?? (await fetchLegacyImage(result));
    if (!bytes) {
      return {
        failure: `Could not save to ${resolved.path}: no image came back, so there was nothing to write. Any file already at that path is stale - do not diff against it.`,
      };
    }
    return await writeOutFile(out, bytes);
  } catch (err) {
    return {
      failure: `Could not save to ${resolved.path}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
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

  // Checked against the merged payload, so a required field supplied through `--args` or
  // `--<field>-json` counts. Answering here spares a round trip — and, for a tool that takes
  // file inputs, spares uploading those files only to be told a flag was missing.
  const missing = findMissingRequired(payload, schema);
  if (missing.length > 0) {
    await failValidation({ missing, invalid: [], rawIssues: null }, "cli_run_required_flags");
  }

  let result: unknown;
  let note: string | undefined;
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

  // `--out` wins; without it a tool's own `out` property names the destination, so
  // the spellings that reach the payload (`--args`, `--out-json`) do what the
  // schema advertises rather than passing a path nothing on this side reads.
  const imageOut = outPath ?? outFromPayload(payload);

  const saved =
    imageOut && meta.outputHint === "image" ? await saveImageTo(imageOut, images, result) : null;

  if (note) console.error(note);

  if (saved && "failure" in saved) {
    // Nothing on stdout, matching failInvocation: `--json | jq` on a failed run
    // reads an empty stream and a non-zero status. The capture still succeeded,
    // so the result goes to stderr instead - it is the only thing naming the PNG
    // the run did leave on disk.
    if (json) {
      console.error(JSON.stringify({ error: saved.failure, result }, null, 2));
    } else {
      console.log(renderResult(result, meta.outputHint, images, json));
      console.error(saved.failure);
    }
    await trackRunFailure(toolName, startedAt, {
      error_code: FAILURE_CODES.CLI_RUN_SAVE_IMAGE_FAILED,
      failure_stage: "cli_run_save_image",
      failure_area: "cli",
      error_kind: "unknown",
    });
    process.exit(1);
  }

  console.log(renderResult(result, meta.outputHint, images, json));

  // The absolute destination, which `out`'s own describe tells the caller to
  // pass on to `screenshot-diff` rather than the relative spelling they typed.
  // On stderr under `--json` so stdout stays one parseable object.
  if (saved) {
    (json ? console.error : console.log)(`Wrote: ${saved.wrote}`);
  }
}
