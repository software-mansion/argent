import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  createToolsClient,
  isArtifactHandle,
  materializeArtifacts,
  type MaterializeContext,
  type ToolsServerPaths,
} from "@argent/tools-client";
import { isCi } from "@argent/telemetry";
import { FlagParseException } from "./flag-parser.js";
import {
  artifactPath,
  buildJUnitXml,
  candidateRows,
  formatDuration,
  INDETERMINATE_HINT,
  nodeRow,
  normalizeFailure,
  parseReporterSpec,
  stepLabel,
  type NormalizedFailure,
} from "./flow-report.js";

export interface FlowCommandOptions {
  paths: ToolsServerPaths;
}

/**
 * Narrow local copy of the tool-server's `FlowStepFailure` wire shape —
 * deliberately duplicated, not imported. No shared package spans the CLI and
 * the tool-server (`StepReport` is already declared three times for exactly
 * this reason), and a cross-package import would couple the CLI's release to
 * the producer's. Only the fields this renderer prints appear here, and every
 * one of them is optional beyond `code`/`message`: the object arrives from a
 * possibly-remote `argent link` server, so it is validated and clamped by
 * `normalizeFailure` before a single character of it is printed.
 */
export interface FlowStepFailure {
  code: string;
  message: string;
  category?: string;
  determinacy?: "determinate" | "indeterminate";
  hint?: string;
  step?: {
    index?: number;
    ordinal?: number;
    kind?: string;
    flow?: string;
    target?: string;
    depth?: number;
    /**
     * Not yet emitted by the tool-server (YAML node ranges are a later phase);
     * declared so a server that starts sending them renders `@ file:line`
     * without a CLI change. Until then the block derives the path from the
     * flow name.
     */
    source?: { file?: string; line?: number };
  };
  selector?: { described?: string };
  expected?: Record<string, unknown>;
  actual?: {
    matchCount?: number;
    visibleMatchCount?: number;
    element?: FlowFailureNode;
    text?: string;
    ownText?: string;
    mismatchPercentage?: number;
  };
  screen?: FlowFailureScreen;
  candidates?: FlowFailureCandidate[];
  candidateCount?: number;
  /** ArtifactHandle on the wire; a string once `resolveArtifactDisplayPaths` has run. */
  screenshot?: unknown;
  tree?: unknown;
  timing?: {
    startedAt?: number;
    durationMs?: number;
    budgetMs?: number;
    attempts?: number;
    /** Reads the runner was willing to trust. Absent from a pre-`reads` server. */
    trustedAttempts?: number;
    lastTrustedReadAt?: number;
    darkTailMs?: number;
  };
  cause?: { code?: string; message?: string };
  data?: Record<string, unknown>;
}

/** Flat projection of one on-screen element. No children — the tree is an artifact. */
export interface FlowFailureNode {
  role?: string;
  frame?: { x: number; y: number; width: number; height: number };
  label?: string;
  identifier?: string;
  value?: string;
  text?: string;
  flags?: string;
}

export interface FlowFailureCandidate {
  node?: FlowFailureNode;
  score?: number;
  basis?: string;
  selectorYaml?: string;
  note?: string;
}

export type FlowFailureScreen =
  | {
      state: "available";
      source?: string;
      capturedAt?: "at-failure" | "after-failure";
      ageMs?: number;
      elementCount?: number;
      elements?: FlowFailureNode[];
      truncated?: true;
      /** Device size in points. Absent from a server that does not report it. */
      size?: { width: number; height: number };
    }
  | { state: "unavailable"; reason?: string; detail?: string; hint?: string };

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
  /**
   * Structured diagnostics for a step that did not pass. Present on at most
   * one step per run (the runner hard-stops at the first non-passing leaf) and
   * absent entirely from a pre-diagnostics tool-server, so every renderer is
   * gated on presence and falls back to today's reason-only output.
   */
  failure?: FlowStepFailure;
  /**
   * Wall-clock duration of the step. Omitted on skips and by a pre-timing
   * tool-server — which is why the step line only grows a ` (1.2s)` suffix
   * when it is present, keeping an old server's output byte-identical.
   */
  durationMs?: number;
}

