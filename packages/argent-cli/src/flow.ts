import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  createToolsClient,
  isArtifactHandle,
  materializeArtifacts,
  type MaterializeContext,
  type ToolsServerPaths,
} from "@argent/tools-client";
import { FlagParseException } from "./flag-parser.js";

export interface FlowCommandOptions {
  paths: ToolsServerPaths;
}

export interface StepReport {
  index: number;
  kind: string;
  status: "pass" | "fail" | "skip" | "error";
  reason?: string;
  /**
   * Legacy: older tool-servers passed a snapshot that adopted a missing
   * baseline and annotated it with this caveat (a missing baseline now fails
   * the step). Rendered for wire compat with a not-yet-updated server.
   */
  warning?: string;
  tool?: string;
  flow?: string;
  message?: string;
  /** Human-readable step target (selector / snapshot name), set by the runner. */
  target?: string;
  /** Baseline key stem (`<name>__<platform>-WxH`) on artifact-bearing snapshot steps. */
  snapshotKey?: string;
  /**
   * Snapshot-step artifacts keyed by role (baseline/current/diff). The wire
   * value is an artifact handle (or a plain path string from a legacy
   * tool-server); by render time each has been rewritten to a string — a
   * durable local copy for the failed snapshots `--output` exports, otherwise
   * the handle's server-side hostPath/filename — or null when a needed
   * download failed.
   */
  artifacts?: Record<string, unknown>;
}

export interface FlowReport {
  flow: string;
  device: string;
  executionPrerequisite?: string;
  ok: boolean;
  passed: number;
  failed: number;
  skipped: number;
  errored: number;
  steps: StepReport[];
}

const STATUS_GLYPH: Record<StepReport["status"], string> = {
  pass: "✓",
  fail: "✗",
  error: "✗",
  skip: "·",
};

function printHelp(): void {
  console.log(`Usage: argent flow <subcommand> [options]

Run a saved flow without an LLM in the loop. Flows live in
\`.argent/flows/<name>.yaml\` under the current working directory. A flow that
begins with a \`launch\` step runs its app from scratch; any other flow (a
fragment) runs against the device's current state — handy while authoring one.

Subcommands:
  run <name>        Run a flow and report pass/fail (exit code reflects result)
  list              List flows in .argent/flows

Options (run):
  --device <id>          Device id to run against (auto-detected when omitted)
  --platform <p>         ios | android | chromium | vega — narrow auto-detection
  --update-baselines     Write/refresh screenshot baselines instead of diffing
  --output <dir>         Also write failed snapshot images (baseline/current/diff)
                         under <dir>/<flow>/ — a stable path for CI artifact upload
  --json                 Print the raw JSON report
  --help, -h             Show this help

Examples:
  argent flow run checkout --platform ios
  argent flow run checkout --device <UDID> --update-baselines
  argent flow run checkout --output flow-artifacts --json
`);
}

