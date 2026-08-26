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
  ToolInvocationError,
  type MaterializeContext,
  type ToolsClient,
  type ToolsServerPaths,
} from "@argent/tools-client";
import { FlagParseException } from "./flag-parser.js";
import { parseCommandArgs, UsageError, type OptionSpecs } from "./command-args.js";

export interface FlowCommandOptions {
  paths: ToolsServerPaths;
}

export interface StepReport {
  index: number;
  kind: string;
  status: "pass" | "fail" | "skip" | "error";
  reason?: string;
  /** Set by the tool-server on a step that PASSED in a way that weakens it as proof. */
  warning?: string;
  tool?: string;
  flow?: string;
  message?: string;
  /** Human-readable step target (selector / snapshot name). */
  target?: string;
  /**
   * Nesting depth: absent/0 at top level, +1 inside each nesting step (`when:`
   * guarded steps, `run:` fragment steps, `repeat:` iteration markers and body
   * steps). Renderers indent by it.
   */
  depth?: number;
  /**
   * The line marks block structure (a `repeat:` block's opening and iteration
   * markers), not a step that ran — so it prints without consuming a step
   * number, the way echo narration does, and the tool-server leaves it out of
   * the counts this CLI reports.
   */
  structural?: boolean;
  /** Baseline key stem, on artifact-bearing snapshot steps. */
  snapshotKey?: string;
  /**
   * Snapshot-step artifacts keyed by role (baseline/current/diff). Arrives as
   * artifact handles; by render time each is a string — a durable local copy
   * for the failed snapshots `--output` exports, otherwise the handle's
   * server-side hostPath/filename — or null when a download failed.
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
 * Display cap on the nesting indent, not a producer bound: the tool-server's
 * run-chain and block-nesting limits accumulate, so legitimate depth can exceed
 * it and such steps keep the maximum indent. Depth also arrives over the wire,
 * so the clamp doubles as a guard against a server driving `repeat()` with a
 * huge or negative count.
 */
const MAX_RENDER_DEPTH = 20;

/** Indent for a step's depth, applied to the label so the glyph/number columns stay aligned. */
function stepIndent(depth: number | undefined): string {
  if (typeof depth !== "number" || !Number.isInteger(depth) || depth <= 0) return "";
  return "  ".repeat(Math.min(depth, MAX_RENDER_DEPTH));
}

function printHelp(toStderr = false): void {
  const print = toStderr ? console.error : console.log;
  print(`Usage: argent flow <subcommand> [options]

Run a YAML flow without an LLM in the loop. \`run\` takes any of these forms:

  a name   A flow saved under .argent/flows — "checkout" runs
           .argent/flows/checkout.yaml, resolved from the current directory
  a path   Any .yaml file on the local filesystem, resolved from the current
           directory. It must not contain ".." segments (pass the resolved
           path instead); a path is what reaches flows kept elsewhere, and
           what \`argent flow list\` prints for nested ones
  a dir    Every flow in that directory, run sequentially

For a name and for a file path alike, the
filename (minus .yaml) names the run's report and artifacts, so it must
contain only letters, numbers, "_", or "-" — the same charset a name must
match. A flow that begins with a \`launch\` step runs its app from scratch; any
other flow (a fragment) runs against the device's current state — handy while
authoring one. Exception: a fragment whose first step \`run:\`s a chromium e2e
flow boots that flow's app before step 1 — when that launch is unambiguously
chromium (a lone \`{ chromium: ... }\` target, or --platform chromium); a
multi-platform launch auto-detects a device instead. Pass --device to attach to
a running instance.

A directory run prints only failing steps plus a final flow summary;
--recursive walks subdirectories too (dot-directories and node_modules are
skipped). An invalid flow file fails alone and the batch continues; an infra
error stops the batch and counts the remaining flows skipped.

Runs require the auto-started local tool server;
ARGENT_TOOLS_URL and \`argent link\` routing are not supported.

Subcommands:
  run <flow|flow.yaml|dir>   Run a saved flow by name, a YAML file by path, or
                             every flow in a directory, and report pass/fail
                             (exit reflects result)
  list                       List runnable YAML paths in .argent/flows

Options (run):
  --device <id>          Device id to run against (auto-detected when omitted)
  --platform <p>         ios | android | chromium | vega — narrow auto-detection
  --update-baselines     Write/refresh screenshot baselines instead of diffing
  --output <dir>         Also write failed snapshot images (baseline/current/diff)
                         under <dir>/<flow>/ — a stable path for CI artifact
                         upload; a directory run keys nested flows as
                         <dir>/<subdir>/<flow>/. A different flow file with the
                         same filename sharing <dir> exports to <flow>-<pathhash>/
                         instead (with a warning), so no flow's evidence is
                         overwritten
  -r, --recursive        With a directory path, also run flows in subdirectories
  --json                 Print the raw JSON report
  --json-stream          Print progress and the final report as NDJSON (single flow only)
  --help, -h             Show this help
  --                     End of options — only needed for a flow whose name
                         starts with "-" (\`argent flow run -- -nightly\`)

Examples:
  argent flow run checkout --platform ios
  argent flow run .argent/flows/checkout.yaml --output flow-artifacts --json
  argent flow run ~/shared-flows/checkout.yaml --device <UDID> --update-baselines
  argent flow run .argent/flows --recursive
`);
}

// --help/-h never reach this parser: flow() intercepts them first.
const RUN_OPTIONS = {
  "update-baselines": { kind: "boolean" },
  "json": { kind: "boolean" },
  "json-stream": { kind: "boolean" },
  "recursive": { kind: "boolean", alias: "r" },
  "device": { kind: "value" },
  "platform": { kind: "value" },
  "output": { kind: "value" },
} as const satisfies OptionSpecs;

export function parseRunArgs(argv: string[]): {
  /**
   * The positional argument exactly as supplied. Which of name, YAML path, or
   * directory it is, is resolveFlowRef's and the directory stat's call; this
   * parser never inspects it.
   */
  flowRef?: string;
  device?: string;
  platform?: string;
  output?: string;
  updateBaselines: boolean;
  recursive: boolean;
  json: boolean;
  jsonStream: boolean;
} {
  let parsed: ReturnType<typeof parseCommandArgs>;
  try {
    parsed = parseCommandArgs(argv, RUN_OPTIONS);
  } catch (err) {
    // flow's callers classify bad input by this exception; keep that contract.
    if (err instanceof UsageError) throw new FlagParseException(err.message);
    throw err;
  }
  const { positionals, options } = parsed;
  // The parser honors `--` as end of options: the flow-name charset admits a
  // leading "-", so `-dash` is a legal saved-flow name that every argv parser
  // reads as a flag; without the marker such a flow would be addressable by
  // path only.
  if (positionals.length > 1) {
    throw new FlagParseException(
      `unexpected argument ${JSON.stringify(positionals[1])}; flow run accepts one flow name, YAML file path, or directory path`
    );
  }
  const out: ReturnType<typeof parseRunArgs> = {
    updateBaselines: options["update-baselines"] === true,
    recursive: options.recursive === true,
    json: options.json === true,
    jsonStream: options["json-stream"] === true,
  };
  if (positionals[0] !== undefined) out.flowRef = positionals[0];
  if (options.device !== undefined) out.device = options.device as string;
  if (options.platform !== undefined) out.platform = options.platform as string;
  if (options.output !== undefined) out.output = options.output as string;
  if (out.json && out.jsonStream) {
    throw new FlagParseException("--json and --json-stream cannot be combined");
  }
  return out;
}

/**
 * Render an echo step. Echo is narration, not a pass/fail step: one that RAN
 * prints as a plain `› message` with no index or glyph, while a SKIPPED one
 * carries the skip glyph and its reason so it cannot read as having run.
 * Returns undefined when there is no message.
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

/**
 * Whether a line marks block structure rather than a step that ran. Such lines
 * print but take no step number (pass `{ unnumbered }` to renderStepLine),
 * keeping the CLI's sequence in step with the counts the tool-server sends.
 * Untrusted wire data, so only a literal `true` counts.
 */
function isStructural(s: StepReport): boolean {
  return s.structural === true;
}

/**
 * A step line. `n` is the step's number, or `{ unnumbered: count }` for a
 * structural marker, which keeps the glyph, indent and columns but leaves the
 * number blank — the block/iteration shape IS what those lines convey.
 * `count` is how many numbers have been issued, which sizes the blank.
 */
export function renderStepLine(
  s: StepReport,
  n: number | { unnumbered: number },
  topFlow: string
): string {
  const where = s.flow && s.flow !== topFlow ? ` [${s.flow}]` : "";
  const what = s.tool ?? s.target;
  const label = what ? `${s.kind} ${what}` : s.kind;
  const reason = s.reason ? ` — ${s.reason}` : "";
  const glyph = s.status === "pass" && s.warning ? "⚠" : STATUS_GLYPH[s.status];
  // A marker's blank must span the numbers around it or the label column breaks
  // past 99. It leans FORWARD, to the next number to be issued, because the
  // live streamer shares this function and cannot look ahead — so a block over
  // narration alone at the 99/100 seam sits one column right of its body. The
  // floor of 2 mirrors the padStart(2).
  const num =
    typeof n === "number"
      ? String(n).padStart(2)
      : " ".repeat(Math.max(2, String(n.unnumbered + 1).length));
  return `  ${glyph} ${num} ${stepIndent(s.depth)}${label}${where}${reason}`;
}

/**
 * A line printed under a step (warning, artifact path), padded to the width of
 * renderStepLine's `  ✓ NN ` prefix — which grows past step 99 — plus the
 * step's depth indent. Shared by the buffered and live renderers.
 */
export function renderUnderStepLine(s: StepReport, n: number, text: string): string {
  return `${" ".repeat(5 + Math.max(2, String(n).length))}${stepIndent(s.depth)}${text}`;
}

/**
 * Everything that hangs under a step line: its warning, then its artifact
 * paths. Shared by the buffered renderer and batch mode so the two can't
 * disagree about the same report.
 *
 * `n` is the number column the line above printed, so the text sits under the
 * label past step 99. A marker's under-lines are NOT dropped — a dropped one is
 * a warning or artifact path with nowhere else to appear.
 */
function underStepLines(s: StepReport, n: number): string[] {
  const lines: string[] = [];
  if (s.warning) lines.push(renderUnderStepLine(s, n, `⚠ ${s.warning}`));
  if (s.artifacts && typeof s.artifacts === "object") {
    for (const [k, v] of Object.entries(s.artifacts)) {
      if (typeof v === "string") lines.push(renderUnderStepLine(s, n, `${k}: ${v}`));
    }
  }
  return lines;
}

export function renderSummary(report: FlowReport, opts: { withDevice?: boolean } = {}): string {
  const warnings = report.steps.filter((s) => s.warning).length;
  const warningsNote = warnings ? `, ${warnings} warning${warnings === 1 ? "" : "s"}` : "";
  // The live renderer prints its header before the device is resolved, so its
  // summary carries the device instead — the one the run STARTED on: a chromium
  // run can move onto runner-booted instances (each move marked on its launch
  // step's reason), so "on <id>" would blame the wrong instance for steps after
  // a move. Empty when the flow needed no device.
  const where = opts.withDevice && report.device ? ` (started on ${report.device})` : "";
  // Four zeros on a passing run read as though nothing happened: narration is
  // not counted, so a flow of only narration counts nothing. Only on a pass.
  const nothingCounted =
    report.ok && report.passed + report.failed + report.errored + report.skipped === 0;
  const note = nothingCounted ? " (no test steps)" : "";
  return `${report.ok ? "PASS" : "FAIL"}${where} — ${report.passed} passed, ${report.failed} failed, ${report.errored} errored, ${report.skipped} skipped${warningsNote}${note}`;
}

/**
 * Artifact paths for the live renderer, which prints step lines before any
 * path exists (paths are materialized only from the final report). Labeled by
 * step number since they no longer sit under their step line; a structural
 * marker owns no number, so it is labeled as the unnumbered line it is.
 */
export function renderArtifactLines(report: FlowReport): string[] {
  const lines: string[] = [];
  let n = 0;
  for (const s of report.steps) {
    // Numbering must match renderReport's. A marker's paths are still listed:
    // this tail is the only place live mode ever prints one.
    if (s.kind === "echo") continue;
    const structural = isStructural(s);
    if (!structural) n++;
    if (!s.artifacts || typeof s.artifacts !== "object") continue;
    const entries = Object.entries(s.artifacts).filter(([, v]) => typeof v === "string");
    if (entries.length === 0) continue;
    lines.push(`  ${s.kind} (${structural ? "unnumbered marker" : `step ${n}`}):`);
    for (const [k, v] of entries) lines.push(`       ${k}: ${v}`);
  }
  return lines;
}

/**
 * Batch mode prints only what needs attention: each fail/error step with its
 * under-lines, numbered by walking the full step list so the numbers match a
 * single-mode rerun of the same flow.
 *
 * A PASSING step carrying a warning needs attention too: renderSummary counts
 * every warning whatever its status, so skipping those printed "1 warning" with
 * the text nowhere on screen.
 */
export function renderFailedSteps(report: FlowReport): string[] {
  const lines: string[] = [];
  let n = 0;
  for (const s of report.steps) {
    // Same skips as renderReport, or the number printed here disagrees with
    // the single-mode rerun it sends the operator to.
    if (s.kind === "echo") continue;
    // Block structure takes no number, as in renderReport, but is not dropped:
    // these lines are the whole of what batch mode prints, so a server that
    // stamped a fail/error line structural would otherwise produce a FAIL
    // summary with no failure line under it.
    const structural = isStructural(s);
    if (!structural) n++;
    if (s.status !== "fail" && s.status !== "error" && !s.warning) continue;
    lines.push(renderStepLine(s, structural ? { unnumbered: n } : n, report.flow));
    lines.push(...underStepLines(s, structural ? n + 1 : n));
  }
  return lines;
}

/** Flow-level verdict of a directory run, mirroring renderSummary's shape. */
export function renderBatchSummary(counts: {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}): string {
  return `${counts.failed === 0 ? "PASS" : "FAIL"} — ${counts.total} flow${counts.total === 1 ? "" : "s"}: ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped`;
}

/**
 * Names spliced into artifact-export destinations. Re-checked here because the
 * destination root is an operator-chosen filesystem path (`--output`): the
 * snapshot key arrives over the wire, so a buggy or malicious server must not
 * steer the copy outside that directory, while the flow stem is derived
 * CLI-side from the resolved YAML path (never from the wire report's `flow`
 * field) and re-validated so the export stays contained even when called
 * outside the CLI's own pre-validated path.
 */
const SAFE_ARTIFACT_NAME = FLOW_NAME_PATTERN;

/** The filename stem becomes the runner's internal flow/report name. */
const SAFE_FLOW_NAME = FLOW_NAME_PATTERN;

/** Where flows are saved, relative to the current directory. */
const FLOWS_DIR = path.join(".argent", "flows");

/**
 * Charset every POSIX shell passes through unquoted (shlex.quote's set).
 * Anything outside it — a space above all — would be word-split or interpreted
 * if pasted into a terminal.
 */
const SHELL_SAFE_ARG = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Quote a path for splicing into a "Did you mean: argent flow run …" hint,
 * whose whole value is being copy-pasteable. Single quotes are the one POSIX
 * form with no further escapes inside; an all-safe path stays bare so the hint
 * reads like what the user typed.
 */
function shellQuoteArg(arg: string): string {
  if (SHELL_SAFE_ARG.test(arg)) return arg;
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

/**
 * Marker dropped inside each per-flow export directory, recording the resolved
 * YAML path whose run produced it. Two different files can share a filename
 * stem while a CI suite funnels every run into one `--output` dir, so the
 * marker is how a later invocation — a separate process with no memory of
 * earlier runs — tells "my own previous run, overwrite in place" apart from "a
 * different flow's evidence, keep out". Creating this file with O_EXCL is also
 * the act of claiming (see takeExportDir).
 */
const EXPORT_SOURCE_MARKER = ".argent-flow-source";

/**
 * An O_EXCL create publishes the marker's path one syscall before its contents,
 * so a reader inside that window sees an existing but empty file — the only way
 * a freshly written marker reads as empty. Concluding "names nobody" there
 * would send a concurrent run of the *same* flow off to a hash-suffixed sibling
 * for no reason, so an empty read is retried a handful of times before the
 * marker is written off as illegible.
 */
const MARKER_READ_RETRIES = 4;
const MARKER_READ_DELAY_MS = 5;

/**
 * Read a directory's ownership marker: the resolved flow path that claimed it,
 * `undefined` when there is no readable marker file (an absent directory
 * included — the caller tells those apart), or null when the file names nobody.
 */
async function readExportMarker(dir: string): Promise<string | null | undefined> {
  const marker = path.join(dir, EXPORT_SOURCE_MARKER);
  for (let attempt = 0; ; attempt++) {
    let owner: string;
    try {
      owner = (await fsp.readFile(marker, "utf8")).trim();
    } catch {
      return undefined;
    }
    if (owner) return owner;
    if (attempt === MARKER_READ_RETRIES) return null;
    await new Promise((resolve) => setTimeout(resolve, MARKER_READ_DELAY_MS));
  }
}

/**
 * How a candidate export directory related to this flow at the instant it was
 * read: free to claim (absent, or pre-created but empty — `mkdir -p` before the
 * run is an ordinary CI step), already this flow's own (the marker names
 * `flowPath`), or foreign — owned by a different YAML path (`owner` is that
 * path) or holding content that proves no owner (`owner` is null: operator
 * files, an illegible marker, or a directory that cannot even be listed, where
 * emptiness can't be proven). One classifier serves the stem directory and
 * every hash-suffixed fallback alike, so the two can never drift apart in what
 * they refuse to overwrite. "free" is a snapshot, never a reservation: two
 * processes reading at the same instant both get it, so taking the directory is
 * a second, atomic step (takeExportDir) and only its verdict is binding.
 */
type ExportDirClaim =
  | { state: "free" }
  | { state: "mine" }
  | { state: "foreign"; owner: string | null };

async function classifyExportDir(dir: string, flowPath: string): Promise<ExportDirClaim> {
  let owner = await readExportMarker(dir); // null = has content but proves no owner
  if (owner === undefined) {
    try {
      if ((await fsp.readdir(dir)).length === 0) {
        return { state: "free" }; // pre-created but empty — nothing to protect
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { state: "free" };
      }
      // Unlistable (permissions, or a plain file squatting on the name):
      // emptiness can't be proven, so fall through to the foreign path.
    }
    owner = null;
  }
  // Identity is the resolved path string, so two symlink spellings of one file
  // split into two directories — a redirect, not a loss.
  return owner === flowPath ? { state: "mine" } : { state: "foreign", owner };
}

/** The clause explaining why a candidate directory could not be taken. */
function occupiedBy(owner: string | null): string {
  return owner === null
    ? "already holds files from an unknown source"
    : `already holds artifacts from ${owner}`;
}

/**
 * Take `dir` for `flowPath`. Creating the marker with O_EXCL *is* the claim, so
 * however many processes race for one directory, exactly one wins the create.
 * Returns null once the directory is this flow's (it then exists and holds the
 * marker), or the clause explaining why it isn't.
 *
 * Classification alone cannot decide this: between `classifyExportDir` reading
 * "free" and the first artifact landing there sits a window in which another
 * process classifies the same directory "free" too, and both write into it. The
 * loser's bytes end up under the winner's marker, which is worse than a plain
 * overwrite: a later, perfectly ordinary run of the flow the marker names
 * classifies that directory "mine" and overwrites it without a warning,
 * destroying evidence it never produced.
 *
 * EEXIST means the create lost — either to a racing process or to this flow's
 * own marker from an earlier run (the expected `mine` path) — so judge the
 * marker that is actually there now.
 *
 * Any other error (unwritable directory, full or read-only filesystem) leaves
 * the claim unproven, and an unproven claim must never be written into: it is
 * reported like an occupant so the caller steps past to a candidate it can
 * actually take.
 */
async function takeExportDir(dir: string, flowPath: string): Promise<string | null> {
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, EXPORT_SOURCE_MARKER), `${flowPath}\n`, { flag: "wx" });
    return null; // won the create
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      return `could not be claimed (${err instanceof Error ? err.message : String(err)})`;
    }
  }
  // undefined = the marker vanished under us, or `dir` is a plain file (what
  // made mkdir itself EEXIST): unprovable either way, so foreign.
  const owner = await readExportMarker(dir);
  return owner === flowPath ? null : occupiedBy(owner ?? null);
}

