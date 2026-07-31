import * as fsp from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { FLOW_NAME_PATTERN } from "@argent/registry";
import {
  createToolsClient,
  getResolvedToolsUrl,
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
  /**
   * Nesting depth: absent/0 at top level, +1 inside each block directive
   * (`when:` guarded steps, `run:` fragment steps). Renderers indent by it; a
   * pre-depth tool-server sends none and the report renders flat, as before.
   */
  depth?: number;
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

/**
 * Display cap on the nesting indent — not a producer bound. The tool-server's
 * run-chain and per-file when-nesting limits accumulate, so legitimate depth
 * can exceed this; such steps keep the maximum indent rather than flattening.
 * Depth also arrives over the wire, so the clamp doubles as a guard: a buggy
 * or malicious server must not drive `repeat()` with a huge (multi-GB string)
 * or negative (throwing) count.
 */
const MAX_RENDER_DEPTH = 20;

/**
 * Indentation for a step's nesting depth, applied to the label so the
 * glyph/number columns stay aligned. Absent depth (a pre-depth tool-server)
 * renders flat.
 */
function stepIndent(depth: number | undefined): string {
  if (typeof depth !== "number" || !Number.isInteger(depth) || depth <= 0) return "";
  return "  ".repeat(Math.min(depth, MAX_RENDER_DEPTH));
}

function printHelp(): void {
  console.log(`Usage: argent flow <subcommand> [options]

Run a YAML flow file without an LLM in the loop. Paths are resolved from the
current working directory and may point anywhere on the local filesystem, but
must not contain ".." segments (pass the resolved path instead); the
filename (minus .yaml) names the run's report and artifacts, so it must
contain only letters, numbers, "_", or "-". A flow that begins with a \`launch\`
step runs its app from scratch; any other flow (a fragment) runs against the
device's current state — handy while authoring one.
Runs require the auto-started local tool server;
ARGENT_TOOLS_URL and \`argent link\` routing are not supported.

Subcommands:
  run <flow.yaml>   Run a YAML file and report pass/fail (exit reflects result)
  list              List runnable YAML paths in .argent/flows

Options (run):
  --device <id>          Device id to run against (auto-detected when omitted)
  --platform <p>         ios | android | chromium | vega — narrow auto-detection
  --update-baselines     Write/refresh screenshot baselines instead of diffing
  --output <dir>         Also write failed snapshot images (baseline/current/diff)
                         under <dir>/<flow>/ — a stable path for CI artifact
                         upload. A different flow file with the same filename
                         sharing <dir> exports to <flow>-<pathhash>/ instead
                         (with a warning), so no flow's evidence is overwritten
  --json                 Print the raw JSON report
  --help, -h             Show this help

Examples:
  argent flow run .argent/flows/checkout.yaml --platform ios
  argent flow run ~/shared-flows/checkout.yaml --device <UDID> --update-baselines
  argent flow run /tmp/checkout.yaml --output flow-artifacts --json
`);
}

export function parseRunArgs(argv: string[]): {
  flowPath?: string;
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
      if (out.flowPath) {
        throw new FlagParseException(
          `unexpected argument ${JSON.stringify(tok)}; flow run accepts one YAML file path`
        );
      }
      out.flowPath = tok;
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
      // `argent run` consumes a `true`/`false` word after a boolean flag, so a
      // user who learned that syntax there will try it here. This parser has no
      // per-flag values to give, and staying silent would leave the switch on
      // while `false` was quietly taken as the flow name (the first bare token)
      // — worse than the #586 case it echoes. Say so instead.
      const next = argv[i + 1]?.trim().toLowerCase();
      if (next === "true" || next === "false") {
        throw new FlagParseException(
          `${name} does not take a value — it is a switch; omit it to leave the option off`
        );
      }
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
  const indent = stepIndent(s.depth);
  if (s.status === "skip") {
    const reason = s.reason ? ` — ${s.reason}` : "";
    return `  ${STATUS_GLYPH.skip} ${indent}› ${s.message}${reason}`;
  }
  return `  ${indent}› ${s.message}`;
}

export function renderStepLine(s: StepReport, n: number, topFlow: string): string {
  const where = s.flow && s.flow !== topFlow ? ` [${s.flow}]` : "";
  const what = s.tool ?? s.target;
  const label = what ? `${s.kind} ${what}` : s.kind;
  const reason = s.reason ? ` — ${s.reason}` : "";
  const glyph = s.status === "pass" && s.warning ? "⚠" : STATUS_GLYPH[s.status];
  return `  ${glyph} ${String(n).padStart(2)} ${stepIndent(s.depth)}${label}${where}${reason}`;
}

/**
 * A line printed under a step (warning, artifact path), padded so it sits
 * under the step's label: the width of renderStepLine's `  ✓ NN ` prefix —
 * which grows with the step number past 99 — then the step's depth indent.
 * Shared by the buffered and live renderers so the two can't drift.
 */
export function renderUnderStepLine(s: StepReport, n: number, text: string): string {
  return `${" ".repeat(5 + Math.max(2, String(n).length))}${stepIndent(s.depth)}${text}`;
}

export function renderSummary(report: FlowReport, opts: { withDevice?: boolean } = {}): string {
  const warnings = report.steps.filter((s) => s.warning).length;
  const warningsNote = warnings ? `, ${warnings} warning${warnings === 1 ? "" : "s"}` : "";
  // The live renderer prints its header before the runner has resolved a
  // device, so its summary carries the device instead. Empty when the flow
  // needed none.
  const where = opts.withDevice && report.device ? ` on ${report.device}` : "";
  // Four zeros on a passing run read as though nothing happened. Say why:
  // narration is not counted, so a flow of only narration counts nothing.
  // Only on a pass — on a failure the counts are not what needs explaining.
  const nothingCounted =
    report.ok && report.passed + report.failed + report.errored + report.skipped === 0;
  const note = nothingCounted ? " (no test steps)" : "";
  return `${report.ok ? "PASS" : "FAIL"}${where} — ${report.passed} passed, ${report.failed} failed, ${report.errored} errored, ${report.skipped} skipped${warningsNote}${note}`;
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
 * Names spliced into artifact-export destinations. The shared
 * FLOW_NAME_PATTERN, which every legitimate flow filename stem and
 * `snapshotKey` (`<name>__<platform>-WxH`) already satisfies. Re-checked here
 * because the destination root is an operator-chosen filesystem path
 * (`--output`): the snapshot key still arrives over the wire — a malicious or
 * buggy server must not steer the copy outside that directory — while the
 * flow stem is derived CLI-side from the resolved YAML path (never from the
 * wire report's `flow` field) and re-validated so the export stays contained
 * even when called outside the CLI's own pre-validated path.
 */
const SAFE_ARTIFACT_NAME = FLOW_NAME_PATTERN;

/** The filename stem becomes the runner's internal flow/report name. */
const SAFE_FLOW_NAME = FLOW_NAME_PATTERN;

/**
 * Charset every POSIX shell passes through unquoted (shlex.quote's set).
 * Anything outside it — a space above all — would be word-split or
 * interpreted if pasted into a terminal.
 */
const SHELL_SAFE_ARG = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Quote a path for splicing into a "Did you mean: argent flow run …" hint.
 * The hint's whole value is being copy-pasteable, so a path a shell would
 * mangle is wrapped in single quotes — the one POSIX quoting form with no
 * further escapes inside (embedded single quotes are spliced as '\''). The
 * common all-safe path stays bare so the hint reads like what the user typed.
 */
function shellQuoteArg(arg: string): string {
  if (SHELL_SAFE_ARG.test(arg)) return arg;
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

/**
 * Marker dropped inside each per-flow export directory, recording the
 * resolved YAML path whose run produced it. Flow paths may live anywhere, so
 * two different files can share a filename stem (`suiteA/checks.yaml`,
 * `suiteB/checks.yaml`) while a CI suite funnels every run into one
 * `--output` dir — the marker is how a later invocation (a separate process
 * with no memory of earlier runs) tells "my own previous run, overwrite in
 * place" apart from "a different flow's evidence, keep out".
 */
const EXPORT_SOURCE_MARKER = ".argent-flow-source";

/**
 * Pick the subdirectory name under `--output` for this flow's artifacts.
 * The filename stem when it is free or already claimed by this same YAML
 * file; otherwise `<stem>-<hash8>` where the hash is of the resolved flow
 * path — a pure function of the path, so the fallback stays deterministic
 * across invocations (CI references survive re-runs) while never colliding
 * with the other file's directory. A stem directory without a readable
 * marker (operator files, or an export from a pre-marker CLI) is treated as
 * foreign: redirecting is the safe direction, silently overwriting is not.
 * Both name forms are single FLOW_NAME_PATTERN-charset segments (validated
 * stem + hex), so containment under outputDir is preserved. Read-only — the
 * marker itself is written only once artifacts actually land.
 */
async function resolveExportDirName(
  outputDir: string,
  flowPath: string,
  stem: string
): Promise<string> {
  let owner: string | null; // null = directory exists but proves no owner
  try {
    owner = (await fsp.readFile(path.join(outputDir, stem, EXPORT_SOURCE_MARKER), "utf8")).trim();
  } catch {
    try {
      await fsp.access(path.join(outputDir, stem));
      owner = null;
    } catch {
      return stem; // no directory yet — claim the documented pretty path
    }
  }
  // Identity is the resolved path string: the CLI resolved it against cwd, so
  // one file always maps to one spelling within a checkout. (Two symlink
  // spellings of one file would split into two directories — a redirect, not
  // a loss.)
  if (owner === flowPath) return stem;
  const dirName = `${stem}-${createHash("sha256").update(flowPath).digest("hex").slice(0, 8)}`;
  console.error(
    `warning: ${path.join(outputDir, stem)} already holds artifacts from ` +
      `${owner ?? "an unknown source"}; writing this flow's artifacts to ` +
      `${path.join(outputDir, dirName)} so neither set is overwritten`
  );
  return dirName;
}

/**
 * Copy each failed snapshot's artifacts into a durable, globbable location —
 * `<outputDir>/<flow>/<key>-<role>.png`, where `<flow>` is the YAML filename
 * stem (derived from the CLI-resolved `flowPath`, never from the wire
 * report) and `<key>` is the snapshot's baseline key (`name__platform-WxH`),
 * so a run that hits several flows/snapshots can't clobber itself. Stems are
 * unique only per directory, not globally, so when a different flow file
 * already owns `<flow>/` (see EXPORT_SOURCE_MARKER) this run lands in the
 * deterministic `<flow>-<pathhash>/` instead — one suite's CI evidence must
 * never silently replace another's, while a re-run of the same file still
 * overwrites in place. This is the only place the CLI needs artifact bytes,
 * so materialization happens here, scoped to each failed snapshot's
 * artifacts — a co-located tool-server resolves them in place, a remote one
 * downloads just these files. Rewrites each copied role's path in the report
 * so the renderers and `--json` print the durable location instead of a temp
 * path. Failure-only: a clean pass carries no artifacts, and a seeded
 * baseline is already durable under `__baselines__/`. Best-effort per file —
 * a copy error warns on stderr and leaves the source path in place; artifact
 * export must never change a run's verdict. Server-supplied names that fail
 * `SAFE_ARTIFACT_NAME` are skipped the same way — before any
 * materialization, so nothing is downloaded for a step that won't be written.
 */
export async function exportFailureArtifacts(
  report: FlowReport,
  outputDir: string,
  flowPath: string,
  ctx: MaterializeContext
): Promise<void> {
  const stem = path.basename(flowPath, ".yaml");
  if (!SAFE_ARTIFACT_NAME.test(stem)) {
    console.error(
      `warning: skipping artifact export for unsafe flow filename ${JSON.stringify(stem)}`
    );
    return;
  }
  // Nothing to export → decide nothing, touch nothing: a clean pass must
  // leave --output exactly as it was (no directory, no marker, no collision
  // warning about a write that will never happen).
  if (!report.steps.some((s) => s.kind === "snapshot" && s.status === "fail" && s.artifacts)) {
    return;
  }
  const dir = path.join(outputDir, await resolveExportDirName(outputDir, flowPath, stem));
  let markerWritten = false;
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
    for (const [role, value] of Object.entries(s.artifacts)) {
      if (typeof value !== "string") continue; // null = failed materialization
      const dest = path.join(dir, `${key}-${role}.png`);
      // Same resolved-path check as the server's getFlowPath: even if the
      // pattern above is ever weakened, the copy stays inside --output. Also
      // covers `role`, the remaining server-supplied piece of the destination.
      const rel = path.relative(outputDir, dest);
      if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
      try {
        await fsp.mkdir(dir, { recursive: true });
        if (!markerWritten) {
          // Claim the directory for this YAML path, once, alongside the first
          // real artifact. Best-effort with no warning: a marker failure must
          // not block the copies, and its absence only makes a later run treat
          // the directory as foreign and redirect away — the safe direction.
          await fsp
            .writeFile(path.join(dir, EXPORT_SOURCE_MARKER), `${flowPath}\n`)
            .catch(() => {});
          markerWritten = true;
        }
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
  lines.push(`Flow "${report.flow}"${report.device ? ` on ${report.device}` : ""}`);
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
    if (s.warning) lines.push(renderUnderStepLine(s, n, `⚠ ${s.warning}`));
    if (s.artifacts && typeof s.artifacts === "object") {
      for (const [k, v] of Object.entries(s.artifacts)) {
        if (typeof v === "string") lines.push(renderUnderStepLine(s, n, `${k}: ${v}`));
      }
    }
  }
  lines.push(`\n${renderSummary(report)}`);
  return lines.join("\n");
}

/**
 * `flow run`'s filesystem acceptance test — stat (following symlinks, as run
 * does) plus a readability probe — so `list` never advertises a path `run`
 * rejects. Any per-entry failure (broken symlink, race, EACCES) just omits it.
 */
async function isRunnableFlowFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) return false;
    await fsp.access(filePath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every runnable flow path under `dir`, relative to it. `flow run` binds its
 * name contract to the filename alone — intermediate directory names are
 * unconstrained — so a YAML at any depth is runnable and a non-recursive
 * listing would hide paths `run` accepts. Two deliberate exclusions:
 *
 * - `__baselines__` directories (at any depth: nested flows keep their
 *   baselines beside themselves) are machine-managed snapshot storage, not a
 *   place flows live. `run` would technically execute a YAML dropped in one,
 *   but advertising the inside of an output directory invites keying
 *   baselines of baselines — the one spot where "list what run accepts"
 *   yields to "list what is a flow".
 * - Symlinked directories are not entered: a link cycle would walk forever
 *   (Node's own recursive readdir refuses to follow them for the same
 *   reason). A symlinked flow FILE is still listed — the runnability probe
 *   stats through it, exactly as `flow run` does.
 *
 * An unreadable subdirectory omits its subtree like any other per-entry
 * failure; only the top-level readdir's error propagates, so a missing
 * `.argent/flows` still gets its own message.
 */
async function collectRunnableFlowPaths(dir: string, relDir = ""): Promise<string[]> {
  const found: string[] = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const rel = relDir ? path.join(relDir, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === "__baselines__") continue;
      found.push(
        ...(await collectRunnableFlowPaths(path.join(dir, entry.name), rel).catch(() => []))
      );
      continue;
    }
    // Same name gates as `run`: exact lowercase .yaml, stem in the safe
    // charset. readdir returns on-disk names, so what passes here is the
    // spelling `run`'s exact-basename check accepts.
    if (!entry.name.endsWith(".yaml")) continue;
    if (!SAFE_FLOW_NAME.test(path.basename(entry.name, ".yaml"))) continue;
    if (await isRunnableFlowFile(path.join(dir, entry.name))) found.push(rel);
  }
  return found;
}

export async function flow(argv: string[], options: FlowCommandOptions): Promise<void> {
  const [sub, ...rest] = argv;

  if (!sub || sub === "--help" || sub === "-h") {
    printHelp();
    return;
  }

  if (sub === "list") {
    const dir = path.join(process.cwd(), ".argent", "flows");
    try {
      // One final sort over full relative paths, not per-directory: the
      // ordering must be a pure function of the set of paths, never of the
      // walk order.
      const paths = (await collectRunnableFlowPaths(dir))
        .sort()
        .map((rel) => path.join(".argent", "flows", rel));
      if (paths.length === 0) console.log("No flows found in .argent/flows");
      else console.log(paths.join("\n"));
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
  if (!args.flowPath) {
    console.error("argent flow run <flow.yaml> requires a YAML file path.");
    printHelp();
    return exitAfterFlush(2);
  }

  const projectRoot = process.cwd();
  const suppliedPath = args.flowPath;
  // path.resolve collapses ".." lexically, without consulting symlinks, so a
  // ".." following a symlinked directory would make the CLI stat and run a
  // different file than the one the kernel opens for this string. Rejected
  // before path.resolve — same predicate as the tool-server's
  // flow_path_dotdot guard, and ordered before the extension/stem arms the
  // way the server orders it, so the dishonest-path cause wins over a
  // basename complaint. The hint names the file the shell would actually
  // open, when one exists: the parent directory is realpath'd (that is where
  // ".." and symlinks interact, resolving against cwd the way the kernel
  // does) but the supplied basename is kept — realpath'ing the final
  // component would rewrite a symlinked flow to its target's name, and the
  // basename is the flow's identity (report name, __baselines__/ key,
  // --output dir), so the hint would quietly rename the run. A basename of
  // ".." or "." names no flow file, so no per-component split is needed —
  // such a path gets the generic recovery.
  if (suppliedPath.split(/[\\/]+/).includes("..")) {
    let recovery = "Pass the fully resolved path to the flow's YAML.";
    const suppliedBase = path.basename(suppliedPath);
    if (suppliedBase !== ".." && suppliedBase !== ".") {
      try {
        const resolved = path.join(await fsp.realpath(path.dirname(suppliedPath)), suppliedBase);
        // The reassembled path must itself be kernel-reachable — a hint
        // naming nothing on disk is worse than the generic line.
        await fsp.stat(resolved);
        recovery = `Did you mean: argent flow run ${shellQuoteArg(resolved)}`;
      } catch {
        // Parent unresolvable, or nothing at the reassembled path — the
        // generic recovery stands.
      }
    }
    console.error(
      `Flow path must not contain ".." segments — they are collapsed without following symlinks, ` +
        `so the path can name a different file than the one your shell opens: ${suppliedPath}\n` +
        recovery
    );
    return exitAfterFlush(2);
  }
  // A trailing separator asserts the path names a directory: the kernel
  // refuses to open "ok.yaml/" as a file (ENOTDIR), yet path.resolve drops
  // the separator lexically, so without this guard the CLI would stat and
  // run a file its own argument does not name — the same dishonest-path
  // class as the ".." guard above, and like it ordered before the
  // extension/stem arms so the dishonesty wins over a shape complaint.
  // Ordered after the ".." guard: when a path carries both flaws, that
  // guard's recovery (a fully resolved path) also cures the trailing
  // separator, while stripping the separator here would leave the ".."
  // standing and demand a second correction. Stripping is always the right
  // hint (unlike realpath, nothing needs to exist on disk). A path that is
  // nothing but separators names the filesystem root honestly, so it falls
  // through to the extension complaint instead of an empty hint.
  const separatorTrimmedPath = suppliedPath.replace(/[\\/]+$/, "");
  if (separatorTrimmedPath !== suppliedPath && separatorTrimmedPath !== "") {
    console.error(
      `Flow path must not end in a path separator — the separator claims a directory, ` +
        `which the kernel would refuse to open as a file, so the CLI would run a file ` +
        `this string does not name: ${suppliedPath}\n` +
        `Did you mean: argent flow run ${shellQuoteArg(separatorTrimmedPath)}`
    );
    return exitAfterFlush(2);
  }
  if (path.extname(suppliedPath) !== ".yaml") {
    const isBareSavedName =
      !suppliedPath.includes("/") &&
      !suppliedPath.includes("\\") &&
      path.extname(suppliedPath) === "" &&
      SAFE_FLOW_NAME.test(suppliedPath);
    if (isBareSavedName) {
      console.error(
        `Expected a YAML file path. Saved-flow name lookup is no longer supported.\n` +
          `Did you mean: argent flow run .argent/flows/${suppliedPath}.yaml`
      );
    } else if (path.basename(suppliedPath).toLowerCase() === ".yaml") {
      // path.extname treats a bare ".yaml" as an extensionless dotfile, so name the missing stem.
      console.error(
        `Flow filename must have a non-empty name containing only letters, numbers, "_", or "-": ${suppliedPath}`
      );
    } else if (path.extname(suppliedPath).toLowerCase() === ".yaml") {
      // On case-insensitive filesystems the path looks valid to the user, so name the real problem.
      console.error(
        `Flow extension must be lowercase .yaml, not ${path.extname(suppliedPath)}: ${suppliedPath}`
      );
    } else {
      console.error(`Flow path must end in .yaml: ${suppliedPath}`);
    }
    return exitAfterFlush(2);
  }

  const flowName = path.basename(suppliedPath, ".yaml");
  if (!SAFE_FLOW_NAME.test(flowName)) {
    console.error(
      `Flow filename must have a non-empty name containing only letters, numbers, "_", or "-": ${suppliedPath}`
    );
    return exitAfterFlush(2);
  }

  const flowPath = path.resolve(projectRoot, suppliedPath);
  try {
    const stat = await fsp.stat(flowPath);
    if (!stat.isFile()) {
      console.error(`Flow path is not a file: ${flowPath}`);
      return exitAfterFlush(2);
    }
    await fsp.access(flowPath, fsConstants.R_OK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const detail = code === "ENOENT" ? "Flow file not found" : "Could not read flow file";
    console.error(`${detail}: ${flowPath}`);
    return exitAfterFlush(2);
  }

  // The stat above matched the basename by the filesystem's rules, which on a
  // case-insensitive filesystem (APFS, NTFS) finds a file really named
  // "Upper.YAML" for "upper.yaml" — every name guard above would then have
  // validated a spelling that exists nowhere on disk, and the flow name that
  // keys the report, __baselines__/, and --output would be one no file
  // carries. Require the supplied basename to appear in the parent directory
  // byte-for-byte. readdir, not realpath: realpath rewrites a symlinked flow
  // to its target's name, and `run` deliberately accepts a symlink under the
  // link's own name. The basename is pure ASCII by this point (stem charset +
  // ".yaml"), so Unicode-normalizing filesystems cannot make the comparison
  // lie. A readdir failure (an execute-only parent directory lets stat
  // through while refusing the listing) skips the check rather than refusing
  // a file the exact-named contract may well be honoring.
  const suppliedBase = path.basename(flowPath);
  const siblings = await fsp.readdir(path.dirname(flowPath)).catch(() => null);
  if (siblings !== null && !siblings.includes(suppliedBase)) {
    const actual = siblings.find((name) => name.toLowerCase() === suppliedBase.toLowerCase());
    // Hint the real name only when `run` would accept it (a stem-case slip
    // like Checkout.yaml); an invalid real name (Upper.YAML) needs a rename,
    // and suggesting a command that will itself be refused helps no one.
    const actualRunnable =
      actual !== undefined &&
      path.extname(actual) === ".yaml" &&
      SAFE_FLOW_NAME.test(path.basename(actual, ".yaml"));
    const recovery = actualRunnable
      ? `Did you mean: argent flow run ${shellQuoteArg(path.join(path.dirname(suppliedPath), actual!))}`
      : actual !== undefined
        ? `Rename ${actual} to ${suppliedBase} to run it — flow files must be lowercase .yaml.`
        : "Pass the flow file's name exactly as it appears on disk.";
    console.error(
      `Flow path must name the file as it appears on disk — this filesystem matched ` +
        `${JSON.stringify(suppliedBase)} case-insensitively` +
        `${actual !== undefined ? ` to ${JSON.stringify(actual)}` : ""}, so the flow name ` +
        `(which keys the report, __baselines__/, and --output) would be one no file carries: ` +
        `${suppliedPath}\n${recovery}`
    );
    return exitAfterFlush(2);
  }

  // CLI runs rely on the caller and tool-server sharing a filesystem: sibling
  // `run:` files and `__baselines__` are resolved beside this YAML. Keep the
  // flow-execute tool itself remotely callable, but reject CLI routing that
  // cannot guarantee those local filesystem semantics. This deliberately
  // rejects even single-file flows that could run remotely — the CLI cannot
  // tell them apart without parsing the flow.
  const routing = await getResolvedToolsUrl();
  if (routing.source !== "none") {
    // With ARGENT_TOOLS_URL set over an existing link file, unsetting only the
    // env var re-routes through the shadowed link — the same refusal with the
    // other source. Name both steps up front.
    const recovery =
      routing.source === "env"
        ? routing.shadowedLink
          ? "Unset ARGENT_TOOLS_URL and run `argent unlink`, then try again — " +
            `a link to ${routing.shadowedLink.url} is also configured and takes over once the env var is unset.`
          : "Unset ARGENT_TOOLS_URL and try again."
        : "Run `argent unlink` and try again.";
    console.error(
      `argent flow run requires the auto-started local tool server; ${routing.source} routing is configured.\n${recovery}`
    );
    return exitAfterFlush(2);
  }

  const { callTool, baseUrl } = createToolsClient({ paths: options.paths });

  const payload: Record<string, unknown> = {
    flow_path: flowPath,
    project_root: projectRoot,
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
    if (s.warning) console.log(renderUnderStepLine(s, liveIndex, `⚠ ${s.warning}`));
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
    await exportFailureArtifacts(report, path.resolve(args.output), flowPath, {
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