export function parseRunArgs(argv: string[]): {
  name?: string;
  device?: string;
  platform?: string;
  output?: string;
  updateBaselines: boolean;
  json: boolean;
} {
  const out = { updateBaselines: false, json: false } as ReturnType<typeof parseRunArgs>;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (!tok.startsWith("-")) {
      // The first bare token is the flow name; later ones stay ignored.
      if (!out.name) out.name = tok;
      continue;
    }
    // Accept `--flag=value` alongside `--flag value`, like the `argent run` /
    // `argent tools` parser (flag-parser.ts) does.
    const eq = tok.startsWith("--") ? tok.indexOf("=") : -1;
    const flag = eq === -1 ? tok : tok.slice(0, eq);
    const inline = eq === -1 ? undefined : tok.slice(eq + 1);
    // A value-taking flag must consume a real value. A missing one (`--flag=`
    // with nothing after the `=`, the flag as the final token, or a next token
    // that is itself a flag) would otherwise be dropped silently and the run
    // would fall back to device auto-detection — running against whatever
    // happens to be booted instead of erroring.
    const takeValue = (name: string): string => {
      if (inline !== undefined) {
        if (inline === "") throw new FlagParseException(`${name} requires a value`);
        return inline;
      }
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("-")) {
        throw new FlagParseException(`${name} requires a value`);
      }
      i += 1;
      return v;
    };
    const noValue = (name: string): void => {
      if (inline !== undefined) throw new FlagParseException(`${name} does not take a value`);
    };
    if (flag === "--update-baselines") {
      noValue("--update-baselines");
      out.updateBaselines = true;
    } else if (flag === "--json") {
      noValue("--json");
      out.json = true;
    } else if (flag === "--device") out.device = takeValue("--device");
    else if (flag === "--platform") out.platform = takeValue("--platform");
    else if (flag === "--output") out.output = takeValue("--output");
    // Any other flag-shaped token is an error — a typo like --platfrom must
    // not silently fall back to device auto-detection. --help/-h never reach
    // this parser: flow() intercepts them before calling parseRunArgs.
    else throw new FlagParseException(`unknown flag ${tok}`);
  }
  return out;
}

/**
 * Render an echo step. Echo is narration, not a pass/fail step — one that RAN
 * prints as a plain `› message` header with no index or glyph. A SKIPPED echo
 * (its `when:` block didn't run, or a hard stop / cancellation reached it) must
 * not print identically to one that ran, so it carries the skip glyph and its
 * reason: one honest line per authored step, still unindexed so it keeps
 * reading as narration rather than a numbered step. Returns undefined when
 * there is no message to show.
 */
export function renderEchoLine(s: StepReport): string | undefined {
  if (!s.message) return undefined;
  if (s.status === "skip") {
    const reason = s.reason ? ` — ${s.reason}` : "";
    return `  ${STATUS_GLYPH.skip} › ${s.message}${reason}`;
  }
  return `  › ${s.message}`;
}

export function renderStepLine(s: StepReport, n: number, topFlow: string): string {
  const where = s.flow && s.flow !== topFlow ? ` [${s.flow}]` : "";
  const what = s.tool ?? s.target;
  const label = what ? `${s.kind} ${what}` : s.kind;
  const reason = s.reason ? ` — ${s.reason}` : "";
  const glyph = s.status === "pass" && s.warning ? "⚠" : STATUS_GLYPH[s.status];
  return `  ${glyph} ${String(n).padStart(2)} ${label}${where}${reason}`;
}

export function renderSummary(report: FlowReport, opts: { withDevice?: boolean } = {}): string {
  const warnings = report.steps.filter((s) => s.warning).length;
  const warningsNote = warnings ? `, ${warnings} warning${warnings === 1 ? "" : "s"}` : "";
  // The live renderer prints its header before the runner has resolved a
  // device, so its summary carries the device instead.
  const where = opts.withDevice ? ` on ${report.device}` : "";
  return `${report.ok ? "PASS" : "FAIL"}${where} — ${report.passed} passed, ${report.failed} failed, ${report.errored} errored, ${report.skipped} skipped${warningsNote}`;
}

/**
 * Artifact paths for the live renderer, which prints step lines before any
 * path exists (paths are materialized only from the final report). Labeled by
 * step number since they no longer sit under their step line.
 */
export function renderArtifactLines(report: FlowReport): string[] {
  const lines: string[] = [];
  let n = 0;
  for (const s of report.steps) {
    if (s.kind === "echo") continue;
    n++;
    if (!s.artifacts || typeof s.artifacts !== "object") continue;
    const entries = Object.entries(s.artifacts).filter(([, v]) => typeof v === "string");
    if (entries.length === 0) continue;
    lines.push(`  ${s.kind} (step ${n}):`);
    for (const [k, v] of entries) lines.push(`       ${k}: ${v}`);
  }
  return lines;
}