/**
 * Claim the subdirectory under `--output` for this flow's artifacts and return
 * its name, or null when nothing can be claimed without destroying someone
 * else's. The filename stem when it is free or already claimed by this same
 * YAML file; otherwise `<stem>-<prefix>`, where the prefix is a growing slice
 * (8, then 16, … up to all 64 hex chars) of the sha256 of the resolved flow
 * path. Every candidate — fallbacks included — passes the same occupancy check
 * (classifyExportDir) and is then taken atomically (takeExportDir): a foreign
 * directory, or one another process wins first, is stepped past to the next
 * longer prefix, never written into. On return the chosen directory exists and
 * holds this flow's marker, so the caller only has to copy. The ladder is a
 * pure function of the flow path, so a re-run lands back in the directory its
 * previous run claimed — unless an earlier rung's foreign occupant was deleted
 * in between, in which case the re-run claims that now-free rung and its old
 * directory goes stale (a redirect, never an overwrite). Two distinct paths can
 * never share the full 64-char hash, so escalation terminates without
 * randomness; if even that directory cannot be taken, returns null after a
 * warning, because losing one export beats destroying another flow's evidence.
 * Both name forms are single FLOW_NAME_PATTERN-charset segments, so containment
 * under outputDir is preserved for every candidate. Creating is the whole point
 * (the marker *is* the claim), so this must be reached only once a byte is
 * certain to be copied — see the lazy claim in exportFailureArtifacts.
 */
