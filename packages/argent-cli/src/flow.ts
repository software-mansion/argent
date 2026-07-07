import * as path from "node:path";
import {
  createToolsClient,
  materializeArtifacts,
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
  /**
   * Snapshot-step artifacts keyed by role (baseline/current/diff). The wire
   * value is an artifact handle; materializeArtifacts has already rewritten
   * each to a local path string (or null when unfetchable) by render time.
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
  --json                 Print the raw JSON report
  --help, -h             Show this help

Examples:
  argent flow run checkout --platform ios
  argent flow run checkout --device <UDID> --update-baselines
`);
}

export function parseRunArgs(argv: string[]): {
  name?: string;
  device?: string;
  platform?: string;
  updateBaselines: boolean;
  json: boolean;
} {
  const out = { updateBaselines: false, json: false } as ReturnType<typeof parseRunArgs>;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    // A value-taking flag must consume a real value. A missing one (the flag is
    // the final token, or the next token is itself a flag) would otherwise be
    // dropped silently and the run would fall back to device auto-detection —
    // running against whatever happens to be booted instead of erroring.
    const takeValue = (name: string): string => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("-")) {
        throw new FlagParseException(`${name} requires a value`);
      }
      i += 1;
      return v;
    };
    if (tok === "--update-baselines") out.updateBaselines = true;
    else if (tok === "--json") out.json = true;
    else if (tok === "--device") out.device = takeValue("--device");
    else if (tok === "--platform") out.platform = takeValue("--platform");
    else if (!tok.startsWith("-") && !out.name) out.name = tok;
  }
  return out;
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
    // Echo is narration, not a pass/fail step — render its message as a plain
    // line with no index or status glyph so it reads as a header between steps.
    if (s.kind === "echo") {
      if (s.message) lines.push(`  › ${s.message}`);
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
    const fs = await import("node:fs/promises");
    const dir = path.join(process.cwd(), ".argent", "flows");
    try {
      const entries = await fs.readdir(dir);
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
    process.exit(2);
  }

  let args: ReturnType<typeof parseRunArgs>;
  try {
    args = parseRunArgs(rest);
  } catch (err) {
    if (err instanceof FlagParseException) {
      console.error(`Error: ${err.message}\n`);
      printHelp();
      process.exit(2);
    }
    throw err;
  }
  if (!args.name) {
    console.error("argent flow run <name> requires a flow name.");
    printHelp();
    process.exit(2);
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
      if (s.message) console.log(`  › ${s.message}`);
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
    const { url, token } = await baseUrl();
    const materialized = await materializeArtifacts(resp.data, { toolsUrl: url, authToken: token });
    report = materialized.result as FlowReport;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (!report || !("steps" in report)) {
    console.error(`"${flowName}" did not produce a run report.`);
    process.exit(2);
  }

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

  process.exit(report.ok ? 0 : 1);
}
