import * as path from "node:path";
import {
  createToolsClient,
  materializeArtifacts,
  type ToolsServerPaths,
} from "@argent/tools-client";

export interface FlowCommandOptions {
  paths: ToolsServerPaths;
}

interface StepReport {
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
  /**
   * Snapshot-step artifacts keyed by role (baseline/current/diff). The wire
   * value is an artifact handle; materializeArtifacts has already rewritten
   * each to a local path string (or null when unfetchable) by render time.
   */
  artifacts?: Record<string, unknown>;
}

interface FlowReport {
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

function parseRunArgs(argv: string[]): {
  name?: string;
  device?: string;
  platform?: string;
  updateBaselines: boolean;
  json: boolean;
} {
  const out = { updateBaselines: false, json: false } as ReturnType<typeof parseRunArgs>;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === "--update-baselines") out.updateBaselines = true;
    else if (tok === "--json") out.json = true;
    else if (tok === "--device") out.device = argv[++i];
    else if (tok === "--platform") out.platform = argv[++i];
    else if (!tok.startsWith("-") && !out.name) out.name = tok;
  }
  return out;
}

function renderReport(report: FlowReport): string {
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
    const where = s.flow && s.flow !== report.flow ? ` [${s.flow}]` : "";
    const label = s.tool ? `${s.kind} ${s.tool}` : s.kind;
    const reason = s.reason ? ` — ${s.reason}` : "";
    const glyph = s.status === "pass" && s.warning ? "⚠" : STATUS_GLYPH[s.status];
    lines.push(`  ${glyph} ${String(n).padStart(2)} ${label}${where}${reason}`);
    if (s.warning) lines.push(`       ⚠ ${s.warning}`);
    if (s.artifacts && typeof s.artifacts === "object") {
      for (const [k, v] of Object.entries(s.artifacts)) {
        if (typeof v === "string") lines.push(`       ${k}: ${v}`);
      }
    }
  }
  const warnings = report.steps.filter((s) => s.warning).length;
  const warningsNote = warnings ? `, ${warnings} warning${warnings === 1 ? "" : "s"}` : "";
  lines.push(
    `\n${report.ok ? "PASS" : "FAIL"} — ${report.passed} passed, ${report.failed} failed, ${report.errored} errored, ${report.skipped} skipped${warningsNote}`
  );
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

  const args = parseRunArgs(rest);
  if (!args.name) {
    console.error("argent flow run <name> requires a flow name.");
    printHelp();
    process.exit(2);
  }

  const payload: Record<string, unknown> = {
    name: args.name,
    project_root: process.cwd(),
    // Headless runs never block on the LLM prerequisite handshake.
    prerequisiteAcknowledged: true,
  };
  if (args.device) payload.device = args.device;
  if (args.platform) payload.platform = args.platform;
  if (args.updateBaselines) payload.updateBaselines = true;

  let report: FlowReport;
  try {
    const resp = await callTool("flow-execute", payload);
    const { url, token } = await baseUrl();
    const materialized = await materializeArtifacts(resp.data, { toolsUrl: url, authToken: token });
    report = materialized.result as FlowReport;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (!report || !("steps" in report)) {
    console.error(`"${args.name}" did not produce a run report.`);
    process.exit(2);
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderReport(report));
  }

  process.exit(report.ok ? 0 : 1);
}