async function claimExportDirName(
  outputDir: string,
  flowPath: string,
  stem: string
): Promise<string | null> {
  const hash = createHash("sha256").update(flowPath).digest("hex");
  const candidates = [stem];
  for (let len = 8; len <= hash.length; len += 8) {
    candidates.push(`${stem}-${hash.slice(0, len)}`);
  }
  const avoided: { dir: string; reason: string }[] = [];
  for (const name of candidates) {
    const dir = path.join(outputDir, name);
    const claim = await classifyExportDir(dir, flowPath);
    // Reading "free"/"mine" only earns the right to *try* the atomic take;
    // losing it reads exactly like a foreign verdict, so both escalate — and
    // warn — through the same path.
    const reason =
      claim.state === "foreign" ? occupiedBy(claim.owner) : await takeExportDir(dir, flowPath);
    if (reason !== null) {
      avoided.push({ dir, reason });
      continue;
    }
    // Warn only once the real destination is known, so every line names both
    // the directory being avoided and where the artifacts actually land.
    for (const entry of avoided) {
      console.error(
        `warning: ${entry.dir} ${entry.reason}; writing this flow's artifacts to ` +
          `${dir} so neither set is overwritten`
      );
    }
    return name;
  }
  console.error(
    `warning: not exporting artifacts for ${flowPath}: no candidate directory from ` +
      `${avoided[0].dir} through ${avoided[avoided.length - 1].dir} could be claimed without ` +
      `overwriting other files; leaving this run's artifact paths in place so nothing is overwritten`
  );
  return null;
}

