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
import { isCi } from "@argent/telemetry";
import { FlagParseException } from "./flag-parser.js";
import {
  artifactPath,
  buildJUnitDocument,
  candidateRows,
  formatDuration,
  INDETERMINATE_HINT,
  nodeRow,
  normalizeFailure,
  parseReporterSpec,
  secretArtifactWarning,
  stepLabel,
  wireText,
  type JUnitRun,
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
   * A step that passed in a way that weakens it as proof — raised today by
   * `await: { idle: true }`, which never fails a run and says here what its
   * green actually bought (see StepReport.warning in the tool-server's
   * flow-run). Also carries the caveat older tool-servers put on a snapshot
   * that adopted a missing baseline, which now fails the step instead. Live
   * either way: dropping the field would silently delete the only thing the
   * readiness check reports.
   */
  warning?: string;
  tool?: string;
  flow?: string;
  message?: string;
  /** Human-readable step target (selector / snapshot name), set by the runner. */
  target?: string;
  /**
   * Nesting depth: absent/0 at top level, +1 inside each nesting step
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
  --output <dir>         Also write failure evidence (screenshot, element dump)
                         and failed snapshot images (baseline/current/diff)
                         under <dir>/<flow>/ — a stable path for CI artifact
                         upload; a directory run keys nested flows as
                         <dir>/<subdir>/<flow>/. A different flow file with the
                         same filename sharing <dir> exports to <flow>-<pathhash>/
                         instead (with a warning), so no flow's evidence is
                         overwritten
  --reporter <spec>      Extra report output, repeatable: \`default\` (the terminal
                         output, always on) or \`junit:<path>\` to write JUnit XML —
                         one <testsuite> per flow, so a directory run writes every
                         flow it ran into the single file named here
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
  argent flow run checkout --output flow-artifacts --reporter junit:flow-artifacts/junit.xml
`);
}

export function parseRunArgs(argv: string[]): {
  /**
   * The positional argument exactly as supplied — a saved-flow name, a YAML
   * path, or a directory path. Which of the three it is, is resolveFlowRef's
   * and the directory stat's call; this parser only shuffles tokens and never
   * inspects one.
   */
  flowRef?: string;
  device?: string;
  platform?: string;
  output?: string;
  updateBaselines: boolean;
  recursive: boolean;
  json: boolean;
  jsonStream: boolean;
  /**
   * Raw `--reporter` specs, in the order given. Always present (never
   * optional) so the parsed shape is the same object every time, whether or
   * not the flag was passed.
   */
  reporter: string[];
} {
  const out = {
    updateBaselines: false,
    recursive: false,
    json: false,
    jsonStream: false,
    reporter: [],
  } as ReturnType<typeof parseRunArgs>;
  // Positionals are collected through one helper so the end-of-options marker
  // below cannot drift from the ordinary path in what it accepts.
  const takePositional = (tok: string): void => {
    if (out.flowRef !== undefined) {
      throw new FlagParseException(
        `unexpected argument ${JSON.stringify(tok)}; flow run accepts one flow name, YAML file path, or directory path`
      );
    }
    out.flowRef = tok;
  };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    // End of options, as flag-parser.ts (`argent run` / `argent tools`) already
    // honors it. The flow-name charset admits a leading "-", so `-dash` is a
    // legal saved-flow name that every argv parser reads as a flag; without
    // this marker such a flow would be addressable by path only, and the "a
    // name is exactly what the contract accepts" promise would have a hole.
    if (tok === "--") {
      for (const rest of argv.slice(i + 1)) takePositional(rest);
      break;
    }
    if (!tok.startsWith("-")) {
      takePositional(tok);
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
    } else if (flag === "--json-stream") {
      noValue("--json-stream");
      out.jsonStream = true;
    } else if (flag === "--recursive" || flag === "-r") {
      // Bare `-r` never carries an inline value (the `=` split applies to
      // `--` tokens only), so noValue guards just the long form.
      noValue("--recursive");
      out.recursive = true;
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
  if (out.json && out.jsonStream) {
    throw new FlagParseException("--json and --json-stream cannot be combined");
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
  // device, so its summary carries the device instead — the one the run
  // STARTED on: a chromium run can move onto runner-booted instances, each
  // move marked on its launch step's reason, so "on <id>" would blame the
  // wrong instance for any step that ran after a move. Empty when the flow
  // needed no device.
  const where = opts.withDevice && report.device ? ` (started on ${report.device})` : "";
  // Four zeros on a passing run read as though nothing happened. Say why:
  // narration is not counted, so a flow of only narration counts nothing.
  // Only on a pass — on a failure the counts are not what needs explaining.
  const nothingCounted =
    report.ok && report.passed + report.failed + report.errored + report.skipped === 0;
  const note = nothingCounted ? " (no test steps)" : "";
  // A cancelled run can fail with every step pass/skip — say so, or the
  // verdict contradicts the counters it is printed next to.
  const cancelled = report.aborted ? " (run cancelled)" : "";
  return `${report.ok ? "PASS" : "FAIL"}${cancelled}${where} — ${report.passed} passed, ${report.failed} failed, ${report.errored} errored, ${report.skipped} skipped${warningsNote}${note}`;
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
  // One hint, never two. Every indeterminate producer already sets a hint that
  // says "this is not a failed assertion" in words specific to WHICH tier
  // failed, so the generic line is a fallback for a producer that sent none —
  // printing both put two near-identical sentences back to back on exactly the
  // failure shape that most needs to read clearly.
  if (f.hint) slot(`hint: ${f.hint}`);
  else if (f.determinacy === "indeterminate") slot(`hint: ${INDETERMINATE_HINT}`);
  for (const [role, value] of Object.entries(s.artifacts ?? {})) {
    const p = artifactPath(value);
    // The KEY is wire data too — clamping only the value beside it left a
    // server free to put escape sequences in the label.
    const label = wireText(role, 64);
    if (p && label) slot(`${label}: ${p}`);
  }
  // A snapshot failure's `current` IS the screenshot at the moment of failure —
  // a second capture would show a different screen than the one that was
  // diffed — so the three roles above stand in for the `screenshot:` line.
  // That stands in for a PATH only: an omission note is prose about a capture
  // that was never taken, and a snapshot step swallowed it entirely, so the one
  // shape where the screen still leaves the machine said nothing about it.
  const isSnapshotShot = artifactPath(s.artifacts?.current) !== undefined;
  if (f.screenshot && (f.screenshotOmitted !== undefined || !isSnapshotShot)) {
    slot(`screenshot: ${f.screenshot}`);
  } else if (!f.screenshot && f.environmental) {
    // Say it explicitly rather than silently omitting the line: on a launch
    // failure the missing screenshot IS information.
    slot("screenshot: (unavailable — the device did not return an image)");
  }
  const secretWarning = secretArtifactWarning(s, f);
  if (secretWarning) slot(secretWarning);
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
export function renderFailures(report: FlowReport, flowFile?: string): string[] {
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
    // The resolved path names the ROOT flow's file, so it applies only to a
    // step of that flow. A nested fragment's step keeps the derived guess —
    // naming checkout.yaml for a step marked [login] is worse than a
    // convention path.
    const stepFlow = s.flow ?? report.flow;
    const f = normalizeFailure(s.failure, {
      flow: stepFlow,
      device: report.device,
      ...(stepFlow === report.flow ? { flowFile } : {}),
    });
    if (!f) continue;
    blocks.push(renderFailureBlock(report, steps, ordinals, i, f));
  }
  if (blocks.length === 0) return [];
  const lines = ["", "Failures:"];
  for (const block of blocks) lines.push("", ...block);
  return lines;
}

/** True when a run's failure is "argent could not see the screen", not "the check failed". */
function hasIndeterminateFailure(report: FlowReport): boolean {
  return (Array.isArray(report.steps) ? report.steps : []).some(
    (s) =>
      s.failure !== undefined &&
      normalizeFailure(s.failure, { flow: s.flow ?? report.flow, device: report.device })
        ?.determinacy === "indeterminate"
  );
}

/**
 * Batch mode prints only what needs attention: each fail/error step with its
 * under-lines, numbered by walking the full step list so the numbers match a
 * single-mode rerun of the same flow.
 *
 * A PASSING step carrying a warning needs attention too. `await: { idle: true }`
 * only ever warns on a step that passed, and renderSummary counts every warning
 * whatever its status — so skipping those here printed "1 warning" with the
 * text nowhere on screen, which is the whole of what the step reports.
 */
export function renderFailedSteps(report: FlowReport): string[] {
  const lines: string[] = [];
  let n = 0;
  for (const s of report.steps) {
    if (s.kind === "echo") continue;
    n++;
    if (s.status !== "fail" && s.status !== "error" && !s.warning) continue;
    lines.push(renderStepLine(s, n, report.flow));
    if (s.warning) lines.push(renderUnderStepLine(s, n, `⚠ ${s.warning}`));
    if (s.artifacts && typeof s.artifacts === "object") {
      for (const [k, v] of Object.entries(s.artifacts)) {
        if (typeof v === "string") lines.push(renderUnderStepLine(s, n, `${k}: ${v}`));
      }
    }
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
 * Where flows are saved, relative to the current directory: what `flow list`
 * walks, and what a bare name on `flow run` resolves against.
 */
const FLOWS_DIR = path.join(".argent", "flows");

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
 * place" apart from "a different flow's evidence, keep out". Creating this
 * file with O_EXCL is also the act of claiming (see takeExportDir), so the
 * marker can never end up naming one flow while the directory holds another's
 * bytes.
 */
const EXPORT_SOURCE_MARKER = ".argent-flow-source";

/**
 * An O_EXCL create publishes the marker's path one syscall before its
 * contents, so a reader arriving inside that window sees an existing but empty
 * file. That is the only way a freshly written marker reads as empty, and
 * concluding "names nobody" there would send a concurrent run of the *same*
 * flow off to a hash-suffixed sibling for no reason. So an empty read is
 * retried a handful of times — ~20ms, paid only inside that window — before
 * the marker is written off as illegible.
 */
const MARKER_READ_RETRIES = 4;
const MARKER_READ_DELAY_MS = 5;

/**
 * Read a directory's ownership marker: the resolved flow path that claimed it,
 * `undefined` when there is no readable marker file (an absent directory
 * included — the caller tells those apart), or null when the file is there but
 * names nobody.
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
 * read: free to claim (absent, or pre-created but empty — `mkdir -p` before
 * the run is an ordinary CI step, and an empty directory holds nothing to
 * protect), already this flow's own (the marker names `flowPath`), or foreign
 * — owned by a different YAML path (`owner` is that path) or holding content
 * that proves no owner (`owner` is null: operator files, an export from a
 * pre-marker CLI, an illegible marker, or a directory that cannot even be
 * listed — emptiness can't be proven, and redirecting is the safe direction).
 * One classifier serves the pretty stem directory and every hash-suffixed
 * fallback alike, so the two can never drift apart in what they refuse to
 * overwrite. "free" is a snapshot, never a reservation: two processes reading
 * at the same instant both get it, so taking the directory is a second,
 * atomic step (takeExportDir) and only its verdict is binding.
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
        return { state: "free" }; // no directory yet — free to claim
      }
      // Unlistable (permissions, or a plain file squatting on the name):
      // emptiness can't be proven, so fall through to the foreign path.
    }
    owner = null;
  }
  // Identity is the resolved path string: the CLI resolved it against cwd, so
  // one file always maps to one spelling within a checkout. (Two symlink
  // spellings of one file would split into two directories — a redirect, not
  // a loss.)
  return owner === flowPath ? { state: "mine" } : { state: "foreign", owner };
}

/** The clause explaining why a candidate directory could not be taken. */
function occupiedBy(owner: string | null): string {
  return owner === null
    ? "already holds files from an unknown source"
    : `already holds artifacts from ${owner}`;
}

/**
 * Take `dir` for `flowPath`. Creating the marker with O_EXCL *is* the claim,
 * so however many processes race for one directory, exactly one wins the
 * create. Returns null once the directory is this flow's (it then exists and
 * holds the marker), or the clause explaining why it isn't.
 *
 * Classification alone cannot decide this: between `classifyExportDir` reading
 * "free" and the first artifact landing there sits a window in which another
 * process classifies the same directory "free" too — both the pre-created-empty
 * and the ENOENT branch race — and both then write into it. The loser's bytes
 * end up under the winner's marker, which is worse than a plain overwrite: a
 * later, perfectly ordinary run of the flow the marker names classifies that
 * directory "mine" and overwrites it without a warning, destroying evidence it
 * never produced.
 *
 * EEXIST means the create lost — either to a racing process or to this flow's
 * own marker from an earlier run (the expected `mine` path). Judge the marker
 * that is actually there now: our own path is genuinely ours, anything else is
 * reported exactly like a classify-time `foreign` verdict so the caller
 * escalates to the next candidate.
 *
 * Any other error (unwritable directory, full or read-only filesystem) leaves
 * the claim unproven, and an unproven claim must never be written into — it is
 * reported like an occupant so the caller steps past to a candidate it can
 * actually take. The pre-claim code wrote the marker best-effort and copied in
 * regardless, which was tolerable only while the marker was a hint; now that it
 * is the claim, a silent failure would put unowned bytes in a shared directory.
 */
async function takeExportDir(dir: string, flowPath: string): Promise<string | null> {
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, EXPORT_SOURCE_MARKER), `${flowPath}\n`, { flag: "wx" });
    return null; // won the create — the directory is ours
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      return `could not be claimed (${err instanceof Error ? err.message : String(err)})`;
    }
  }
  // undefined = the marker vanished under us, or `dir` is a plain file (which
  // is what made mkdir itself EEXIST): unprovable either way, so foreign.
  const owner = await readExportMarker(dir);
  return owner === flowPath ? null : occupiedBy(owner ?? null);
}