/**
 * Names spliced into artifact-export destinations. Mirrors the tool-server's
 * FLOW_NAME_PATTERN, which every legitimate `report.flow` and `snapshotKey`
 * already satisfies (`assertSafeFlowName`'d flow name; `<name>__<platform>-WxH`
 * key). Re-checked here because the destination root is an operator-chosen
 * filesystem path (`--output`) and the values arrive over the wire — a
 * malicious or buggy server must not steer the copy outside that directory.
 */
const SAFE_ARTIFACT_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * Copy each failed snapshot's artifacts into a durable, globbable location —
 * `<outputDir>/<flow>/<key>-<role>.png`, where `<key>` is the snapshot's
 * baseline key (`name__platform-WxH`), so a run that hits several
 * flows/snapshots can't clobber itself. This is the only place the CLI needs
 * artifact bytes, so materialization happens here, scoped to each failed
 * snapshot's artifacts — a co-located tool-server resolves them in place, a
 * remote one downloads just these files. Rewrites each copied role's path in
 * the report so the renderers and `--json` print the durable location instead
 * of a temp path. Failure-only: a clean pass carries no artifacts, and a
 * seeded baseline is already durable under `__baselines__/`. Best-effort per
 * file — a copy error warns on stderr and leaves the source path in place;
 * artifact export must never change a run's verdict. Server-supplied names
 * that fail `SAFE_ARTIFACT_NAME` are skipped the same way — before any
 * materialization, so nothing is downloaded for a step that won't be written.
 */