/**
 * Copy each failed snapshot's artifacts into a durable, globbable location —
 * `<outputDir>/<flow>/<key>-<role>.png`, where `<flow>` is the YAML filename
 * stem (derived from the CLI-resolved `flowPath`, never from the wire report)
 * and `<key>` is the snapshot's baseline key, so a run that hits several
 * flows/snapshots can't clobber itself. Stems are unique only per directory, so
 * when a different flow file already owns `<flow>/` (see EXPORT_SOURCE_MARKER)
 * this run lands in the deterministic `<flow>-<pathhash>/` instead, and when
 * nothing at all can be claimed the export is skipped with a warning rather
 * than ever overwriting (claimExportDirName). The destination is claimed
 * atomically before a single byte is copied — and never earlier, so a run that
 * copies nothing leaves `--output` exactly as it was.
 *
 * NOT fixed, by design: two parallel runs of the *same* flow file into one
 * `--output` still overwrite each other's identical-key artifacts, since one
 * file's runs are indistinguishable to a separate process.
 *
 * This is the only place the CLI needs artifact bytes, so materialization
 * happens here, scoped to each failed snapshot's artifacts. Rewrites each
 * copied role's path in the report so the renderers and `--json` print the
 * durable location instead of a temp path. Failure-only: a clean pass carries
 * no artifacts, and a seeded baseline is already durable under
 * `__baselines__/`. Best-effort per file — a copy error warns on stderr and
 * leaves the source path in place; artifact export must never change a run's
 * verdict. Names that fail `SAFE_ARTIFACT_NAME` are skipped before any
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
  // Claimed lazily, at the first byte actually about to be copied, because
  // nothing earlier proves a byte will land at all: no failed snapshot, no
  // usable key, an empty artifacts object, or every role null after a failed
  // download. Claiming for any of them would leave a directory and a marker
  // behind for a run holding no artifacts — and the marker is not inert: it
  // makes the stem foreign to every *other* flow file from then on. Claiming
  // late is exactly as race-free: the atomicity is O_EXCL's, not the
  // ordering's, and the marker still precedes the first byte.
  let dir: string | null = null;
  for (const s of report.steps) {
    if (s.kind !== "snapshot" || s.status !== "fail" || !s.artifacts) continue;
    // Key first: keyFromBaselinePath needs the original baseline path, not a
    // materialized rewrite. The pattern check also hardens that fallback, whose
    // basename can still be ".." for a path ending in "/..".
    const key = s.snapshotKey ?? keyFromBaselinePath(s.artifacts);
    if (!key || !SAFE_ARTIFACT_NAME.test(key)) continue;
    // Materialize only this snapshot's artifacts — never the whole report.
    const { result } = await materializeArtifacts(s.artifacts, ctx);
    s.artifacts = result as Record<string, unknown>;
    for (const [role, value] of Object.entries(s.artifacts)) {
      if (typeof value !== "string") continue; // null = failed materialization
      if (dir === null) {
        const dirName = await claimExportDirName(outputDir, flowPath, stem);
        if (dirName === null) return; // warned already; sources stay in place, verdict unchanged
        // Nothing below re-creates the directory: if it is deleted mid-run the
        // copies fail and warn, rather than resurrecting it unmarked for the
        // next run to redirect away from.
        dir = path.join(outputDir, dirName);
      }
      const dest = path.join(dir, `${key}-${role}.png`);
      // Even if the key and stem patterns are ever weakened, the copy stays
      // inside --output. Also covers `role`, the remaining server-supplied piece
      // of the destination. It judges the real destination, so it can only run
      // after the claim: a `role` hostile enough to escape is the single way a
      // claim can still precede zero bytes.
      const rel = path.relative(outputDir, dest);
      if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
      try {
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
 * Fallback when the report carries no `snapshotKey`: the baseline artifact is
 * the baseline file itself (or a download named after it), so its basename IS
 * the key.
 */
function keyFromBaselinePath(artifacts: Record<string, unknown>): string | null {
  const baseline = artifacts.baseline;
  if (typeof baseline !== "string") return null;
  return path.basename(baseline).replace(/\.png$/, "");
}

/**
 * Rewrite any artifact handle left in the report to a printable string — the
 * tool-server's hostPath, or the bare filename — with zero fetches: the CLI
 * renders artifact paths as text only, so downloading the bytes just to print a
 * path would be pure waste against a remote tool-server. The renderers and
 * `--json` filter on `typeof v === "string"`, so a raw handle object would
 * vanish from the output. Runs after the optional `--output` export, which has
 * already replaced the failed snapshots' handles with durable local copies.
 */