export interface FlowReport {
  flow: string;
  device: string;
  executionPrerequisite?: string;
  ok: boolean;
  /**
   * The run was cancelled mid-flight. The runner has always set this
   * (`FlowRunResult.aborted`) precisely so a FAIL whose step statuses are all
   * pass/skip is self-explanatory — without it the summary prints FAIL with no
   * failing step and no explanation. Absent on completed runs.
   */
  aborted?: boolean;
  passed: number;
  failed: number;
  skipped: number;
  errored: number;
  steps: StepReport[];
  /** `Date.now()` when the first step began — the JUnit `timestamp` source. */
  startedAt?: number;
  /** Whole-run wall clock, for the JUnit suite `time`. */
  durationMs?: number;
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
  --output <dir>         Also write failure evidence (screenshot, element dump)
                         and failed snapshot images (baseline/current/diff)
                         under <dir>/<flow>/ — a stable path for CI artifact upload
  --reporter <spec>      Extra report output, repeatable: \`default\` (the terminal
                         output, always on) or \`junit:<path>\` to write JUnit XML
  --json                 Print the raw JSON report
  --help, -h             Show this help

Examples:
  argent flow run checkout --platform ios
  argent flow run checkout --device <UDID> --update-baselines
  argent flow run checkout --output flow-artifacts --json
  argent flow run checkout --output flow-artifacts --reporter junit:flow-artifacts/junit.xml
`);
}