/**
 * Claim the subdirectory under `--output` for this flow's artifacts and return
 * its name, or null when nothing can be claimed without destroying someone
 * else's. The filename stem when it is free or already claimed by this same
 * YAML file; otherwise `<stem>-<prefix>` where the prefix is a growing slice
 * (8, then 16, … up to all 64 hex chars) of the sha256 of the resolved flow
 * path. Every candidate — fallbacks included — passes the same occupancy check
 * as the stem (see classifyExportDir) and is then taken atomically (see
 * takeExportDir): a foreign directory, or one another process wins first, is
 * stepped past to the next longer prefix, never written into. On return the
 * chosen directory exists and holds this flow's marker, so the caller only has
 * to copy. The ladder is a pure function of the flow path, so a re-run walks
 * the same rungs and lands back in the directory its previous run claimed (CI
 * references survive) — unless an earlier rung's foreign occupant was deleted
 * in between, in which case the re-run claims that now-free earlier rung and
 * its old directory goes stale (a redirect, never an overwrite). Two distinct
 * paths can never share the full 64-char hash, so escalation terminates without
 * randomness. If even the full-hash directory cannot be taken (only possible
 * when something else squats on it), returns null after a warning: the caller
 * skips this flow's export, because losing one export beats destroying another
 * flow's evidence. Each warning names the directory actually being avoided and
 * the directory the artifacts actually land in (or that nothing is written at
 * all). Both name forms are single FLOW_NAME_PATTERN-charset segments
 * (validated stem + hex), so containment under outputDir is preserved for every
 * candidate. What it creates: the directory it returns, holding this flow's
 * marker — plus, only where the filesystem refused the marker after the mkdir
 * had succeeded, an empty directory it then stepped past. Creating is the whole
 * point (the marker *is* the claim), so this must be reached only once a byte
 * is certain to be copied — see the lazy claim in exportFailureArtifacts.
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
    // losing it reads exactly like a classify-time foreign verdict, so both
    // escalate — and warn — through the same path.
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
 * Copy a run's durable evidence into a stable, globbable location under
 * `--output`:
 *
 * - each failed snapshot's roles as `<outputDir>/<flow>/<key>-<role>.png`,
 *   where `<flow>` is the YAML filename stem (derived from the CLI-resolved
 *   `flowPath`, never from the wire report) and `<key>` is the snapshot's
 *   baseline key (`name__platform-WxH`), so a run that hits several
 *   flows/snapshots can't clobber itself;
 * - the failing step's screenshot and element dump as
 *   `<outputDir>/<flow>/step-NN-screen.png` / `step-NN-tree.txt`, where `NN`
 *   is the step's display ordinal. That stem is CLI-generated rather than wire
 *   data, and deliberately distinct from the snapshot names so anyone globbing
 *   the existing ones is unaffected.
 *
 * Stems are
 * unique only per directory, not globally, so when a different flow file
 * already owns `<flow>/` (see EXPORT_SOURCE_MARKER) this run lands in the
 * deterministic `<flow>-<pathhash>/` instead — one suite's CI evidence must
 * never silently replace another's, while a re-run of the same file still
 * overwrites in place. The fallback gets the same occupancy check as the
 * stem, escalating to longer hash prefixes when it too is taken — and when
 * nothing at all can be claimed, this flow's export is skipped with a
 * warning rather than ever overwriting. The destination is claimed atomically
 * (claimExportDirName) before a single byte is copied, so two suites racing
 * into one `--output` cannot both take one directory — and never earlier than
 * that first byte, so a run that copies nothing (a clean pass, an unusable
 * key, every download failed) leaves `--output` exactly as it was: no
 * directory, no marker, no collision warning about a write that never happens.
 * What that does NOT fix, by design: two parallel runs of the *same* flow file
 * into one `--output` still overwrite each other's identical-key artifacts,
 * exactly as before any of this ownership machinery existed — one file's runs
 * are indistinguishable to a separate process, and the directory's marker names
 * them truthfully either way. This is the only place the CLI needs artifact
 * bytes, so materialization happens here, scoped to the specific artifacts
 * being copied — a co-located tool-server resolves them in place, a remote one
 * downloads just these files, and a run without `--output` fetches nothing at
 * all. Each copied handle's path is rewritten in the report so the renderers
 * and `--json` print the durable location instead of a temp path.
 * Failure-only: a clean pass carries no artifacts, and a seeded baseline is
 * already durable under `__baselines__/`. Best-effort per file — a copy error
 * warns on stderr and leaves the source path in place; artifact export must
 * never change a run's verdict. Server-supplied names that fail
 * `SAFE_ARTIFACT_NAME` are skipped the same way — before any materialization,
 * so nothing is downloaded for a step that won't be written.
 */