function resolveArtifactDisplayPaths(report: FlowReport): void {
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
 * `console.log` is synchronous only when stdout is a file or a TTY. On a pipe —
 * every CI capture — writes are asynchronous, and a bare `process.exit()` right
 * after printing a large report tears the process down with everything beyond
 * the OS pipe buffer still queued inside Node, truncating a big `--json` report
 * mid-string. Stream writes complete in FIFO order, so waiting on a zero-length
 * sentinel write guarantees every previously queued chunk reached the fd first.
 *
 * This cannot hang: it waits only on the std streams' own write queues, never
 * on other open handles (tool-server sockets, timers) — and a
 * destroyed/EPIPE'd stream still invokes its write callback.
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
  if (report.executionPrerequisite) {
    lines.push(`  assumes: ${report.executionPrerequisite}`);
  }
  // Number only real steps so echo narration doesn't leave gaps in the sequence.
  let n = 0;
  for (const s of report.steps) {
    if (s.kind === "echo") {
      const line = renderEchoLine(s);
      if (line) lines.push(line);
      continue;
    }
    // Block structure prints in the step column but takes no number, so the
    // sequence still counts what the summary counts. Its under-lines hang under
    // it all the same, padded to the blank its own line printed.
    if (isStructural(s)) {
      lines.push(renderStepLine(s, { unnumbered: n }, report.flow));
      lines.push(...underStepLines(s, n + 1));
      continue;
    }
    n++;
    lines.push(renderStepLine(s, n, report.flow));
    lines.push(...underStepLines(s, n));
  }
  lines.push(`\n${renderSummary(report)}`);
  return lines.join("\n");
}

/**
 * `flow run`'s filesystem acceptance test — stat (following symlinks, as run
 * does) plus a readability probe — so `list` never advertises a path `run`
 * rejects. Any failure (broken symlink, race, EACCES) just omits the entry.
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
 * - `__baselines__` directories at any depth are machine-managed snapshot
 *   storage, not a place flows live. `run` would technically execute a YAML
 *   dropped in one, but advertising the inside of an output directory invites
 *   keying baselines of baselines.
 * - Symlinked directories are not entered: a link cycle would walk forever. A
 *   symlinked flow FILE is still listed — the runnability probe stats through
 *   it, exactly as `flow run` does.
 *
 * An unreadable subdirectory omits its subtree; only the top-level readdir's
 * error propagates, so a missing `.argent/flows` still gets its own message.
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

/**
 * The YAML path a `flow run` argument addresses: a saved-flow name becomes
 * `.argent/flows/<name>.yaml`, anything else is already a path and is handed
 * back untouched.
 *
 * The two forms cannot collide. A name is exactly what SAFE_FLOW_NAME accepts —
 * a charset with no separator and no dot, so a name can carry no directory and
 * no extension — while a runnable path must end in `.yaml`. The token that
 * looks ambiguous, `checkout.yaml`, carries an extension and is therefore a
 * path; it does NOT fall back to the flows directory.
 *
 * Deciding this lexically rather than by probing the filesystem is deliberate:
 * an argument's meaning must not depend on which files happen to exist, or a
 * stray `./checkout.yaml` appearing next to a CI checkout would silently
 * re-point a `run checkout` that had been reading `.argent/flows` for months.
 *
 * What contains the join is the charset itself, not the guards downstream: no
 * string SAFE_FLOW_NAME admits can carry a separator or a dot. The rewrite is
 * nevertheless relative and placed before all of them, so a name takes no
 * shortcut past a check a typed-out path faces — the ones that bite being the
 * filesystem ones (the file must exist, and its basename must appear in the
 * directory listing byte-for-byte).
 *
 * Relative also keeps downstream messages quoting something the user can paste
 * back, and leaves `path.resolve(projectRoot, …)` landing on the very same
 * absolute file the spelled-out path resolves to — which keys the report,
 * `__baselines__/`, and the `--output` export directory, so `run checkout` and
 * `run .argent/flows/checkout.yaml` are one run under one identity.
 *
 * One name shape the CLI cannot address, though the contract admits it: a
 * leading "-" makes the token a flag to any argv parser, so `-dash` is
 * reachable only as `-- -dash` or by path.
 */
function resolveFlowRef(ref: string): { suppliedPath: string; fromName: boolean } {
  if (!SAFE_FLOW_NAME.test(ref)) return { suppliedPath: ref, fromName: false };
  return { suppliedPath: path.join(FLOWS_DIR, `${ref}.yaml`), fromName: true };
}

/**
 * Recovery for a path that named nothing while a flow of that very stem IS
 * saved — `argent flow run checkout.yaml` typed at the project root, where the
 * file actually lives a directory down. An implicit fallback into
 * `.argent/flows` would make an argument's meaning depend on which files exist
 * (see resolveFlowRef), so it stays refused and only the message improves.
 *
 * The name it suggests comes from the directory listing, never from the user's
 * spelling: a stat-based probe would match `Checkout.yaml` against an on-disk
 * `checkout.yaml` on a case-insensitive filesystem and hand back a command
 * `run` itself then refuses at its byte-exact spelling check. An entry whose
 * own stem the flow-name contract refuses (`Upper.YAML`) is no hint at all — it
 * needs a rename — and the runnability probe still runs, so the hint can never
 * name something `run` would reject downstream. A name that clears
 * SAFE_FLOW_NAME is inside SHELL_SAFE_ARG, so it needs no quoting.
 *
 * Empty when the missing path already points inside the flows directory: a
 * same-stem sibling elsewhere in the tree is a different flow, not the one they
 * asked for.
 */
async function savedFlowHint(projectRoot: string, missingPath: string): Promise<string> {
  const dir = path.resolve(projectRoot, FLOWS_DIR);
  const within = path.relative(dir, missingPath);
  if (!within.startsWith("..") && !path.isAbsolute(within)) return "";
  const wanted = `${path.basename(missingPath, ".yaml")}.yaml`;
  const entries = await fsp.readdir(dir).catch(() => null);
  if (entries === null) return "";
  const actual = entries.includes(wanted)
    ? wanted
    : entries.find((name) => name.toLowerCase() === wanted.toLowerCase());
  if (actual === undefined) return "";
  const name = path.basename(actual, ".yaml");
  if (!SAFE_FLOW_NAME.test(name)) return "";
  if (!(await isRunnableFlowFile(path.join(dir, actual)))) return "";
  return (
    `\nA flow named "${name}" is saved under ${FLOWS_DIR} — ` +
    `did you mean: argent flow run ${name}`
  );
}

/**
 * Runnable flows under `dir`, as paths relative to it, sorted for a
 * deterministic run order. Same acceptance rules as `flow list`, so `list` and
 * a directory `run` can never disagree. The recursive walk skips
 * dot-directories and node_modules and never follows a directory symlink (its
 * dirent is not a directory, and a `*.yaml` one fails isRunnableFlowFile).
 */
async function collectFlowFiles(dir: string, recursive: boolean): Promise<string[]> {
  const found: string[] = [];
  const walk = async (current: string, rel: string): Promise<void> => {
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const entryRel = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (recursive && !entry.name.startsWith(".") && entry.name !== "node_modules") {
          // An unreadable subtree is skipped so the rest of the walk still
          // runs; only the top-level readdir failure aborts discovery.
          await walk(path.join(current, entry.name), entryRel).catch(() => {});
        }
        continue;
      }
      if (!entry.name.endsWith(".yaml")) continue;
      if (!SAFE_FLOW_NAME.test(path.basename(entry.name, ".yaml"))) continue;
      if (await isRunnableFlowFile(path.join(current, entry.name))) found.push(entryRel);
    }
  };
  await walk(dir, "");
  return found.sort();
}