export function parseRunArgs(argv: string[]): {
  name?: string;
  device?: string;
  platform?: string;
  output?: string;
  updateBaselines: boolean;
  json: boolean;
  /**
   * Raw `--reporter` specs, in the order given. Always present (never
   * optional) so the parsed shape is the same object every time, whether or
   * not the flag was passed.
   */
  reporter: string[];
} {
  const out = { updateBaselines: false, json: false, reporter: [] } as ReturnType<
    typeof parseRunArgs
  >;
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
    else if (flag === "--reporter") {
      const spec = takeValue("--reporter");
      // Validate at parse time, not at write time: a bad spec must exit 2
      // before the run starts. Discovering it after a 40-second flow — with
      // the report file the operator asked for missing — is the worse failure.
      parseReporterSpec(spec);
      out.reporter.push(spec);
    }
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

/**
 * One step line. `opts.omitReason` drops the ` — <reason>` suffix, for the
 * failure block's context window: the reason is already the block's headline,
 * and repeating it four lines lower buries the window's actual job (showing
 * what ran just before).
 *
 * The ` (1.2s)` timing appears only when `durationMs` is present, so a
 * pre-timing tool-server renders byte-identically to before.
 */
export function renderStepLine(
  s: StepReport,
  n: number,
  topFlow: string,
  opts: { omitReason?: boolean } = {}
): string {
  const where = s.flow && s.flow !== topFlow ? ` [${s.flow}]` : "";
  const label = stepLabel(s);
  const timing = s.durationMs === undefined ? "" : ` ${formatDuration(s.durationMs)}`;
  const reason = s.reason && !opts.omitReason ? ` — ${s.reason}` : "";
  const glyph = s.status === "pass" && s.warning ? "⚠" : STATUS_GLYPH[s.status];
  return `  ${glyph} ${String(n).padStart(2)} ${stepIndent(s.depth)}${label}${where}${timing}${reason}`;
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
  // device, so its summary carries the device instead.
  const where = opts.withDevice ? ` on ${report.device}` : "";
  // A cancelled run can fail with every step pass/skip — say so, or the
  // verdict contradicts the counters it is printed next to.
  const cancelled = report.aborted ? " (run cancelled)" : "";
  return `${report.ok ? "PASS" : "FAIL"}${cancelled}${where} — ${report.passed} passed, ${report.failed} failed, ${report.errored} errored, ${report.skipped} skipped${warningsNote}`;
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

/** Indent of a slot line inside a failure block. */
const FAILURE_SLOT_INDENT = "     ";

/**
 * How many preceding numbered steps the context window shows. Two is enough to
 * answer "what state was the app in" without turning the block into a second
 * copy of the step list.
 */
const FAILURE_CONTEXT_STEPS = 2;

/**
 * The failing step plus the two numbered steps before it, with the `echo`
 * narration that introduces them. Lines come from `renderStepLine` /
 * `renderEchoLine` — the same renderers the step list uses, with the reason
 * suffix dropped — so the window can never drift from the list it quotes.
 */
function failureContextLines(
  steps: StepReport[],
  ordinals: Map<number, number>,
  failingIndex: number,
  failingOrdinal: number,
  topFlow: string
): string[] {
  const first = Math.max(1, failingOrdinal - FAILURE_CONTEXT_STEPS);
  let start = failingIndex;
  let ordinal = failingOrdinal;
  for (let i = failingIndex - 1; i >= 0; i--) {
    // Narration belongs to the step it introduces, so an echo immediately
    // above an included step comes along; one above an excluded step is never
    // reached, because the numbered step below it breaks the loop first.
    if (steps[i]!.kind === "echo") {
      start = i;
      continue;
    }
    if (ordinal - 1 < first) break;
    ordinal -= 1;
    start = i;
  }
  const lines: string[] = [];
  for (let i = start; i <= failingIndex; i++) {
    const s = steps[i]!;
    if (s.kind === "echo") {
      const line = renderEchoLine(s);
      if (line) lines.push(line);
      continue;
    }
    lines.push(renderStepLine(s, ordinals.get(i) ?? 0, topFlow, { omitReason: true }));
  }
  return lines;
}

function renderFailureBlock(
  report: FlowReport,
  steps: StepReport[],
  ordinals: Map<number, number>,
  index: number,
  f: NormalizedFailure
): string[] {
  const s = steps[index]!;
  const ordinal = ordinals.get(index) ?? 0;
  const lines: string[] = [
    `  ${ordinal}) ${stepLabel(s)}${f.sourceFile ? `  @ ${f.sourceFile}` : ""}`,
  ];
  const slot = (text: string): void => void lines.push(`${FAILURE_SLOT_INDENT}${text}`);

  slot(f.message ? `${f.code}: ${f.message}` : f.code);

  const context = failureContextLines(steps, ordinals, index, ordinal, report.flow);
  if (context.length > 0) {
    slot("context:");
    for (const line of context) lines.push(`${FAILURE_SLOT_INDENT}${line}`);
  }

  if (f.expected) slot(`expected: ${f.expected}`);
  if (f.actual) slot(`actual: ${f.actual}`);
  if (f.match) slot(`match: ${nodeRow(f.match)}`);
  if (f.candidates.length > 0) {
    slot("candidates:");
    for (const row of candidateRows(f.candidates, { withCenter: true })) slot(`  ${row}`);
  }
  if (f.screen) slot(`screen: ${f.screen}`);
  // The launch / tree-source shapes have no screen and no tree to show — the
  // evidence itself is what failed — so the device identity takes their slot.
  if (f.device) slot(`device: ${f.device}`);
  if (f.reads) slot(`reads: ${f.reads}`);
  if (f.determinacy === "indeterminate") slot(`hint: ${INDETERMINATE_HINT}`);
  if (f.hint) slot(`hint: ${f.hint}`);
  for (const [role, value] of Object.entries(s.artifacts ?? {})) {
    const p = artifactPath(value);
    if (p) slot(`${role}: ${p}`);
  }
  // A snapshot failure's `current` IS the screenshot at the moment of failure —
  // a second capture would show a different screen than the one that was
  // diffed — so the three roles above stand in for the `screenshot:` line.
  const isSnapshotShot = artifactPath(s.artifacts?.current) !== undefined;
  if (f.screenshot && !isSnapshotShot) slot(`screenshot: ${f.screenshot}`);
  else if (!f.screenshot && f.environmental) {
    // Say it explicitly rather than silently omitting the line: on a launch
    // failure the missing screenshot IS information.
    slot("screenshot: (unavailable — the device did not return an image)");
  }
  if (f.tree) slot(`tree: ${f.tree}`);
  return lines;
}

/**
 * The failure blocks, rendered AFTER the step list and BEFORE the summary so
 * the verdict stays the last line an operator (or a CI log tail) sees.
 *
 * Returns nothing when no step carries a `failure`: `ok: false` does not imply
 * a failing step — a cancelled run fails the verdict with every step pass/skip
 * — and a pre-diagnostics tool-server sends no failure objects at all.
 *
 * The block is a slot system, not a template. `code: message` is mandatory;
 * every other line appears only if that failure has something to put in it,
 * which is what lets one renderer serve a missing selector, a text mismatch, a
 * snapshot diff, a failed launch and an unreadable screen.
 */
export function renderFailures(report: FlowReport): string[] {
  const steps = Array.isArray(report.steps) ? report.steps : [];
  const ordinals = new Map<number, number>();
  let n = 0;
  for (let i = 0; i < steps.length; i++) {
    if (steps[i]!.kind === "echo") continue;
    ordinals.set(i, ++n);
  }
  const blocks: string[][] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    if (!s.failure || !ordinals.has(i)) continue;
    const f = normalizeFailure(s.failure, { flow: s.flow ?? report.flow, device: report.device });
    if (!f) continue;
    blocks.push(renderFailureBlock(report, steps, ordinals, i, f));
  }
  if (blocks.length === 0) return [];
  const lines = ["", "Failures:"];
  for (const block of blocks) lines.push("", ...block);
  return lines;
}

/** True when a run's failure is "argent could not see the screen", not "the check failed". */
export function hasIndeterminateFailure(report: FlowReport): boolean {
  return (report.steps ?? []).some(
    (s) =>
      s.failure !== undefined &&
      normalizeFailure(s.failure, { flow: s.flow ?? report.flow, device: report.device })
        ?.determinacy === "indeterminate"
  );
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
 * Copy a run's durable evidence into a stable, globbable location under
 * `--output`:
 *
 * - each failed snapshot's roles as `<outputDir>/<flow>/<key>-<role>.png`,
 *   where `<key>` is the snapshot's baseline key (`name__platform-WxH`), so a
 *   run that hits several flows/snapshots can't clobber itself;
 * - the failing step's screenshot and element dump as
 *   `<outputDir>/<flow>/step-NN-screen.png` / `step-NN-tree.txt`, where `NN`
 *   is the step's display ordinal. That stem is CLI-generated rather than wire
 *   data, and deliberately distinct from the snapshot names so anyone globbing
 *   the existing ones is unaffected.
 *
 * This is the only place the CLI needs artifact bytes, so materialization
 * happens here, scoped to the specific artifacts being copied — a co-located
 * tool-server resolves them in place, a remote one downloads just these files,
 * and a run without `--output` fetches nothing at all. Each copied handle's
 * path is rewritten in the report so the renderers and `--json` print the
 * durable location instead of a temp path. Best-effort per file — a copy error
 * warns on stderr and leaves the source path in place; artifact export must
 * never change a run's verdict. Server-supplied names that fail
 * `SAFE_ARTIFACT_NAME` are skipped the same way — before any materialization,
 * so nothing is downloaded for a step that won't be written.
 */
export async function exportRunArtifacts(
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
  const dir = path.join(outputDir, report.flow);

  /**
   * Copy one materialized source path to `<dir>/<name>`, rewriting the report
   * on success. The `path.relative` check runs on EVERY destination, including
   * the CLI-generated ones: it is the backstop that keeps the copy inside
   * `--output` even if a name pattern above is ever weakened.
   */
  const copyInto = async (source: unknown, name: string): Promise<string | undefined> => {
    if (typeof source !== "string") return undefined; // null = failed materialization
    const dest = path.join(dir, name);
    const rel = path.relative(outputDir, dest);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
    try {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.copyFile(source, dest);
      return dest;
    } catch (err) {
      console.error(
        `warning: could not write ${dest}: ${err instanceof Error ? err.message : String(err)}`
      );
      return undefined;
    }
  };

  let ordinal = 0;
  for (const s of report.steps) {
    if (s.kind !== "echo") ordinal++;
    if (s.kind === "snapshot" && s.status === "fail" && s.artifacts) {
      // Key first: a legacy tool-server sends plain path strings, and
      // keyFromBaselinePath needs that original baseline path, not a rewrite.
      // The pattern check also hardens the fallback, whose basename can still
      // be ".." for a path ending in "/..".
      const key = s.snapshotKey ?? keyFromBaselinePath(s.artifacts);
      if (key && SAFE_ARTIFACT_NAME.test(key)) {
        // Materialize only this snapshot's artifacts — never the whole report.
        const { result } = await materializeArtifacts(s.artifacts, ctx);
        s.artifacts = result as Record<string, unknown>;
        for (const [role, value] of Object.entries(s.artifacts)) {
          const dest = await copyInto(value, `${key}-${role}.png`);
          if (dest) s.artifacts[role] = dest;
        }
      }
    }
    const failure = s.failure;
    if (!failure || (failure.screenshot === undefined && failure.tree === undefined)) continue;
    const stem = `step-${String(ordinal).padStart(2, "0")}`;
    // Scoped to just these two handles, for the same reason as above.
    const { result } = await materializeArtifacts(
      { screenshot: failure.screenshot, tree: failure.tree },
      ctx
    );
    const evidence = result as { screenshot?: unknown; tree?: unknown };
    const screenshot = await copyInto(evidence.screenshot, `${stem}-screen.png`);
    failure.screenshot = screenshot ?? evidence.screenshot;
    const tree = await copyInto(evidence.tree, `${stem}-tree.txt`);
    failure.tree = tree ?? evidence.tree;
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
    if (s.artifacts && typeof s.artifacts === "object") {
      for (const [role, value] of Object.entries(s.artifacts)) {
        if (isArtifactHandle(value)) s.artifacts[role] = value.hostPath ?? value.filename;
      }
    }
    // The failure block's screenshot/tree are handles too, and the same
    // economy applies: the CLI prints their paths, never their bytes.
    if (s.failure) {
      if (isArtifactHandle(s.failure.screenshot)) {
        s.failure.screenshot = s.failure.screenshot.hostPath ?? s.failure.screenshot.filename;
      }
      if (isArtifactHandle(s.failure.tree)) {
        s.failure.tree = s.failure.tree.hostPath ?? s.failure.tree.filename;
      }
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
    if (s.warning) lines.push(renderUnderStepLine(s, n, `⚠ ${s.warning}`));
    if (s.artifacts && typeof s.artifacts === "object") {
      for (const [k, v] of Object.entries(s.artifacts)) {
        if (typeof v === "string") lines.push(renderUnderStepLine(s, n, `${k}: ${v}`));
      }
    }
  }
  // After the step list, before the summary — the verdict stays the last line.
  lines.push(...renderFailures(report));
  lines.push(`\n${renderSummary(report)}`);
  return lines.join("\n");
}

/**
 * Write every `--reporter junit:<path>` file. A write failure warns on stderr
 * and does NOT change the verdict: argent already holds that artifact export
 * never changes a run's result, and failing a build on argent's own I/O turns
 * the reporter into a source of CI flake — the exact thing it exists to
 * eliminate. The path is taken literally as given; `--output` never
 * reinterprets it.
 */
async function writeReporterFiles(
  report: FlowReport,
  specs: string[],
  // `--platform` is the only run metadata the report itself doesn't carry
  // (the runner reports the resolved device, not the platform it narrowed to).
  meta: { platform?: string }
): Promise<void> {
  for (const spec of specs) {
    // Already validated in parseRunArgs; a throw here would mean the two
    // disagree, and the run has completed either way.
    let parsed;
    try {
      parsed = parseReporterSpec(spec);
    } catch {
      continue;
    }
    if (parsed.format !== "junit") continue;
    const dest = path.resolve(parsed.path);
    try {
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, buildJUnitXml(report, meta), "utf8");
    } catch (err) {
      console.error(
        `warning: could not write report ${dest}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
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
    await exportRunArtifacts(report, path.resolve(args.output), {
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
    // the prerequisite note, materialized artifact paths, the failure blocks,
    // and the summary.
    if (report.executionPrerequisite) console.log(`  assumes: ${report.executionPrerequisite}`);
    for (const line of renderArtifactLines(report)) console.log(line);
    for (const line of renderFailures(report)) console.log(line);
    console.log(`\n${renderSummary(report, { withDevice: true })}`);
  } else {
    console.log(renderReport(report));
  }

  await writeReporterFiles(report, args.reporter, { platform: args.platform });

  // After the summary, on stderr: an indeterminate failure is the one case
  // where the verdict alone misleads. The status is still `fail` (a distinct
  // glyph would desync the counters, the exit code and the block), so the
  // distinction has to be said in words.
  if (hasIndeterminateFailure(report)) {
    console.error(`note: ${INDETERMINATE_HINT}`);
  }
  // One line, only where it pays: in CI the device is gone by the time anyone
  // reads the log, and --output is the only way the evidence survives. Never
  // written automatically — that would put files in the user's repo.
  if (!report.ok && !args.output && isCi()) {
    console.error(
      "note: re-run with --output <dir> to keep the failure screenshot, element dump and snapshot diffs as CI artifacts"
    );
  }

  return exitAfterFlush(report.ok ? 0 : 1);
}