export async function exportFailureArtifacts(
  report: FlowReport,
  outputDir: string,
  ctx: MaterializeContext
): Promise<void> {
  if (!SAFE_ARTIFACT_NAME.test(report.flow)) {
    console.error(
      `warning: skipping artifact export for unsafe flow name ${JSON.stringify(report.flow)}`
    );
    return;
  }
  for (const s of report.steps) {
    if (s.kind !== "snapshot" || s.status !== "fail" || !s.artifacts) continue;
    // Key first: a legacy tool-server sends plain path strings, and
    // keyFromBaselinePath needs that original baseline path, not a rewrite.
    // The pattern check also hardens the fallback, whose basename can still
    // be ".." for a path ending in "/..".
    const key = s.snapshotKey ?? keyFromBaselinePath(s.artifacts);
    if (!key || !SAFE_ARTIFACT_NAME.test(key)) continue;
    // Materialize only this snapshot's artifacts (local read or remote
    // download) — never the whole report.
    const { result } = await materializeArtifacts(s.artifacts, ctx);
    s.artifacts = result as Record<string, unknown>;
    const dir = path.join(outputDir, report.flow);
    for (const [role, value] of Object.entries(s.artifacts)) {
      if (typeof value !== "string") continue; // null = failed materialization
      const dest = path.join(dir, `${key}-${role}.png`);
      // Same resolved-path check as the server's getFlowPath: even if the
      // pattern above is ever weakened, the copy stays inside --output. Also
      // covers `role`, the third server-supplied piece of the destination.
      const rel = path.relative(outputDir, dest);
      if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
      try {
        await fsp.mkdir(dir, { recursive: true });
        await fsp.copyFile(value, dest);
        s.artifacts[role] = dest;
      } catch (err) {
        console.error(
          `warning: could not write ${dest}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }
}

/**
 * Fallback for a pre-`snapshotKey` tool-server: the baseline artifact is the
 * baseline file itself (or a download named after it), so its basename IS the
 * key.
 */
function keyFromBaselinePath(artifacts: Record<string, unknown>): string | null {
  const baseline = artifacts.baseline;
  if (typeof baseline !== "string") return null;
  return path.basename(baseline).replace(/\.png$/, "");
}

/**
 * Rewrite any artifact handle left in the report to a printable string — the
 * tool-server's hostPath, or the bare filename — with zero fetches. The CLI
 * renders artifact paths as text only (never inline images), so downloading
 * the bytes just to print a path would be pure waste against a remote
 * tool-server — the same economy the MCP renderer applies to baseline/current.
 * The renderers and `--json` expect string values; a raw handle object would
 * fail their `typeof v === "string"` filter and vanish from the output. Runs
 * after the optional `--output` export, which has already replaced the failed
 * snapshots' handles with durable local copies.
 */
export function resolveArtifactDisplayPaths(report: FlowReport): void {
  for (const s of report.steps) {
    if (!s.artifacts || typeof s.artifacts !== "object") continue;
    for (const [role, value] of Object.entries(s.artifacts)) {
      if (isArtifactHandle(value)) s.artifacts[role] = value.hostPath ?? value.filename;
    }
  }
}

/**
 * Flush stdout/stderr, then exit with `code`.
 *
 * `console.log` is synchronous only when stdout is a file or a TTY. On a pipe
 * — every CI capture (`argent flow run … --json | jq`, `$(…)`, `| tee`) —
 * writes are asynchronous, and a bare `process.exit()` right after printing a
 * large report tears the process down with everything beyond the OS pipe
 * buffer (~64KB) still queued inside Node, truncating a big `--json` report
 * mid-string. Stream writes complete in FIFO order, so waiting on a
 * zero-length sentinel write guarantees every previously queued chunk has
 * reached the fd first.
 *
 * This cannot hang: it waits only on the std streams' own write queues (a
 * stalled pipe reader would block `console.log` the same way), never on other
 * open handles (tool-server sockets, timers) — and a destroyed/EPIPE'd stream
 * still invokes its write callback, so the exit always fires.
 */
export function exitAfterFlush(
  code: number,
  streams: NodeJS.WritableStream[] = [process.stdout, process.stderr]
): Promise<never> {
  return Promise.all(
    streams.map((s) => new Promise<void>((resolve) => s.write("", () => resolve())))
  ).then(() => process.exit(code));
}

export function renderReport(report: FlowReport): string {
  const lines: string[] = [];
  lines.push(`Flow "${report.flow}" on ${report.device}`);
  // A fragment runs against the device's current state — remind the operator
  // what it assumes was already set up.
  if (report.executionPrerequisite) {
    lines.push(`  assumes: ${report.executionPrerequisite}`);
  }
  // Number only real steps so echo narration doesn't leave gaps in the sequence.
  let n = 0;
  for (const s of report.steps) {
    // Echo is narration, not a pass/fail step — render it as a header between
    // steps (a skipped one is marked so it can't be mistaken for having run).
    if (s.kind === "echo") {
      const line = renderEchoLine(s);
      if (line) lines.push(line);
      continue;
    }
    n++;
    lines.push(renderStepLine(s, n, report.flow));
    if (s.warning) lines.push(`       ⚠ ${s.warning}`);
    if (s.artifacts && typeof s.artifacts === "object") {
      for (const [k, v] of Object.entries(s.artifacts)) {
        if (typeof v === "string") lines.push(`       ${k}: ${v}`);
      }
    }
  }
  lines.push(`\n${renderSummary(report)}`);
  return lines.join("\n");
}

export async function flow(argv: string[], options: FlowCommandOptions): Promise<void> {
  const [sub, ...rest] = argv;

  if (!sub || sub === "--help" || sub === "-h") {
    printHelp();
    return;
  }

  const { callTool, baseUrl } = createToolsClient({ paths: options.paths });

  if (sub === "list") {
    const dir = path.join(process.cwd(), ".argent", "flows");
    try {
      const entries = await fsp.readdir(dir);
      const names = entries.filter((f) => f.endsWith(".yaml")).map((f) => f.replace(/\.yaml$/, ""));
      if (names.length === 0) console.log("No flows found in .argent/flows");
      else console.log(names.join("\n"));
    } catch {
      console.log("No .argent/flows directory in the current working directory.");
    }
    return;
  }

  if (sub !== "run") {
    console.error(`Unknown flow subcommand "${sub}". Run \`argent flow --help\`.`);
    return exitAfterFlush(2);
  }

  // Checked before parseRunArgs so --help wins even when it trails a
  // value-taking flag (`--device --help` would otherwise throw "requires a
  // value" instead of printing help).
  if (rest.includes("--help") || rest.includes("-h")) {
    printHelp();
    return;
  }

  let args: ReturnType<typeof parseRunArgs>;
  try {
    args = parseRunArgs(rest);
  } catch (err) {
    if (err instanceof FlagParseException) {
      console.error(`Error: ${err.message}\n`);
      printHelp();
      return exitAfterFlush(2);
    }
    throw err;
  }
  if (!args.name) {
    console.error("argent flow run <name> requires a flow name.");
    printHelp();
    return exitAfterFlush(2);
  }
  const flowName = args.name;

  const payload: Record<string, unknown> = {
    name: flowName,
    project_root: process.cwd(),
    // Headless runs never block on the LLM prerequisite handshake.
    prerequisiteAcknowledged: true,
  };
  if (args.device) payload.device = args.device;
  if (args.platform) payload.platform = args.platform;
  if (args.updateBaselines) payload.updateBaselines = true;

  // Live rendering: with a streaming server each step line prints the moment
  // the step completes. A pre-streaming server ignores the request and no
  // events fire, so `liveSteps` doubles as the mode detector — zero means the
  // buffered renderer below owns the whole report.
  let liveSteps = 0;
  let liveIndex = 0;
  const onStepReport = (event: unknown): void => {
    const s = event as StepReport;
    if (liveSteps === 0) console.log(`Flow "${flowName}"`);
    liveSteps++;
    if (s.kind === "echo") {
      const line = renderEchoLine(s);
      if (line) console.log(line);
      return;
    }
    liveIndex++;
    console.log(renderStepLine(s, liveIndex, flowName));
    if (s.warning) console.log(`       ⚠ ${s.warning}`);
  };

  let report: FlowReport;
  try {
    const resp = await callTool(
      "flow-execute",
      payload,
      args.json ? undefined : { onProgress: onStepReport }
    );
    // Deliberately NOT materialized here: the CLI prints artifact paths as
    // text and renders no images (StepReport has no `result` field, so
    // tool-step results are never displayed). Deep-walking the report would
    // download every tool-step screenshot and all three PNGs of each failed
    // snapshot just to show a path. Only the failed-snapshot artifacts that
    // --output copies are fetched, below.
    report = resp.data as FlowReport;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return exitAfterFlush(1);
  }

  if (!report || !("steps" in report)) {
    console.error(`"${flowName}" did not produce a run report.`);
    return exitAfterFlush(2);
  }

  // Durable diff output: copy failed-snapshot images out of the tool-server's
  // cache before any renderer prints paths, so every output mode shows the
  // durable location. The only artifact bytes the CLI ever fetches; baseUrl is
  // resolved lazily so a run without --output makes no extra round-trip.
  if (args.output) {
    const { url, token } = await baseUrl();
    await exportFailureArtifacts(report, path.resolve(args.output), {
      toolsUrl: url,
      authToken: token,
    });
  }
  // Whatever handles remain (all of them without --output; passing snapshots
  // and unexported roles with it) print as server-side paths.
  resolveArtifactDisplayPaths(report);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (liveSteps > 0) {
    // Steps already printed live — emit only what the final report knows:
    // the prerequisite note, materialized artifact paths, and the summary.
    if (report.executionPrerequisite) console.log(`  assumes: ${report.executionPrerequisite}`);
    for (const line of renderArtifactLines(report)) console.log(line);
    console.log(`\n${renderSummary(report, { withDevice: true })}`);
  } else {
    console.log(renderReport(report));
  }

  return exitAfterFlush(report.ok ? 0 : 1);
}