/**
 * CLI runs rely on the caller and tool-server sharing a filesystem: the runner
 * resolves `run:` targets against each containing flow file's directory and
 * reads/writes `__baselines__` beside the canonicalized root YAML — all on the
 * tool server's disk. The flow-execute tool stays remotely callable; only CLI
 * routing that cannot guarantee the shared filesystem is refused, deliberately
 * including single-file flows that could run remotely, since the CLI cannot
 * tell them apart without parsing the flow. Returns the refusal with its
 * recovery hint when remote routing is configured.
 */
async function requireLocalToolServer(): Promise<string | undefined> {
  const routing = await getResolvedToolsUrl();
  if (routing.source === "none") return undefined;
  // With ARGENT_TOOLS_URL set over an existing link file, unsetting only the
  // env var re-routes through the shadowed link — the same refusal with the
  // other source, so name both steps up front.
  const recovery =
    routing.source === "env"
      ? routing.shadowedLink
        ? "Unset ARGENT_TOOLS_URL and run `argent unlink`, then try again — " +
          `a link to ${routing.shadowedLink.url} is also configured and takes over once the env var is unset.`
        : "Unset ARGENT_TOOLS_URL and try again."
      : "Run `argent unlink` and try again.";
  return `argent flow run requires the auto-started local tool server; ${routing.source} routing is configured.\n${recovery}`;
}

/** One flow-execute payload builder so single and batch runs cannot drift. */
function buildRunPayload(
  flowPath: string,
  projectRoot: string,
  args: ReturnType<typeof parseRunArgs>
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    flow_path: flowPath,
    project_root: projectRoot,
    // Headless runs never block on the LLM prerequisite handshake.
    prerequisiteAcknowledged: true,
  };
  if (args.device) payload.device = args.device;
  if (args.platform) payload.platform = args.platform;
  if (args.updateBaselines) payload.updateBaselines = true;
  return payload;
}

/** One NDJSON record — exactly one line. */
function writeJsonStreamRecord(record: Record<string, unknown>): void {
  console.log(JSON.stringify(record));
}

/** Mirror a tool invocation failure without putting human text on stdout. */
function writeJsonStreamError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  writeJsonStreamRecord({
    event: "error",
    error: message,
    ...(err instanceof ToolInvocationError && err.errorCode ? { error_code: err.errorCode } : {}),
    ...(err instanceof ToolInvocationError && err.errorKind ? { error_kind: err.errorKind } : {}),
  });
}

/**
 * Durable diff output: copy failed-snapshot images out of the tool-server's
 * cache before any renderer prints paths, so every output mode shows the
 * durable location. The only artifact bytes the CLI ever fetches; baseUrl is
 * resolved lazily so a run without --output makes no extra round-trip. Whatever
 * handles remain print as server-side paths.
 */
async function exportAndResolveArtifacts(
  report: FlowReport,
  outputDir: string | undefined,
  flowPath: string,
  baseUrl: ToolsClient["baseUrl"]
): Promise<void> {
  if (outputDir) {
    const { url, token } = await baseUrl();
    await exportFailureArtifacts(report, outputDir, flowPath, { toolsUrl: url, authToken: token });
  }
  resolveArtifactDisplayPaths(report);
}

/** One flow's outcome in a directory run — also the --json aggregate entry. */
interface BatchFlowResult {
  path: string;
  status: "pass" | "fail" | "skip";
  report?: FlowReport;
  error?: string;
}

/**
 * Run every discovered flow in `dir` sequentially. Reports failures only (no
 * live step lines), then a flow-level summary. A flow failing its steps — or
 * one the tool-server rejects as invalid — lets the batch continue, while an
 * infra error (transport throw, unclassified failure, non-report result) stops
 * it and counts the remaining flows skipped.
 */
async function runFlowDirectory(
  dir: string,
  args: ReturnType<typeof parseRunArgs>,
  projectRoot: string,
  options: FlowCommandOptions
): Promise<void> {
  let flows: string[];
  try {
    flows = await collectFlowFiles(dir, args.recursive);
  } catch {
    console.error(`Could not read flow directory: ${dir}`);
    return exitAfterFlush(2);
  }
  if (flows.length === 0) {
    console.error(`No flows found in ${dir}`);
    if (!args.recursive) console.error("Pass -r/--recursive to include subdirectories.");
    return exitAfterFlush(2);
  }

  const refusal = await requireLocalToolServer();
  if (refusal) {
    console.error(refusal);
    return exitAfterFlush(2);
  }
  const { callTool, baseUrl } = createToolsClient({ paths: options.paths });

  const outputBase = args.output ? path.resolve(args.output) : undefined;
  const results: BatchFlowResult[] = [];
  // A validation rejection is specific to one flow file, so the batch keeps
  // going. Anything else — transport death, or a failure the server didn't
  // classify — could make every remaining flow burn a device run against the
  // same wall, so stop.
  let stopped = false;
  for (const [i, rel] of flows.entries()) {
    if (!args.json) console.log(`[${i + 1}/${flows.length}] ${rel}`);
    if (stopped) {
      results.push({ path: rel, status: "skip" });
      if (!args.json) console.log(`  ${STATUS_GLYPH.skip} not run (batch stopped)`);
      continue;
    }
    let report: FlowReport | undefined;
    try {
      // No onProgress: batch output is failures-only, never live step lines.
      const resp = await callTool(
        "flow-execute",
        buildRunPayload(path.join(dir, rel), projectRoot, args)
      );
      const data = resp.data as FlowReport;
      // typeof guard: `in` throws on a primitive wire value, and that must
      // classify as "no report", not as an infra throw.
      if (data && typeof data === "object" && "steps" in data) report = data;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(message);
      results.push({ path: rel, status: "fail", error: message });
      const rejectedThisFlowOnly =
        err instanceof ToolInvocationError && err.errorKind === "validation";
      if (!rejectedThisFlowOnly) stopped = true;
      continue;
    }
    if (!report) {
      const message = `"${rel}" did not produce a run report.`;
      console.error(message);
      results.push({ path: rel, status: "fail", error: message });
      stopped = true;
      continue;
    }
    // Key exports by the flow's subdirectory so recursive same-stem flows
    // cannot clobber each other (exportFailureArtifacts keys by stem only).
    await exportAndResolveArtifacts(
      report,
      outputBase ? path.join(outputBase, path.dirname(rel)) : undefined,
      path.join(dir, rel),
      baseUrl
    );
    results.push({ path: rel, status: report.ok ? "pass" : "fail", report });
    if (!args.json) {
      for (const line of renderFailedSteps(report)) console.log(line);
      console.log(`  ${renderSummary(report, { withDevice: true })}`);
    }
  }

  const counts = {
    total: results.length,
    passed: results.filter((r) => r.status === "pass").length,
    failed: results.filter((r) => r.status === "fail").length,
    skipped: results.filter((r) => r.status === "skip").length,
  };
  if (args.json) {
    console.log(JSON.stringify({ ok: counts.failed === 0, ...counts, flows: results }, null, 2));
  } else {
    console.log(`\n${renderBatchSummary(counts)}`);
  }
  return exitAfterFlush(counts.failed === 0 ? 0 : 1);
}