export async function exportRunArtifacts(
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
  // Claimed lazily, at the first byte actually about to be copied — null until
  // then, because nothing earlier proves a byte will land at all: a clean pass
  // carries no failed snapshot, a failed snapshot can carry no usable key, and
  // a step past both of those filters still writes nothing when its artifacts
  // object is empty or every role came back null (the realistic one: the
  // downloads failed). Claiming for any of them would leave a directory and a
  // marker behind for a run holding no artifacts — and the marker is not inert:
  // it makes the stem foreign to every *other* flow file from then on, so the
  // next one redirects itself to a hash sibling, and a reused --output collects
  // one more empty directory per zero-byte run. Claiming late is exactly as
  // race-free as claiming early: the atomicity is O_EXCL's, not the ordering's,
  // and the marker still precedes the first byte.
  let dir: string | null = null;
  // Set when the claim was attempted and refused. claimExportDirName has
  // already warned by then, so every later copy in this run gives up silently
  // rather than re-warning once per artifact — and, as before, the sources
  // stay in place and the verdict is untouched.
  let claimRefused = false;

  /**
   * Copy one materialized source path to `<dir>/<name>`, returning the
   * destination on success. Claims the export directory on the first byte
   * actually about to land (see `dir` above). The `path.relative` check runs
   * on EVERY destination, including the CLI-generated ones: it is the backstop
   * that keeps the copy inside `--output` even if a name pattern above is ever
   * weakened.
   */
  const copyInto = async (source: unknown, name: string): Promise<string | undefined> => {
    if (typeof source !== "string") return undefined; // null = failed materialization
    if (claimRefused) return undefined;
    if (dir === null) {
      const dirName = await claimExportDirName(outputDir, flowPath, stem);
      if (dirName === null) {
        claimRefused = true;
        return undefined;
      }
      // Claimed: the directory exists and holds this flow's marker. Nothing
      // below re-creates it — if it is deleted mid-run the copies fail and
      // warn, rather than resurrecting it unmarked for the next run to
      // redirect away from.
      dir = path.join(outputDir, dirName);
    }
    const dest = path.join(dir, name);
    // Same resolved-path check as the server's getFlowPath: even if the key
    // and stem patterns are ever weakened, the copy stays inside --output. Also
    // covers `role`, the remaining server-supplied piece of the destination.
    // It judges the real destination, so it can only run once `dir` is known,
    // i.e. after the claim: a `role` hostile enough to escape is the single
    // way a claim can still precede zero bytes — a broken or malicious
    // tool-server, never an ordinary run.
    const rel = path.relative(outputDir, dest);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
    try {
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
    // Read BEFORE the snapshot branch below rewrites `s.artifacts`: on a
    // snapshot failure the producer deliberately reuses the `current` handle as
    // `failure.screenshot` (a second capture would show a different screen than
    // the one diffed), so the two name ONE image and must not be exported as
    // two md5-identical files.
    const reusesSnapshotImage = sameArtifact(s.artifacts?.current, s.failure?.screenshot);
    if (s.kind === "snapshot" && s.status === "fail" && s.artifacts) {
      // Key first: a legacy tool-server sends plain path strings, and
      // keyFromBaselinePath needs that original baseline path, not a rewrite.
      // The pattern check also hardens the fallback, whose basename can still
      // be ".." for a path ending in "/..".
      const key = s.snapshotKey ?? keyFromBaselinePath(s.artifacts);
      if (key && SAFE_ARTIFACT_NAME.test(key)) {
        // Materialize only this snapshot's artifacts (local read or remote
        // download) — never the whole report.
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
    // Named `stepStem` rather than `stem`: that name is already the flow
    // filename stem this export is keyed by, and shadowing it here would read
    // as the same value.
    const stepStem = `step-${String(ordinal).padStart(2, "0")}`;
    // Scoped to just these two handles, for the same reason as above — and the
    // screenshot is dropped from the request entirely when the snapshot branch
    // has already exported the same image, so a remote run does not download
    // the same bytes twice either.
    const { result } = await materializeArtifacts(
      {
        ...(reusesSnapshotImage ? {} : { screenshot: failure.screenshot }),
        tree: failure.tree,
      },
      ctx
    );
    const evidence = result as { screenshot?: unknown; tree?: unknown };
    if (reusesSnapshotImage) {
      // Point at the copy the snapshot branch just made, under its own key.
      failure.screenshot = s.artifacts?.current;
    } else {
      const screenshot = await copyInto(evidence.screenshot, `${stepStem}-screen.png`);
      failure.screenshot = screenshot ?? evidence.screenshot;
    }
    const tree = await copyInto(evidence.tree, `${stepStem}-tree.txt`);
    failure.tree = tree ?? evidence.tree;
  }
}

/**
 * Whether two wire artifact values name the SAME stored artifact. Compared by
 * id rather than by reference: the report arrives as parsed JSON, so the
 * producer's one handle has become two structurally-equal objects by the time
 * it gets here. A legacy tool-server sends plain path strings, which compare
 * directly.
 */
function sameArtifact(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return false;
  if (typeof a === "string" || typeof b === "string") return a === b;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const id = (a as Record<string, unknown>).id;
  return typeof id === "string" && id === (b as Record<string, unknown>).id;
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

export function renderReport(report: FlowReport, flowFile?: string): string {
  const lines: string[] = [];
  lines.push(`Flow "${report.flow}"${report.device ? ` on ${report.device}` : ""}`);
  // Remind the operator what the flow assumes was already set up.
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
  lines.push(...renderFailures(report, flowFile));
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

/**
 * The YAML path a `flow run` argument addresses: a saved-flow name becomes
 * `.argent/flows/<name>.yaml`, anything else is already a path and is handed
 * back untouched.
 *
 * The two forms cannot collide, so nothing here has to guess. A name is
 * exactly what the flow-name contract accepts (SAFE_FLOW_NAME — a charset with
 * no separator and no dot, so a name can carry no directory and no extension),
 * while a runnable path must end in `.yaml`. The token that looks ambiguous,
 * `checkout.yaml`, carries an extension and is therefore a path, resolved from
 * the current directory like every other one — it does NOT fall back to the
 * flows directory.
 *
 * Deciding this lexically rather than by probing the filesystem is deliberate:
 * an argument's meaning must not depend on which files happen to exist, or a
 * stray `./checkout.yaml` appearing next to a CI checkout would silently
 * re-point a `run checkout` that had been reading `.argent/flows` for months.
 *
 * What contains this join is the charset itself, not the guards below: no
 * string SAFE_FLOW_NAME admits can carry a separator or a dot, so the joined
 * path cannot leave `.argent/flows` however the guards are later edited. The
 * rewrite is nevertheless relative and placed before all of them, so a name
 * takes no shortcut past a check a typed-out path faces. Four of those checks
 * ("..", trailing separator, extension, stem charset) a name satisfies
 * vacuously; the two that bite are the filesystem ones — the file must exist
 * and be readable, and its basename must appear in the directory listing
 * byte-for-byte, so a name is refused on a case-insensitive filesystem exactly
 * where a path is (see savedFlowHint, which owes its on-disk spelling to that
 * same rule).
 *
 * Relative also keeps downstream messages quoting something the user can paste
 * back, and leaves `path.resolve(projectRoot, …)` landing on the very same
 * absolute file the spelled-out path resolves to. That last part is the point:
 * the absolute path keys the report, `__baselines__/`, and the `--output`
 * export directory, so `run checkout` and `run .argent/flows/checkout.yaml`
 * are one run under one identity, not two that split their baselines and CI
 * evidence.
 *
 * One name shape the CLI cannot address, though the contract admits it: a
 * leading "-" makes the token a flag to any argv parser, so `-dash` is
 * reachable only as `-- -dash` (parseRunArgs honors the end-of-options marker)
 * or by path.
 */
function resolveFlowRef(ref: string): { suppliedPath: string; fromName: boolean } {
  if (!SAFE_FLOW_NAME.test(ref)) return { suppliedPath: ref, fromName: false };
  return { suppliedPath: path.join(FLOWS_DIR, `${ref}.yaml`), fromName: true };
}

/**
 * Recovery for a path that named nothing while a flow of that very stem IS
 * saved — `argent flow run checkout.yaml` typed at the project root, where the
 * file actually lives a directory down. It is the mistake the two-form
 * interface invites, and the one an implicit fallback would have hidden: a
 * lookup that silently reached into `.argent/flows` would make an argument's
 * meaning depend on which files exist (see resolveFlowRef), so the fallback
 * stays refused and only the message improves.
 *
 * The name it suggests comes from the directory listing, never from the user's
 * spelling, and that is the whole subtlety here. A stat-based probe would
 * match `Checkout.yaml` against an on-disk `checkout.yaml` on any
 * case-insensitive filesystem (APFS, NTFS — the common dev machines) and hand
 * back a command `run` itself then refuses at its byte-exact spelling check:
 * a hint that costs the operator a second failure and pushes them to the path
 * form for a flow that is perfectly addressable by name. Reading the entry
 * settles the spelling once, so `run Checkout.yaml` offers `run checkout` and
 * that command works first try. An entry whose own stem the flow-name contract
 * refuses (`Upper.YAML`) is no hint at all — it needs a rename, not a command
 * — and the runnability probe still runs, so the hint can never name something
 * `run` would reject downstream. A name that clears SAFE_FLOW_NAME is inside
 * SHELL_SAFE_ARG, so the suggestion needs no quoting.
 *
 * Empty when the missing path already points inside the flows directory: the
 * operator plainly knows where flows live, and a same-stem sibling elsewhere
 * in the tree (`sub/checkout.yaml` missing, top-level `checkout.yaml` present)
 * is a different flow, not the one they asked for.
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
 * Discover runnable flows under `dir`, as paths relative to it, sorted for a
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
          // Best-effort like isRunnableFlowFile: an unreadable subtree is
          // skipped so the rest of the walk still runs — only the top-level
          // readdir failure (thrown by the outer walk call) aborts discovery.
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
 * CLI runs rely on the caller and tool-server sharing a filesystem: the
 * runner resolves `run:` targets against each containing flow file's
 * directory (fragments may live across directories) and reads/writes
 * `__baselines__` beside the canonicalized root YAML — all on the tool
 * server's disk, so a remote server would resolve every one of those paths
 * on its own filesystem, not this one. Keep the flow-execute tool itself
 * remotely callable, but reject CLI routing that cannot guarantee the
 * shared filesystem. This deliberately rejects even single-file flows that
 * could run remotely — the CLI cannot tell them apart without parsing the
 * flow. Returns the refusal with its recovery hint when remote routing is
 * configured.
 */
async function requireLocalToolServer(): Promise<string | undefined> {
  const routing = await getResolvedToolsUrl();
  if (routing.source === "none") return undefined;
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

/** Write one machine-readable flow record. Each record occupies exactly one line. */
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
 * Durable evidence output: copy the failing step's screenshot and element dump
 * and any failed-snapshot images out of the tool-server's cache before any
 * renderer prints paths, so every output mode shows the durable location. The
 * only artifact bytes the CLI ever fetches; baseUrl is resolved lazily so a run
 * without --output makes no extra round-trip.
 * Whatever handles remain (all of them without --output; passing snapshots
 * and unexported roles with it) print as server-side paths.
 */
async function exportAndResolveArtifacts(
  report: FlowReport,
  outputDir: string | undefined,
  flowPath: string,
  baseUrl: ToolsClient["baseUrl"]
): Promise<void> {
  if (outputDir) {
    const { url, token } = await baseUrl();
    await exportRunArtifacts(report, outputDir, flowPath, { toolsUrl: url, authToken: token });
  }
  resolveArtifactDisplayPaths(report);
}

/**
 * A stand-in report for a flow the tool-server REJECTED before running it, so
 * it still gets a `<testsuite>`. No steps plus `ok: false` is exactly the shape
 * `junitSuite`'s `incomplete` branch exists for, which turns it into one
 * `<error>` carrying the rejection reason.
 */
function rejectedFlowReport(relPath: string): FlowReport {
  return {
    flow: path.basename(relPath, ".yaml"),
    device: "",
    ok: false,
    passed: 0,
    failed: 0,
    skipped: 0,
    errored: 0,
    steps: [],
  };
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
 * live step lines), then a flow-level summary; a flow failing its steps — or
 * one the tool-server rejects as invalid (a bad YAML, an unparseable step) —
 * lets the batch continue, while an infra error (transport throw, unclassified
 * failure, non-report result) stops it and counts the remaining flows skipped.
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
  // classify (including one from a pre-signal server) — could make every
  // remaining flow burn a device run against the same wall, so stop.
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
    // cannot clobber each other (exportRunArtifacts keys by stem only).
    await exportAndResolveArtifacts(
      report,
      outputBase ? path.join(outputBase, path.dirname(rel)) : undefined,
      path.join(dir, rel),
      baseUrl
    );
    results.push({ path: rel, status: report.ok ? "pass" : "fail", report });
    if (!args.json) {
      for (const line of renderFailedSteps(report)) console.log(line);
      // The failure block, on the invocation CI actually runs. Batch output is
      // deliberately terse, but the block is not step noise — it is the code,
      // the candidates, the screen and the paths to the evidence
      // `exportAndResolveArtifacts` has ALREADY written, which the one-line
      // reason above says nothing about.
      for (const line of renderFailures(report, path.join(dir, rel))) console.log(line);
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

  // EVERY flow the batch touched becomes a `<testsuite>`, with or without a
  // report. A flow the tool-server rejected before it ran (bad YAML, an
  // unknown step key) produces none — and filtering those out left the file
  // saying `failures="0"` for a run that exited 1, which is the one thing a
  // CI artifact must never do. An empty suite trips `junitSuite`'s own
  // `incomplete` branch, so it reports as an error carrying the real reason.
  //
  // Flows the batch SKIPPED after a hard stop are reportless too, and they used
  // to be filtered out with them: the terminal summary counted them as skipped
  // while the XML omitted them entirely and kept `skipped="0"`. They are
  // neither failures nor errors, and JUnit has `<skipped/>` for exactly this,
  // so they get a suite carrying that instead.
  const reported = results.map((r) => ({
    report: r.report ?? rejectedFlowReport(r.path),
    meta: {
      platform: args.platform,
      // The flow's real path, keyed the way the batch addressed it — a
      // recursive run has several flows and `argent.flowFile` is what tells
      // a CI reader which one a suite belongs to.
      flowFile: path.join(dir, r.path),
      ...(r.status === "skip" && r.report === undefined
        ? { notRunMessage: "not run — the batch stopped at an earlier flow" }
        : {}),
      ...(r.report === undefined && r.error !== undefined ? { incompleteMessage: r.error } : {}),
    },
  }));
  await writeReporterFiles(reported, args.reporter);

  const indeterminate = reported.some((r) => hasIndeterminateFailure(r.report));
  if (indeterminate) console.error(`note: ${INDETERMINATE_HINT}`);
  if (counts.failed > 0 && !args.output && isCi()) {
    console.error(
      "note: re-run with --output <dir> to keep the failure screenshot, element dump and snapshot diffs as CI artifacts"
    );
  }
  return exitAfterFlush(counts.failed === 0 ? 0 : 1);
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
  // Every flow the invocation ran: one on the single-flow path, N on a
  // directory run, each its own `<testsuite>` in the one file the operator
  // asked for.
  runs: JUnitRun[],
  specs: string[]
): Promise<void> {
  if (runs.length === 0) return;
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
      await fsp.writeFile(dest, buildJUnitDocument(runs), "utf8");
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

  if (sub === "list") {
    const dir = path.join(process.cwd(), FLOWS_DIR);
    try {
      // One final sort over full relative paths, not per-directory: the
      // ordering must be a pure function of the set of paths, never of the
      // walk order.
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

  // Once streaming is requested stdout belongs exclusively to NDJSON. Help
  // is still useful, but it is a diagnostic and therefore belongs on stderr.
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
  // A saved-flow name is turned into its `.argent/flows` path here and is
  // otherwise indistinguishable from a path the user typed: one set of guards,
  // one resolved identity, one run (see resolveFlowRef). `fromName` survives
  // only to aim the not-found recovery, since a name resolves somewhere the
  // user never spelled out.
  const { suppliedPath, fromName } = resolveFlowRef(args.flowRef);
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
    return fail(
      `Flow path must not contain ".." segments — they are collapsed without following symlinks, ` +
        `so the path can name a different file than the one your shell opens: ${suppliedPath}\n` +
        recovery,
      2
    );
  }
  const resolvedPath = path.resolve(projectRoot, suppliedPath);
  // Stat-first so a directory named `foo.yaml` still batches; on a failed stat
  // without -r, fall through so the single-file messages stay identical. A
  // name is not exempt: resolveFlowRef has already made it a path, and running
  // both spellings of the same target through one dispatch is what keeps `run
  // checkout` and `run .argent/flows/checkout.yaml` one run under one identity.
  let isDirectory = false;
  try {
    isDirectory = (await fsp.stat(resolvedPath)).isDirectory();
  } catch {
    // Only a spelled-out path can be missing a directory the user meant; a
    // name resolves to a .yaml file it never named, so "directory not found"
    // would quote a path they never typed. That form falls through instead.
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
  // A trailing separator asserts the path names a directory. When it does —
  // the directory dispatch above already ran — that assertion is honest (a
  // shell-completed "flows/" batches, and a path of nothing but separators
  // names the filesystem root). From here the path is a file's, so the
  // kernel would refuse to open "ok.yaml/" (ENOTDIR), yet path.resolve
  // drops the separator lexically — without this guard the CLI would stat
  // and run a file its own argument does not name — the same dishonest-path
  // class as the ".." guard above, and like it ordered before the
  // extension/stem arms so the dishonesty wins over a shape complaint.
  // Ordered after the ".." guard: when a path carries both flaws, that
  // guard's recovery (a fully resolved path) also cures the trailing
  // separator, while stripping the separator here would leave the ".."
  // standing and demand a second correction. Stripping is always the right
  // hint (unlike realpath, nothing needs to exist on disk).
  const separatorTrimmedPath = suppliedPath.replace(/[\\/]+$/, "");
  if (separatorTrimmedPath !== suppliedPath && separatorTrimmedPath !== "") {
    // Trimming "checkout/" leaves a token that now reads as a saved-flow name,
    // and offering it bare would hand back a command for a DIFFERENT file —
    // `.argent/flows/checkout.yaml` rather than the `./checkout` this argument
    // names — which, unlike the error being explained, would run. Keep the
    // hint in the form the argument was written in; the flows directory is
    // reached by asking for it, never by a recovery quietly re-pointing there.
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
    // A bare ".yaml" satisfies this too (path.extname reads it as an
    // extensionless dotfile), so that arm goes first: naming the missing stem
    // is the more precise of the two complaints.
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
    // Each form misses for its own reason, so each gets its own recovery. A
    // name is the one form whose file the user never spelled out, so a bare
    // "not found" leaves them unsure whether the flow is missing or the lookup
    // went somewhere unexpected: the resolved path in the message settles that,
    // and the listing enumerates what a name can address. A path that missed
    // may instead be a saved flow the operator addressed as if it sat in the
    // current directory — say so when it is.
    let recovery = "";
    if (code === "ENOENT") {
      recovery = fromName
        ? `\nNo flow named "${args.flowRef}" is saved there — run \`argent flow list\` to see the saved flows.`
        : await savedFlowHint(projectRoot, flowPath);
    }
    return fail(`${detail}: ${flowPath}${recovery}`, 2);
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
    // Answer in the form the operator used: someone who typed a name gets the
    // name that works, not a path into a directory they never spelled out.
    // Both are `run`-accepted spellings of the same file, and the name is
    // inside SHELL_SAFE_ARG by the check above, so neither needs quoting.
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

  // Live rendering: with a streaming server each step line prints the moment
  // the step completes. A pre-streaming server ignores the request and no
  // events fire, so `liveSteps` doubles as the mode detector — zero means the
  // buffered renderer below owns the whole report.
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
    liveIndex++;
    console.log(renderStepLine(s, liveIndex, flowName));
    if (s.warning) console.log(renderUnderStepLine(s, liveIndex, `⚠ ${s.warning}`));
  };

  /**
   * Write the reporter files for a run that produced no report at all — a flow
   * the tool-server REJECTED (bad YAML, an unknown step key), a transport
   * error, or a non-report result.
   *
   * Returning through `exitAfterFlush` without this left CI worse off than a
   * wrong file: the publisher picks up whichever `junit.xml` sits at that path,
   * which is the PREVIOUS run's, so a red build reports the last green one's
   * results. The directory path already synthesises a suite for exactly this
   * (`rejectedFlowReport`, whose comment calls a `failures="0"` file for a run
   * that exited 1 "the one thing a CI artifact must never do"); the two paths
   * simply disagreed.
   */
  const reportRejection = async (message: string): Promise<void> => {
    await writeReporterFiles(
      [
        {
          report: rejectedFlowReport(flowPath),
          meta: { platform: args.platform, flowFile: flowPath, incompleteMessage: message },
        },
      ],
      args.reporter
    );
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
    const message = err instanceof Error ? err.message : String(err);
    await reportRejection(message);
    return fail(message, 1, err);
  }

  if (!report || typeof report !== "object" || !("steps" in report)) {
    const message = `"${flowName}" did not produce a run report.`;
    await reportRejection(message);
    return fail(message, 2);
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
    // Steps already printed live — emit only what the final report knows:
    // the prerequisite note, materialized artifact paths, the failure blocks,
    // and the summary.
    if (report.executionPrerequisite) console.log(`  assumes: ${report.executionPrerequisite}`);
    for (const line of renderArtifactLines(report)) console.log(line);
    for (const line of renderFailures(report, flowPath)) console.log(line);
    console.log(`\n${renderSummary(report, { withDevice: true })}`);
  } else {
    console.log(renderReport(report, flowPath));
  }

  await writeReporterFiles(
    // `--platform` is the only run metadata the report itself doesn't carry
    // (the runner reports the resolved device, not the platform it narrowed to);
    // `flowFile` is the path this invocation actually resolved, which the wire
    // report's `flow` NAME cannot be turned back into.
    [{ report, meta: { platform: args.platform, flowFile: flowPath } }],
    args.reporter
  );

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