export async function flow(argv: string[], options: FlowCommandOptions): Promise<void> {
  const [sub, ...rest] = argv;

  if (!sub || sub === "--help" || sub === "-h") {
    printHelp();
    return;
  }

  if (sub === "list") {
    const dir = path.join(process.cwd(), FLOWS_DIR);
    try {
      // One final sort over full relative paths, not per-directory: the
      // ordering must be a pure function of the set of paths, never of the walk
      // order.
      const paths = (await collectRunnableFlowPaths(dir))
        .sort()
        .map((rel) => path.join(FLOWS_DIR, rel));
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

  // Once streaming is requested stdout belongs exclusively to NDJSON, so help
  // goes to stderr as the diagnostic it is.
  const jsonStream = rest.some(
    (tok) => tok === "--json-stream" || tok.startsWith("--json-stream=")
  );
  // Checked before parseRunArgs so --help wins even when it trails a
  // value-taking flag (`--device --help` would otherwise throw "requires a
  // value" instead of printing help).
  if (rest.includes("--help") || rest.includes("-h")) {
    printHelp(jsonStream);
    return;
  }
  const fail = (message: string, code: number, err: unknown = message): Promise<never> => {
    if (jsonStream) writeJsonStreamError(err);
    console.error(message);
    return exitAfterFlush(code);
  };

  let args: ReturnType<typeof parseRunArgs>;
  try {
    args = parseRunArgs(rest);
  } catch (err) {
    if (err instanceof FlagParseException) {
      if (jsonStream) writeJsonStreamError(err);
      console.error(`Error: ${err.message}\n`);
      printHelp(jsonStream);
      return exitAfterFlush(2);
    }
    throw err;
  }
  if (!args.flowRef) {
    const message =
      "argent flow run <flow|flow.yaml|dir> requires a flow name, a YAML file path, or a directory path.";
    if (jsonStream) writeJsonStreamError(message);
    console.error(message);
    printHelp(jsonStream);
    return exitAfterFlush(2);
  }

  const projectRoot = process.cwd();
  // From here a name is indistinguishable from a path the user typed: one set
  // of guards, one resolved identity, one run (see resolveFlowRef). `fromName`
  // survives only to aim the not-found recovery, since a name resolves
  // somewhere the user never spelled out.
  const { suppliedPath, fromName } = resolveFlowRef(args.flowRef);
  // path.resolve collapses ".." lexically, without consulting symlinks, so a
  // ".." following a symlinked directory would make the CLI stat and run a
  // different file than the one the kernel opens for this string. Rejected
  // before path.resolve — same predicate as the tool-server's flow_path_dotdot
  // guard, and ordered before the extension/stem arms the way the server orders
  // it, so the dishonest-path cause wins over a basename complaint. The hint
  // realpath's the parent directory (that is where ".." and symlinks interact)
  // but keeps the supplied basename: realpath'ing the final component would
  // rewrite a symlinked flow to its target's name, and the basename is the
  // flow's identity (report name, __baselines__/ key, --output dir), so the
  // hint would quietly rename the run. A basename of ".." or "." names no flow
  // file and gets the generic recovery.
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
        // Parent unresolvable, or nothing at the reassembled path.
      }
    }
    return fail(
      `Flow path must not contain ".." segments — they are collapsed without following symlinks, ` +
        `so the path can name a different file than the one your shell opens: ${suppliedPath}\n` +
        recovery,
      2
    );
  }
  const resolvedPath = path.resolve(projectRoot, suppliedPath);
  // Stat-first so a directory named `foo.yaml` still batches; on a failed stat
  // without -r, fall through so the single-file messages stay identical. A name
  // is not exempt: resolveFlowRef has already made it a path, and one dispatch
  // for both spellings is what keeps them one run under one identity.
  let isDirectory = false;
  try {
    isDirectory = (await fsp.stat(resolvedPath)).isDirectory();
  } catch {
    // Only a spelled-out path can be missing a directory the user meant; for a
    // name, "directory not found" would quote a path they never typed, so that
    // form falls through instead.
    if (args.recursive && !fromName) {
      return fail(`Flow directory not found: ${resolvedPath}`, 2);
    }
  }
  if (isDirectory) {
    if (args.jsonStream) {
      return fail("--json-stream supports a single flow; directory runs are not supported.", 2);
    }
    return runFlowDirectory(resolvedPath, args, projectRoot, options);
  }
  if (args.recursive) {
    return fail(
      fromName
        ? `flow run --recursive requires a directory path; "${args.flowRef}" is a saved-flow name, ` +
            `which always addresses the single file ${suppliedPath}.`
        : `flow run --recursive requires a directory path: ${suppliedPath}`,
      2
    );
  }
  // A trailing separator asserts the path names a directory; the honest case
  // already went to the directory dispatch above. From here the path is a
  // file's, so the kernel would refuse to open "ok.yaml/" (ENOTDIR), yet
  // path.resolve drops the separator lexically — without this guard the CLI
  // would stat and run a file its own argument does not name. Same
  // dishonest-path class as the ".." guard above, and like it ordered before
  // the extension/stem arms. Ordered after that guard because its recovery (a
  // fully resolved path) also cures a trailing separator, while stripping here
  // would leave the ".." standing and demand a second correction.
  const separatorTrimmedPath = suppliedPath.replace(/[\\/]+$/, "");
  if (separatorTrimmedPath !== suppliedPath && separatorTrimmedPath !== "") {
    // Trimming "checkout/" leaves a token that now reads as a saved-flow name,
    // and offering it bare would hand back a command for a DIFFERENT file —
    // `.argent/flows/checkout.yaml` rather than the `./checkout` this argument
    // names. Keep the hint in the form the argument was written in.
    const hint = SAFE_FLOW_NAME.test(separatorTrimmedPath)
      ? `.${path.sep}${separatorTrimmedPath}`
      : separatorTrimmedPath;
    return fail(
      `Flow path must not end in a path separator — the separator claims a directory, ` +
        `which the kernel would refuse to open as a file, so the CLI would run a file ` +
        `this string does not name: ${suppliedPath}\n` +
        `Did you mean: argent flow run ${shellQuoteArg(hint)}`,
      2
    );
  }
  if (path.extname(suppliedPath) !== ".yaml") {
    // A valid name never reaches here — resolveFlowRef already rewrote it to a
    // .yaml path — so a token still carrying neither a separator nor an
    // extension is a name the charset refused. Complain about the name it was
    // meant to be, not about a ".yaml" suffix the user never intended to type.
    // The bare ".yaml" arm goes first: naming the missing stem is the more
    // precise of the two complaints.
    const looksLikeName =
      !suppliedPath.includes("/") &&
      !suppliedPath.includes("\\") &&
      path.extname(suppliedPath) === "";
    if (path.basename(suppliedPath).toLowerCase() === ".yaml") {
      // path.extname treats a bare ".yaml" as an extensionless dotfile, so name the missing stem.
      return fail(
        `Flow filename must have a non-empty name containing only letters, numbers, "_", or "-": ${suppliedPath}`,
        2
      );
    }
    if (looksLikeName) {
      return fail(
        `Flow name must contain only letters, numbers, "_", or "-": ${suppliedPath}\n` +
          `Names run \`${FLOWS_DIR}/<name>.yaml\`; pass a path ending in .yaml to run a flow file kept elsewhere.`,
        2
      );
    }
    if (path.extname(suppliedPath).toLowerCase() === ".yaml") {
      // On case-insensitive filesystems the path looks valid to the user, so name the real problem.
      return fail(
        `Flow extension must be lowercase .yaml, not ${path.extname(suppliedPath)}: ${suppliedPath}`,
        2
      );
    }
    return fail(`Flow path must end in .yaml: ${suppliedPath}`, 2);
  }

  const flowName = path.basename(suppliedPath, ".yaml");
  if (!SAFE_FLOW_NAME.test(flowName)) {
    return fail(
      `Flow filename must have a non-empty name containing only letters, numbers, "_", or "-": ${suppliedPath}`,
      2
    );
  }

  const flowPath = resolvedPath;
  try {
    const stat = await fsp.stat(flowPath);
    if (!stat.isFile()) {
      return fail(`Flow path is not a file: ${flowPath}`, 2);
    }
    await fsp.access(flowPath, fsConstants.R_OK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const detail = code === "ENOENT" ? "Flow file not found" : "Could not read flow file";
    // Each form misses for its own reason. A name is the one form whose file
    // the user never spelled out, so the resolved path plus `flow list` settles
    // whether the flow is missing or the lookup went somewhere unexpected. A
    // path that missed may instead be a saved flow the operator addressed as if
    // it sat in the current directory — say so when it is.
    let recovery = "";
    if (code === "ENOENT") {
      recovery = fromName
        ? `\nNo flow named "${args.flowRef}" is saved there — run \`argent flow list\` to see the saved flows.`
        : await savedFlowHint(projectRoot, flowPath);
    }
    return fail(`${detail}: ${flowPath}${recovery}`, 2);
  }

  // The stat above matched the basename by the filesystem's rules, which on a
  // case-insensitive filesystem finds a file really named "Upper.YAML" for
  // "upper.yaml" — every name guard above would then have validated a spelling
  // that exists nowhere on disk, and the flow name that keys the report,
  // __baselines__/, and --output would be one no file carries. readdir, not
  // realpath: realpath rewrites a symlinked flow to its target's name, and
  // `run` deliberately accepts a symlink under the link's own name. The
  // basename is pure ASCII by this point (stem charset + ".yaml"), so
  // Unicode-normalizing filesystems cannot make the comparison lie. A readdir
  // failure (an execute-only parent directory lets stat through while refusing
  // the listing) skips the check rather than refusing a file the exact-named
  // contract may well be honoring.
  const suppliedBase = path.basename(flowPath);
  const siblings = await fsp.readdir(path.dirname(flowPath)).catch(() => null);
  if (siblings !== null && !siblings.includes(suppliedBase)) {
    const actual = siblings.find((name) => name.toLowerCase() === suppliedBase.toLowerCase());
    // Hint the real name only when `run` would accept it (a stem-case slip like
    // Checkout.yaml); an invalid real name (Upper.YAML) needs a rename, and
    // suggesting a command that will itself be refused helps no one.
    const actualRunnable =
      actual !== undefined &&
      path.extname(actual) === ".yaml" &&
      SAFE_FLOW_NAME.test(path.basename(actual, ".yaml"));
    // Answer in the form the operator used: someone who typed a name gets the
    // name that works, not a path into a directory they never spelled out. The
    // name is inside SHELL_SAFE_ARG by the check above, so it needs no quoting.
    const recovery = actualRunnable
      ? fromName
        ? `Did you mean: argent flow run ${path.basename(actual!, ".yaml")}`
        : `Did you mean: argent flow run ${shellQuoteArg(path.join(path.dirname(suppliedPath), actual!))}`
      : actual !== undefined
        ? `Rename ${actual} to ${suppliedBase} to run it — flow files must be lowercase .yaml.`
        : "Pass the flow file's name exactly as it appears on disk.";
    return fail(
      `Flow path must name the file as it appears on disk — this filesystem matched ` +
        `${JSON.stringify(suppliedBase)} case-insensitively` +
        `${actual !== undefined ? ` to ${JSON.stringify(actual)}` : ""}, so the flow name ` +
        `(which keys the report, __baselines__/, and --output) would be one no file carries: ` +
        `${suppliedPath}\n${recovery}`,
      2
    );
  }

  const refusal = await requireLocalToolServer();
  if (refusal) return fail(refusal, 2);

  const { callTool, baseUrl } = createToolsClient({ paths: options.paths });

  const payload = buildRunPayload(flowPath, projectRoot, args);

  // Live rendering: each step line prints the moment the step completes. When
  // no progress events fire, `liveSteps` stays zero and the buffered renderer
  // below owns the whole report.
  let liveSteps = 0;
  let liveIndex = 0;
  const onStepReport = (event: unknown): void => {
    const s = event as StepReport;
    if (args.jsonStream) {
      writeJsonStreamRecord({ event: "progress", data: s });
      return;
    }
    if (liveSteps === 0) console.log(`Flow "${flowName}"`);
    liveSteps++;
    if (s.kind === "echo") {
      const line = renderEchoLine(s);
      if (line) console.log(line);
      return;
    }
    // Block structure: printed as it streams, but unnumbered, with the same
    // blank width renderReport's would give it. Its warning prints too, padded
    // to the blank the line above just printed; artifacts are not printed here
    // for any step — no path exists yet — and reach the tail below.
    if (isStructural(s)) {
      console.log(renderStepLine(s, { unnumbered: liveIndex }, flowName));
      if (s.warning) console.log(renderUnderStepLine(s, liveIndex + 1, `⚠ ${s.warning}`));
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
    // Deliberately NOT materialized here: the CLI prints artifact paths as text
    // and renders no images, so deep-walking the report would download every
    // tool-step screenshot and all three PNGs of each failed snapshot just to
    // show a path. Only what --output copies is fetched, below.
    report = resp.data as FlowReport;
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err), 1, err);
  }

  if (!report || typeof report !== "object" || !("steps" in report)) {
    return fail(`"${flowName}" did not produce a run report.`, 2);
  }

  try {
    await exportAndResolveArtifacts(
      report,
      args.output ? path.resolve(args.output) : undefined,
      flowPath,
      baseUrl
    );
  } catch (err) {
    if (!args.jsonStream) throw err;
    return fail(err instanceof Error ? err.message : String(err), 2, err);
  }

  if (args.jsonStream) {
    writeJsonStreamRecord({ event: "result", data: report });
  } else if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (liveSteps > 0) {
    // Steps already printed live — emit only what the final report knows: the
    // prerequisite note, materialized artifact paths, and the summary.
    if (report.executionPrerequisite) console.log(`  assumes: ${report.executionPrerequisite}`);
    for (const line of renderArtifactLines(report)) console.log(line);
    console.log(`\n${renderSummary(report, { withDevice: true })}`);
  } else {
    console.log(renderReport(report));
  }

  return exitAfterFlush(report.ok ? 0 : 1);
}
