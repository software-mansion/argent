import * as path from "node:path";
import * as fs from "node:fs/promises";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";
import { CLIENT_FILE_MARKER, type ClientFileDirective } from "@argent/registry";
import {
  hasVisibleText,
  selectorFieldsSchema,
  selectorSchema,
  type Selector,
  type WaitCondition,
  type TextMatchMode,
} from "../../utils/ui-tree-match";

const FLOWS_DIR_NAME = path.join(".argent", "flows");

// ── Paths ────────────────────────────────────────────────────────────

// ── Active session state ─────────────────────────────────────────────

let activeFlowName: string | null = null;
let activeProjectRoot: string | null = null;

/**
 * Where the active recording's YAML is persisted:
 * - `"host"`   — this process writes `<project_root>/.argent/flows/<name>.yaml`
 *                directly (the original behavior; correct whenever the caller's
 *                project root is on this machine).
 * - `"client"` — the caller's project root is NOT on this machine (remote
 *                tool-server). The flow lives in memory here and every mutating
 *                tool returns a {@link ClientFileDirective} so the *client*
 *                writes the YAML into the agent's project.
 */
export type FlowPersistMode = "host" | "client";

export interface RecordingSession {
  persist: FlowPersistMode;
  /**
   * Absolute path of the flow file as the CALLER knows it. A real host path in
   * "host" mode; in "client" mode it is only echoed back inside the directive
   * (it names a file on the client's machine, never touched here).
   */
  filePath: string;
  /** In-memory flow content — authoritative in "client" mode. */
  flow: FlowFile;
}

let recordingSession: RecordingSession | null = null;

export function setActiveProjectRoot(root: string): void {
  if (!path.isAbsolute(root)) {
    throw new FailureError(
      `project_root must be an absolute path (got "${root}"). ` +
        `Pass the absolute path to the project root directory — the same cwd ` +
        `the calling agent is working in.`,
      {
        error_code: FAILURE_CODES.FLOW_PROJECT_ROOT_INVALID,
        failure_stage: "flow_project_root_set",
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
  }
  // Reject ".." segments: getFlowsDir()/getFlowPath() join the flows dir under
  // this root, and path.join collapses "..", so a root like
  // "/a/../../../etc" would relocate the flows dir (and the validated flow
  // file) outside the intended project.
  if (root.split(/[\\/]+/).includes("..")) {
    throw new FailureError(`project_root must not contain ".." segments (got "${root}").`, {
      error_code: FAILURE_CODES.FLOW_PROJECT_ROOT_INVALID,
      failure_stage: "flow_project_root_dotdot",
      failure_area: "tool_server",
      error_kind: "validation",
    });
  }
  activeProjectRoot = root;
}

export function requireActiveProjectRoot(): string {
  if (!activeProjectRoot) {
    throw new FailureError(
      "No active project root. The calling flow tool must pass project_root before any path is resolved.",
      {
        error_code: FAILURE_CODES.FLOW_PROJECT_ROOT_REQUIRED,
        failure_stage: "flow_project_root_require",
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
  }
  return activeProjectRoot;
}

export function clearActiveProjectRoot(): void {
  activeProjectRoot = null;
}

export function getFlowsDir(): string {
  return path.join(requireActiveProjectRoot(), FLOWS_DIR_NAME);
}

const FLOW_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

export function assertSafeFlowName(name: string): void {
  if (!FLOW_NAME_PATTERN.test(name)) {
    throw new FailureError(
      `Invalid flow name "${name}". Flow names must match ${FLOW_NAME_PATTERN} ` +
        `(letters, digits, underscore, hyphen — no path separators, no "..", no spaces).`,
      {
        error_code: FAILURE_CODES.FLOW_NAME_INVALID,
        failure_stage: "flow_name_pattern",
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
  }
}

export function getFlowPath(name: string): string {
  assertSafeFlowName(name);
  const filePath = path.join(getFlowsDir(), `${name}.yaml`);
  // Defense-in-depth: ensure the resolved path stays inside the flows
  // directory even if the regex above is ever weakened.
  const rel = path.relative(getFlowsDir(), filePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new FailureError(`Invalid flow name "${name}": resolves outside the flows directory.`, {
      error_code: FAILURE_CODES.FLOW_NAME_INVALID,
      failure_stage: "flow_name_traversal",
      failure_area: "tool_server",
      error_kind: "validation",
    });
  }
  return filePath;
}

export function setActiveFlow(name: string): void {
  activeFlowName = name;
}

/** Begin a recording session (replacing any abandoned one). */
export function startRecordingSession(name: string, session: RecordingSession): void {
  activeFlowName = name;
  recordingSession = session;
}

export function getRecordingSession(): RecordingSession | null {
  return recordingSession;
}

function requireRecordingSession(): RecordingSession {
  if (!activeFlowName || !recordingSession) {
    throw new FailureError("No active flow. Call flow-start-recording first.", {
      error_code: FAILURE_CODES.FLOW_NO_ACTIVE_RECORDING,
      failure_stage: "flow_require_recording",
      failure_area: "tool_server",
      error_kind: "validation",
    });
  }
  return recordingSession;
}

/** Returns the active flow name, or null if none is active. */
export function getActiveFlowOrNull(): string | null {
  return activeFlowName;
}

export function getActiveFlow(): string {
  if (!activeFlowName) {
    throw new FailureError("No active flow. Call flow-start-recording first.", {
      error_code: FAILURE_CODES.FLOW_NO_ACTIVE_RECORDING,
      failure_stage: "flow_active_recording_require",
      failure_area: "tool_server",
      error_kind: "validation",
    });
  }
  return activeFlowName;
}

export function clearActiveFlow(): void {
  activeFlowName = null;
  recordingSession = null;
}

// ── Types ────────────────────────────────────────────────────────────

/**
 * A chromium `launch` target: a filesystem path to the Electron app (bare
 * string) or a path plus extra CLI args. Unlike iOS/Android/Vega (an OS-installed
 * app id relaunched in place), chromium is booted from this path, so it must
 * exist on the tool-server host; a relative path resolves against the flow
 * file's directory (the same anchor `run:` and baselines use).
 */
export type ChromiumLaunch = string | { path: string; args?: string[] };

/**
 * The app a `launch` step starts from scratch. A bare string applies to every
 * platform; the map targets a specific id per platform (chromium takes a path —
 * see {@link ChromiumLaunch}). `native` is a shared id for the installed-app
 * platforms (ios/android/vega), overridden by a specific `ios`/`android`/`vega`
 * key. A flow that BEGINS with a `launch` step is an e2e flow; one that doesn't
 * is a fragment.
 */
export type Launch =
  | string
  | {
      native?: string;
      ios?: string;
      android?: string;
      vega?: string;
      chromium?: ChromiumLaunch;
    };

/** Axis + sense a `scroll-to` step scrolls in to reveal its target. */
export type ScrollDirection = "up" | "down" | "left" | "right";

/**
 * A selector as a flow step carries it. Extends the shared {@link Selector} with
 * an internal `loose` flag, set when the selector came from bare-string sugar
 * (`tap: foo`). A loose selector resolves identifier-first, then falls back to
 * text (label/value), so a hand-written `foo` matches `testID="foo"` as well as
 * visible text. The flag is honored only by the flow runner (`flow-actions.ts`)
 * and is never serialized as a field — the YAML spelling carries it exactly:
 * bare string ⇔ loose, map form ⇔ strict (`selectorToYaml`/`parseSelector` are
 * inverses). It is never forwarded into a tool's input — explicit `{ text }` /
 * `{ id }` selectors stay strict everywhere, including across the
 * serialize/parse round-trip every recorded step performs.
 */
export type FlowSelector = Selector & { loose?: boolean };

/**
 * The platforms a `when: { platform: … }` condition can name — derived from
 * {@link LAUNCH_PLATFORMS} so the parser's runtime check and this type cannot
 * drift (flow-device's `FlowPlatform` is the same union, aliased there).
 */
export type WhenPlatform = (typeof LAUNCH_PLATFORMS)[number];

/**
 * The guard of a `when:` block. Either a UI condition — the await/assert
 * condition-as-key shapes, evaluated at run time with the short assert grace
 * (a skipped block must not add an await-sized dead wait to every clean run) —
 * or `platform`, a static per-run test against the resolved device.
 */
export type WhenCondition =
  | {
      kind: "ui";
      condition: WaitCondition;
      selector: FlowSelector;
      expectedText?: string;
      textMatch?: TextMatchMode;
    }
  | { kind: "platform"; platform: WhenPlatform };

export type FlowStep =
  | { kind: "tool"; name: string; args: Record<string, unknown>; delayMs?: number }
  | { kind: "echo"; message: string }
  | { kind: "launch"; app: Launch }
  | { kind: "run"; flow: string }
  | { kind: "when"; condition: WhenCondition; steps: FlowStep[] }
  | { kind: "tap"; selector?: FlowSelector; x?: number; y?: number; times?: number }
  | { kind: "long-press"; selector?: FlowSelector; x?: number; y?: number; duration?: number }
  | { kind: "type"; into: FlowSelector; text: string; submit?: boolean }
  | {
      kind: "await";
      condition: WaitCondition;
      selector: FlowSelector;
      expectedText?: string;
      textMatch?: TextMatchMode;
      timeout?: number;
    }
  | {
      kind: "assert";
      condition: WaitCondition;
      selector: FlowSelector;
      expectedText?: string;
      textMatch?: TextMatchMode;
    }
  | { kind: "wait"; ms: number }
  | { kind: "scroll-to"; target: FlowSelector; direction: ScrollDirection; within?: FlowSelector }
  | { kind: "snapshot"; name: string; maxMismatch?: number };

export type FlowFile = {
  /** Fragments only: documented entry-state contract. "" when unset. */
  executionPrerequisite: string;
  steps: FlowStep[];
};

/**
 * A flow is end-to-end iff it BEGINS by launching an app — its first step
 * (ignoring `echo` narration) is a `launch`. Such a flow controls its own
 * start state, so it is the natural standalone/suite entry point and must not
 * declare an `executionPrerequisite`. Everything else is a fragment.
 */
export function isE2eFlow(flow: FlowFile): boolean {
  const first = flow.steps.find((s) => s.kind !== "echo");
  return first?.kind === "launch";
}

/**
 * Resolve the launch app id for a platform, or null when none is declared. For
 * ios/android/vega a specific key wins, else the shared `native` id. For chromium
 * this returns the app *path* (not an id, and never `native`) — chromium booters
 * want {@link chromiumLaunchSpec}, which also carries the CLI args.
 */
export function appIdForPlatform(launch: Launch | undefined, platform: string): string | null {
  if (launch === undefined) return null;
  if (typeof launch === "string") return launch;
  if (platform === "chromium") {
    const c = launch.chromium;
    if (c === undefined) return null;
    return typeof c === "string" ? c : c.path;
  }
  const v = (launch as Record<string, string | undefined>)[platform];
  return v ?? launch.native ?? null;
}

/**
 * Resolve the chromium launch spec (app path + optional CLI args) a `launch`
 * step declares, or null when it declares no chromium target. A bare-string
 * launch (applies to every platform) is treated as the app path.
 */
export function chromiumLaunchSpec(
  launch: Launch | undefined
): { path: string; args?: string[] } | null {
  if (launch === undefined) return null;
  if (typeof launch === "string") return { path: launch };
  const c = launch.chromium;
  if (c === undefined) return null;
  return typeof c === "string" ? { path: c } : { path: c.path, args: c.args };
}

/**
 * A selector in YAML is sugared: a bare string is shorthand for `{ text: <string> }`
 * (the common case), and the full `{ text?, id?, role? }` map is still accepted
 * for identifier/role locators. The map form spells the internal `identifier`
 * field `id`; `identifier` is accepted on parse as an alias (so existing flow
 * files keep working) but serialization always emits `id`.
 *
 * In any selector slot, `text` may also be a regex matcher map —
 * `{ text: { matches: '<pattern>' } }` — matched against each node's own
 * label/value (internal `textMatches`; see the `Selector` type). It follows
 * the same doctrine as the `text` condition's `matches`: unanchored,
 * case-sensitive, validated at parse. In action ranking a pattern that
 * consumes a node's whole label/value counts as an exact match.
 */
type YamlSelector =
  | string
  | (Omit<Selector, "identifier" | "text" | "textMatches"> & {
      id?: string;
      text?: string | { matches: string };
    });

/**
 * A gesture target: an element (selector, possibly a bare string) or a raw
 * normalized point `{ x, y }`. Only the point-acting directives (`tap`,
 * `long-press`) accept the point form — a point can be acted on but not
 * observed, so the selector-only directives (`type`, `await`, `assert`,
 * `scroll-to`) keep taking {@link YamlSelector}.
 */
type YamlTarget = YamlSelector | { x: number; y: number };

/**
 * A tap targets an element or a raw point. The options form nests the target
 * under `on` so option keys never mix with target fields:
 * `{ on: <target>, times: 2 }` is a double-tap (`on` carries the usual
 * bare-string-loose / map-strict selector sugar).
 */
type TapBody = YamlTarget | { on: YamlTarget; times?: number };

/**
 * The condition of an `await`/`assert` step. The condition is the key, not a
 * separate `condition:` field:
 *   - `{ visible: "Account" }`            ← exists/visible/hidden take a selector
 *   - `{ visible: { text: { matches: '^x: \d+$' } } }`  ← regex text selector
 *   - `{ text: { in: "Taps:", contains: "Taps: 0" } }`  ← substring check
 *   - `{ text: { in: "Taps:", equals: "Taps: 0" } }`    ← exact-text check
 *   - `{ text: { in: "total", matches: 'Total: \$\d+' } }` ← regex check
 * Only `await` takes an optional `timeout` sibling key (milliseconds):
 *   - `{ visible: "Account", timeout: 10000 }`
 * An `assert` carrying one is rejected at parse — an assert is an immediate
 * check; a check that needs time to become true is a wait, spelled `await`.
 */
type YamlWaitCondition =
  | { exists: YamlSelector }
  | { visible: YamlSelector }
  | { hidden: YamlSelector }
  | { text: { in: YamlSelector; contains: string } }
  | { text: { in: YamlSelector; equals: string } }
  | { text: { in: YamlSelector; matches: string } };

type YamlTextWaitCondition = Extract<YamlWaitCondition, { text: unknown }>;

/** `scroll-to` body: a bare target (scrolls down), or a map with options. */
type YamlScrollBody =
  | YamlSelector
  | { target: YamlSelector; direction?: ScrollDirection; within?: YamlSelector };

/**
 * A `when:` guard body: exactly one UI condition key (the await/assert shapes,
 * no `timeout` — evaluation always uses the assert grace) or `{ platform }`.
 */
type YamlWhenBody =
  | { exists: YamlSelector }
  | { visible: YamlSelector }
  | { hidden: YamlSelector }
  | { text: { in: YamlSelector; contains: string } }
  | { text: { in: YamlSelector; equals: string } }
  | { platform: WhenPlatform };

type YamlStep =
  | { echo: string }
  | { launch: Launch }
  | { run: string }
  | { when: YamlWhenBody; steps: YamlStep[] }
  | { tool: string; args?: Record<string, unknown>; delayMs?: number }
  | { tap: TapBody }
  | { "long-press": YamlTarget | { on: YamlTarget; duration?: number } }
  | { type: { into: YamlSelector; text: string; submit?: boolean } }
  | { await: YamlWaitCondition & { timeout?: number } }
  | { assert: YamlWaitCondition }
  | { wait: number }
  | { "scroll-to": YamlScrollBody }
  | { snapshot: string | { name: string; maxMismatch?: number } };

type YamlFlowFile = {
  executionPrerequisite?: string;
  steps: YamlStep[];
};

// ── Conversions ──────────────────────────────────────────────────────

/**
 * Sugar a selector for YAML output: a LOOSE text-only selector collapses to a
 * bare string (`{ text: "Login", loose: true }` → `"Login"`); everything else —
 * including a strict `{ text }` — keeps the map form. The internal `loose` flag
 * is never emitted as a field; the bare-string spelling carries it, and
 * `parseSelector` is the exact inverse (bare string ⇒ loose, map ⇒ strict).
 * Collapsing a strict text selector too would promote it to loose on re-parse,
 * sending it through the identifier-first fallback it was never verified
 * against — e.g. a recorder-captured `{ text: "Save" }` hijacked by a
 * `testID="save"` elsewhere on screen.
 */
export function selectorToYaml(sel: FlowSelector): YamlSelector {
  // YAML has a single `text` slot: it is either a literal string or a
  // `{ matches }` map. Emitting one would overwrite/drop the other, changing
  // the selector's AND semantics. Reject this internal-only combination at
  // the serialization boundary instead of quietly weakening the selector.
  if (sel.text !== undefined && sel.textMatches !== undefined) {
    throw new Error(
      "Cannot serialize flow selector without losing constraints: both `text` and " +
        "`textMatches` are set, but flow YAML can represent only one `text` constraint " +
        '(a literal string or `{ matches: "<regex>" }`). Use either literal or regex text matching.'
    );
  }

  // Both spellings parse back through selectorSchema's visible-text
  // constraint. Guard the serialization boundary too — for the strict map
  // form as much as the bare string: an empty, runtime-invalid, or
  // invisible-only text value (icon-font Private Use Area glyphs, zero-width
  // characters) would otherwise produce YAML that DISPLAYS as an empty
  // selector and that selectorToYaml's inverse rejects. Recorders never hit
  // this (deriveSelector refuses invisible text and falls back to
  // coordinates); a hand-built selector fails loudly instead of writing a
  // flow no one can read or replay.
  if (sel.text !== undefined && (typeof sel.text !== "string" || !hasVisibleText(sel.text))) {
    throw new Error(
      "Cannot serialize flow selector: `text` must contain at least one visible character " +
        "(icon-font/private-use and zero-width characters render as nothing). Select by " +
        "identifier or role, or use a coordinate tap."
    );
  }

  // Bare-string YAML is the only spelling that carries `loose` (the
  // identifier-first, then text fallback). A map is necessarily strict, so a
  // loose selector with any additional/alternative field cannot round-trip.
  if (
    sel.loose &&
    (sel.text === undefined ||
      sel.textMatches !== undefined ||
      sel.identifier !== undefined ||
      sel.role !== undefined)
  ) {
    const incompatible = [
      sel.textMatches !== undefined ? "textMatches" : undefined,
      sel.identifier !== undefined ? "identifier" : undefined,
      sel.role !== undefined ? "role" : undefined,
    ].filter((field): field is string => field !== undefined);
    throw new Error(
      "Cannot serialize loose flow selector without changing its meaning: bare-string YAML " +
        "can represent only a loose text-only selector" +
        (incompatible.length > 0 ? `; incompatible fields: ${incompatible.join(", ")}` : "") +
        "."
    );
  }

  if (
    sel.loose &&
    sel.text !== undefined &&
    sel.identifier === undefined &&
    sel.role === undefined
  ) {
    return sel.text;
  }
  // YAML spells the identifier field `id` (parseSelector maps it back), and
  // the internal `textMatches` field spells `text: { matches }`.
  const { loose: _loose, identifier, textMatches, ...rest } = sel;
  const out: Exclude<YamlSelector, string> = { ...rest };
  if (textMatches !== undefined) out.text = { matches: textMatches };
  if (identifier !== undefined) out.id = identifier;
  return out;
}

/**
 * Render a selector for a human-readable message (failure reasons, recording
 * warnings). The internal `loose` flag is dropped.
 */
export function describeSelector(s: FlowSelector): string {
  return (
    Object.entries(s)
      .filter(([k]) => k !== "loose")
      // `identifier` is spelled `id` in flow YAML — print the spelling the flow
      // file uses so the message reads like the step it refers to. A regex
      // matcher prints in /slashes/ so it can't be misread as a literal.
      .map(([k, v]) =>
        k === "textMatches" ? `text=/${v}/` : `${k === "identifier" ? "id" : k}="${v}"`
      )
      .join(" ")
  );
}

/**
 * Render a text condition's comparator and expectation for reports. Literal
 * expectations use JSON quoting so embedded quotes, backslashes, and control
 * characters stay unambiguous; regex patterns use slash delimiters so they
 * cannot be mistaken for literals. Failure prose asks for the infinitive verb
 * form (`wanted to contain/equal/match`), while step targets use the YAML mode
 * names (`contains/equals/matches`).
 */
export function describeTextExpectation(
  expectedText: string | undefined,
  textMatch: TextMatchMode | undefined,
  verbForm: "mode" | "infinitive" = "mode"
): string {
  const expected = expectedText ?? "";
  const mode = textMatch ?? "contains";
  switch (mode) {
    case "contains":
      return `${verbForm === "infinitive" ? "contain" : mode} ${JSON.stringify(expected)}`;
    case "equals":
      return `${verbForm === "infinitive" ? "equal" : mode} ${JSON.stringify(expected)}`;
    case "matches":
      return `${verbForm === "infinitive" ? "match" : mode} /${expected}/`;
  }
}

/**
 * Preserve the selected text comparator when converting to YAML. Keeping this
 * switch explicit makes a new TextMatchMode a compile error here instead of
 * silently serializing it as `contains`.
 */
function textWaitToYaml(
  selector: YamlSelector,
  expectedText: string | undefined,
  textMatch: TextMatchMode | undefined
): YamlTextWaitCondition {
  const expected = expectedText ?? "";
  const mode = textMatch ?? "contains";
  switch (mode) {
    case "contains":
      return { text: { in: selector, contains: expected } };
    case "equals":
      return { text: { in: selector, equals: expected } };
    case "matches":
      return { text: { in: selector, matches: expected } };
    default: {
      const exhaustive: never = mode;
      throw new Error(`Unsupported text match mode: ${exhaustive}`);
    }
  }
}

/** Sugar a gesture target (`tap`/`long-press`) for YAML output, rejecting
 * internal states that would serialize to a flow the parser cannot read back. */
function targetToYaml(step: { selector?: FlowSelector; x?: number; y?: number }): YamlTarget {
  const hasPointField = step.x !== undefined || step.y !== undefined;
  if (step.selector !== undefined) {
    if (hasPointField) {
      throw new Error(
        "Cannot serialize flow gesture target: use a selector or x/y coordinates, not both"
      );
    }
    return selectorToYaml(step.selector);
  }
  if (typeof step.x !== "number" || typeof step.y !== "number") {
    throw new Error(
      "Cannot serialize flow gesture target: a coordinate target needs numeric x and y"
    );
  }
  if (!(step.x >= 0 && step.x <= 1) || !(step.y >= 0 && step.y <= 1)) {
    throw new Error(
      "Cannot serialize flow gesture target: coordinates are normalized 0–1 fractions of the screen, not pixels"
    );
  }
  return { x: step.x, y: step.y };
}

/** Sugar an await/assert step into the condition-as-key YAML body. */
function waitToYaml(
  condition: WaitCondition,
  selector: FlowSelector,
  expectedText: string | undefined,
  textMatch: TextMatchMode | undefined,
  timeoutMs: number | undefined
): YamlWaitCondition & { timeout?: number } {
  const sel = selectorToYaml(selector);
  let body: YamlWaitCondition & { timeout?: number };
  switch (condition) {
    case "exists":
      body = { exists: sel };
      break;
    case "visible":
      body = { visible: sel };
      break;
    case "hidden":
      body = { hidden: sel };
      break;
    case "text":
      body = textWaitToYaml(sel, expectedText, textMatch);
      break;
  }
  if (timeoutMs !== undefined) body.timeout = timeoutMs;
  return body;
}

function toYamlStep(step: FlowStep): YamlStep {
  switch (step.kind) {
    case "echo":
      return { echo: step.message };
    case "launch":
      return { launch: step.app };
    case "run":
      return { run: step.flow };
    case "when": {
      const when: YamlWhenBody =
        step.condition.kind === "platform"
          ? { platform: step.condition.platform }
          : (waitToYaml(
              step.condition.condition,
              step.condition.selector,
              step.condition.expectedText,
              step.condition.textMatch,
              undefined
            ) as YamlWhenBody);
      return { when, steps: step.steps.map(toYamlStep) };
    }
    case "tap": {
      // Canonical minimal spelling: the options form appears only when an
      // option is present (`times` is never stored as 1 — see parseTapTimes),
      // so a plain tap always round-trips to the plain selector/point body.
      const target = targetToYaml(step);
      return { tap: step.times !== undefined ? { on: target, times: step.times } : target };
    }
    case "long-press": {
      const target = targetToYaml(step);
      return {
        "long-press":
          step.duration !== undefined ? { on: target, duration: step.duration } : target,
      };
    }
    case "type": {
      const body: { into: YamlSelector; text: string; submit?: boolean } = {
        into: selectorToYaml(step.into),
        text: step.text,
      };
      // `submit` defaults to true; only serialize the explicit opt-out.
      if (step.submit === false) body.submit = false;
      return { type: body };
    }
    case "await":
      return {
        await: waitToYaml(
          step.condition,
          step.selector,
          step.expectedText,
          step.textMatch,
          step.timeout
        ),
      };
    case "assert":
      return {
        assert: waitToYaml(
          step.condition,
          step.selector,
          step.expectedText,
          step.textMatch,
          undefined
        ),
      };
    case "wait":
      return { wait: step.ms };
    case "scroll-to": {
      const target = selectorToYaml(step.target);
      // Sugar the common case back to a bare target: default direction, no container.
      if (typeof target === "string" && step.direction === "down" && !step.within) {
        return { "scroll-to": target };
      }
      return {
        "scroll-to": {
          target,
          direction: step.direction,
          ...(step.within ? { within: selectorToYaml(step.within) } : {}),
        },
      };
    }
    case "snapshot":
      // A name-only snapshot sugars to a bare string.
      return step.maxMismatch === undefined
        ? { snapshot: step.name }
        : { snapshot: { name: step.name, maxMismatch: step.maxMismatch } };
    case "tool":
    default: {
      const y: { tool: string; args?: Record<string, unknown>; delayMs?: number } = {
        tool: step.name,
      };
      if (Object.keys(step.args).length > 0) y.args = step.args;
      if (step.delayMs !== undefined) y.delayMs = step.delayMs;
      return y;
    }
  }
}

function badEntry(raw: unknown, detail: string): never {
  // A cyclic YAML alias materializes as a cyclic object — JSON.stringify
  // would throw and mask the validation message, so fall back to a marker.
  let rendered: string;
  try {
    rendered = JSON.stringify(raw);
  } catch {
    rendered = "[cyclic entry]";
  }
  throw new FailureError(`Unrecognized flow entry (${detail}): ${rendered}`, {
    error_code: FAILURE_CODES.FLOW_ENTRY_UNRECOGNIZED,
    failure_stage: "flow_file_parse_step",
    failure_area: "tool_server",
    error_kind: "validation",
  });
}

/** Validate a regex pattern at the YAML boundary and report its flow context. */
function validatePattern(raw: unknown, pattern: string, where: string): void {
  try {
    new RegExp(pattern);
  } catch (err) {
    badEntry(
      raw,
      `${where} \`matches\` is not a valid regular expression: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// Optimal-string-alignment distance: Levenshtein plus adjacent transposition
// (`roel` → `role` counts 1, not 2 — the dominant typo class). Inputs are
// option keys, so the simple row-based table is fine.
function editDistance(a: string, b: string): number {
  let prevPrev = new Array<number>(b.length + 1);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, prevPrev[j - 2]! + 1);
      }
      curr[j] = d;
    }
    [prevPrev, prev, curr] = [prev, curr, prevPrev];
  }
  return prev[b.length]!;
}

/** The allowed key an unknown key most plausibly misspells, or null. */
function closestKey(key: string, allowed: readonly string[]): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of allowed) {
    const d = editDistance(key.toLowerCase(), candidate.toLowerCase());
    if (d < bestDistance) {
      bestDistance = d;
      best = candidate;
    }
  }
  // Only suggest a typo-sized distance — `z` is not a misspelling of `id`.
  return best !== null && bestDistance <= Math.max(1, Math.floor(best.length / 3)) ? best : null;
}

function describeUnknownKeys(unknown: string[], allowed: readonly string[]): string {
  const listed = unknown.map((k) => {
    const hint = closestKey(k, allowed);
    return hint ? `\`${k}\` (did you mean \`${hint}\`?)` : `\`${k}\``;
  });
  return `unknown key${unknown.length > 1 ? "s" : ""} ${listed.join(", ")}`;
}

/**
 * Reject keys outside `allowed` in a directive body / selector map. Flows are
 * hand-authored YAML with no extensible bodies, so an unrecognized key is a
 * typo — dropping it silently would apply the default instead (`directon: up`
 * scrolling down) and surface later as a misleading runtime failure rather
 * than a parse error.
 */
function rejectUnknownKeys(
  raw: unknown,
  body: Record<string, unknown>,
  allowed: readonly string[],
  where: string
): void {
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length === 0) return;
  badEntry(
    raw,
    `${where} has ${describeUnknownKeys(unknown, allowed)} — allowed keys: ${allowed.join(", ")}`
  );
}

// Keys a selector map accepts: the schema fields plus the YAML `id` spelling
// (`identifier` stays accepted as its parse-only alias).
const SELECTOR_KEYS: readonly string[] = ["text", "id", "identifier", "role"];

function parseSelector(raw: unknown, where: string): FlowSelector {
  // Bare-string sugar: a string is shorthand for a text selector, marked
  // `loose` so the flow runner tries the identifier locator first and falls
  // back to text — a hand-written `foo` then matches `testID="foo"` too. An
  // explicit `{ text }` / `{ id }` map is strict (no `loose`).
  if (typeof raw === "string") {
    const r = selectorSchema.safeParse({ text: raw });
    if (!r.success) badEntry(raw, `${where}: ${r.error.issues[0]?.message ?? "invalid selector"}`);
    return { ...r.data, loose: true };
  }
  // Reject unknown keys here so flow errors can name the YAML selector and
  // list its accepted spellings (`id` plus the parse-only `identifier` alias).
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    rejectUnknownKeys(raw, raw as Record<string, unknown>, SELECTOR_KEYS, `${where}: selector`);
  }
  // Map form: `id` is the YAML spelling of the internal `identifier` field —
  // rewrite it before schema validation. `identifier` still parses as an alias
  // (existing flow files), but a map carrying both is ambiguous and rejected.
  let normalized = raw;
  if (raw !== null && typeof raw === "object" && "id" in raw) {
    const { id, ...rest } = raw as { id: unknown } & Record<string, unknown>;
    if ("identifier" in rest) {
      badEntry(raw, `${where}: selector takes \`id\` or \`identifier\` (its alias), not both`);
    }
    normalized = { ...rest, identifier: id };
  }
  // Regex text matcher: `text: { matches: '<pattern>' }`. Split off before
  // schema validation (the schema's `text` is a plain string) and validate
  // the pattern here, deviceless — same guarantee as the `text` condition's
  // `matches`. The remaining fields (`id`/`role`) AND-combine as usual.
  if (normalized !== null && typeof normalized === "object") {
    const { text, ...rest } = normalized as { text?: unknown } & Record<string, unknown>;
    if (text !== null && typeof text === "object") {
      const keys = Object.keys(text);
      if (!Array.isArray(text)) {
        rejectUnknownKeys(
          raw,
          text as Record<string, unknown>,
          ["matches"],
          `${where}: text matcher`
        );
      }
      const pattern = (text as Record<string, unknown>).matches;
      if (keys.length !== 1 || keys[0] !== "matches") {
        badEntry(
          raw,
          `${where}: a text matcher takes exactly { matches: '<regex>' } — for a substring, use the plain-string form (text: "…")`
        );
      }
      if (typeof pattern !== "string" || pattern.length === 0) {
        badEntry(raw, `${where}: text matcher needs a non-empty \`matches\` pattern`);
      }
      validatePattern(raw, pattern, `${where}: text`);
      // A regex matcher is itself the selector's required text constraint, so
      // validate only its remaining fields through the strict shared schema.
      // Using the unrefined field schema keeps matcher-only selectors valid
      // while giving id/role exactly the same validation as literal selectors.
      const fields = selectorFieldsSchema.safeParse(rest);
      if (!fields.success) {
        badEntry(raw, `${where}: ${fields.error.issues[0]?.message ?? "invalid selector"}`);
      }
      return { ...fields.data, textMatches: pattern };
    }
  }
  const r = selectorSchema.safeParse(normalized);
  if (!r.success) badEntry(raw, `${where}: ${r.error.issues[0]?.message ?? "invalid selector"}`);
  return r.data;
}

const WAIT_CONDITIONS: readonly WaitCondition[] = ["exists", "visible", "hidden", "text"];

// Keep the runtime comparator list complete and exact relative to the shared
// mode type: `Record` rejects both a missing TextMatchMode and an extra key.
const TEXT_MATCH_MODES = Object.keys({
  contains: true,
  equals: true,
  matches: true,
} satisfies Record<TextMatchMode, true>) as readonly TextMatchMode[];

const SCROLL_DIRECTIONS: readonly ScrollDirection[] = ["up", "down", "left", "right"];

type WaitFields = {
  condition: WaitCondition;
  selector: FlowSelector;
  expectedText?: string;
  textMatch?: TextMatchMode;
  timeout?: number;
};

/**
 * Parse the body of an `await`/`assert` step (or a `when:` guard's UI
 * condition) into its condition + selector + optional expected text. The
 * condition is the key and its value is the selector (`{ visible: "Home" }`,
 * `{ text: { in, contains } }`). The `text` check takes exactly one of
 * `contains` (substring), `equals` (exact text), or `matches` (JS regex,
 * validated here so a bad pattern fails at parse, not mid-run). `await`
 * additionally accepts an optional `timeout` sibling key (milliseconds); an
 * `assert` carrying one is rejected rather than silently ignored.
 */
function parseWaitFields(raw: unknown, kind: "await" | "assert" | "when"): WaitFields {
  if (raw === null || typeof raw !== "object") {
    badEntry({ [kind]: raw }, `${kind} needs a condition (${WAIT_CONDITIONS.join(", ")})`);
  }
  const b = raw as Record<string, unknown>;

  // The condition is the key; its value is the selector.
  const present = WAIT_CONDITIONS.filter((c) => c in b);
  if (present.length !== 1) {
    badEntry(
      { [kind]: b },
      `${kind} needs exactly one condition key (${WAIT_CONDITIONS.join(", ")})`
    );
  }
  const condition = present[0]!;

  let timeout: number | undefined;
  if ("timeout" in b) {
    if (kind === "assert") {
      badEntry(
        { [kind]: b },
        "assert has no timeout — it is an immediate check; use `await` for a timed wait"
      );
    }
    // Like `wait`, reject non-finite values: YAML `.inf` (or an overflowing
    // literal like 1e400) parses to Infinity — typeof number and > 0 — which
    // would make the runner's poll deadline unreachable and the await unbounded.
    if (typeof b.timeout !== "number" || !Number.isFinite(b.timeout) || b.timeout <= 0) {
      badEntry(
        { [kind]: b },
        "await.timeout needs a positive number of milliseconds (e.g. `timeout: 10000`)"
      );
    }
    timeout = b.timeout as number;
  }

  // `await` takes the condition key plus `timeout`; `assert` the condition key
  // only (an explicit assert timeout was already rejected above with the
  // pointed message). Anything else — `timeut`, a stray option — is a typo.
  rejectUnknownKeys(
    { [kind]: b },
    b,
    kind === "await" ? [...WAIT_CONDITIONS, "timeout"] : WAIT_CONDITIONS,
    kind
  );

  // `text` locates an element (`in`) and checks its rendered content against
  // exactly one of `contains` (substring), `equals` (exact text), or
  // `matches` (regex).
  if (condition === "text") {
    const t = b.text;
    if (t === null || typeof t !== "object") {
      badEntry(
        { [kind]: b },
        `${kind} text needs { in: <selector>, contains|equals|matches: <string> }`
      );
    }
    const tb = t as Record<string, unknown>;
    if (!Array.isArray(tb)) {
      rejectUnknownKeys({ [kind]: b }, tb, ["in", ...TEXT_MATCH_MODES], `${kind}.text`);
    }
    const comparators = TEXT_MATCH_MODES.filter((mode) => mode in tb);
    if (comparators.length !== 1) {
      badEntry(
        { [kind]: b },
        `${kind} text needs exactly one of \`contains\`, \`equals\`, or \`matches\``
      );
    }
    const textMatch: TextMatchMode = comparators[0]!;
    const expected = tb[textMatch];
    if (typeof expected !== "string" || expected.length === 0) {
      badEntry({ [kind]: b }, `${kind} text needs a non-empty \`${textMatch}\``);
    }
    if (textMatch === "matches") {
      // Fail a bad pattern here, deviceless, not mid-run. The pattern reaches
      // the runtime verbatim, so RegExp construction there can never throw on
      // a flow's behalf.
      validatePattern({ [kind]: b }, expected, `${kind} text`);
    }
    return {
      condition: "text",
      selector: parseSelector(tb.in, `${kind}.text.in`),
      expectedText: expected,
      textMatch,
      timeout,
    };
  }

  return { condition, selector: parseSelector(b[condition], `${kind}.${condition}`), timeout };
}

/**
 * The platform set, spelled once: launch maps, `when: { platform }` guards
 * ({@link WhenPlatform}), flow-device's `FlowPlatform`, and flow-run's
 * `platform` param enum all derive from this tuple.
 */
export const LAUNCH_PLATFORMS = ["ios", "android", "chromium", "vega"] as const;

// Keys a launch map accepts: the platforms plus the `native` shared-id shorthand.
const LAUNCH_MAP_KEYS = ["native", ...LAUNCH_PLATFORMS] as const;

/**
 * Parse a chromium launch value: an app path (bare string) or `{ path, args? }`.
 * Returns null when the shape is invalid (caller reports the launch error).
 */
function parseChromiumLaunch(raw: unknown): ChromiumLaunch | null {
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const b = raw as Record<string, unknown>;
    rejectUnknownKeys({ launch: { chromium: raw } }, b, ["path", "args"], "launch.chromium");
    if (typeof b.path !== "string" || b.path.length === 0) return null;
    if (b.args === undefined) return { path: b.path };
    if (!Array.isArray(b.args) || !b.args.every((a) => typeof a === "string")) return null;
    return { path: b.path, args: b.args as string[] };
  }
  return null;
}

/** Parse a `launch` step body: a bare app id, or a per-platform map. */
function parseLaunch(raw: unknown): Launch {
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const b = raw as Record<string, unknown>;
    // Name a misspelled platform key (`amdroid:`) instead of falling through
    // to the generic shape error below.
    rejectUnknownKeys({ launch: raw }, b, LAUNCH_MAP_KEYS, "launch");
    const keys = Object.keys(b);
    if (keys.length > 0) {
      const out: {
        native?: string;
        ios?: string;
        android?: string;
        vega?: string;
        chromium?: ChromiumLaunch;
      } = {};
      let valid = true;
      for (const k of keys) {
        if (k === "chromium") {
          const c = parseChromiumLaunch(b[k]);
          if (c === null) {
            valid = false;
            break;
          }
          out.chromium = c;
        } else if (typeof b[k] === "string" && (b[k] as string).length > 0) {
          (out as Record<string, string>)[k] = b[k] as string;
        } else {
          valid = false;
          break;
        }
      }
      if (valid) return out;
    }
  }
  return badEntry(
    { launch: raw },
    `launch needs an app id (bare string) or a per-platform map ` +
      `({ native | ${LAUNCH_PLATFORMS.filter((p) => p !== "chromium").join(" | ")}: <app id>, ` +
      `chromium: <app path> | { path, args } })`
  );
}

// The directive key that names each step kind. Order mirrors fromYamlStep's
// dispatch; used to reject a step carrying zero, several, or misspelled ones.
const STEP_DIRECTIVE_KEYS: readonly string[] = [
  "echo",
  "launch",
  "run",
  "when",
  "tool",
  "tap",
  "long-press",
  "type",
  "await",
  "assert",
  "wait",
  "scroll-to",
  "snapshot",
];

/**
 * Parse `times` on a tap body: an integer tap count dispatched as ONE
 * multi-tap gesture (2 = double-tap; the OS may recognize it as such — N
 * *independent* taps are N tap steps). `times: 1` is the default and
 * normalizes to absent, keeping parse/serialize exact inverses. The cap
 * matches the gesture-tap tool's clickCount bound.
 */
function parseTapTimes(raw: unknown, entry: unknown): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 10) {
    badEntry(entry, "tap.times must be an integer between 1 and 10 (2 = double-tap)");
  }
  return raw === 1 ? undefined : raw;
}

/**
 * Parse a gesture target (`tap`/`long-press` body or its `on:` value): a
 * selector (bare string = loose, map = strict) or a raw normalized point
 * `{ x, y }`. A map mixing selector fields with x/y is ambiguous (which
 * wins?) — and zod would silently STRIP the coordinates from a selector
 * map — so it is rejected loudly. Only the point-acting directives call
 * this; the observation directives take `parseSelector` directly, since a
 * point can be acted on but not observed.
 */
function parseTarget(
  raw: unknown,
  where: string
): { selector: FlowSelector } | { x: number; y: number } {
  if (raw !== null && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (obj.x !== undefined || obj.y !== undefined) {
      if (
        obj.text !== undefined ||
        obj.id !== undefined ||
        obj.identifier !== undefined ||
        obj.role !== undefined
      ) {
        badEntry(raw, `${where} takes a selector or x/y coordinates, not both`);
      }
      if (typeof obj.x !== "number" || typeof obj.y !== "number") {
        badEntry(raw, `${where}: a coordinate target needs numeric x and y`);
      }
      // Coordinates are normalized fractions of the screen. Reject anything
      // outside [0, 1] — a pixel value like x: 250 would dispatch a far
      // off-screen gesture — and NaN/.inf, which pass the numeric check.
      if (!(obj.x >= 0 && obj.x <= 1) || !(obj.y >= 0 && obj.y <= 1)) {
        badEntry(
          raw,
          `${where}: coordinates are normalized 0–1 fractions of the screen, not pixels`
        );
      }
      if (!Object.keys(obj).every((k) => k === "x" || k === "y")) {
        badEntry(raw, `${where}: a coordinate target takes only { x, y }`);
      }
      return { x: obj.x, y: obj.y };
    }
  }
  return { selector: parseSelector(raw, where) };
}

/**
 * Parse a `tap` body: a bare target (selector or raw point `{ x, y }`) or
 * the options form `{ on: <target>, times? }`, which nests the target under
 * `on` so an option key can never be mistaken for — or silently stripped
 * from — a target field.
 */
function parseTap(body: unknown, entry: unknown): FlowStep {
  const obj = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};

  if (obj.on !== undefined || obj.times !== undefined) {
    if (
      obj.text !== undefined ||
      obj.id !== undefined ||
      obj.identifier !== undefined ||
      obj.role !== undefined
    ) {
      badEntry(
        entry,
        'the tap options form takes a nested selector — e.g. tap: { on: { text: "Photo" }, times: 2 }'
      );
    }
    if (obj.x !== undefined || obj.y !== undefined) {
      badEntry(
        entry,
        "the tap options form takes a nested point — e.g. tap: { on: { x: 0.5, y: 0.5 }, times: 2 }"
      );
    }
    if (!Object.keys(obj).every((k) => k === "on" || k === "times")) {
      badEntry(entry, "the tap options form accepts only { on, times }");
    }
    if (obj.on === undefined) {
      badEntry(entry, 'tap with times needs a target — e.g. tap: { on: "Photo", times: 2 }');
    }
    const step: FlowStep = { kind: "tap", ...parseTarget(obj.on, "tap.on") };
    const times = parseTapTimes(obj.times, entry);
    if (times !== undefined) step.times = times;
    return step;
  }

  return { kind: "tap", ...parseTarget(body, "tap") };
}

/**
 * Parse a `long-press` body: a bare target (selector or raw point `{ x, y }`)
 * or the options form `{ on: <target>, duration?: <ms> }` — the same
 * nested-`on` convention as tap's options form.
 */
function parseLongPress(body: unknown, entry: unknown): FlowStep {
  const obj = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};

  if (obj.on !== undefined || obj.duration !== undefined) {
    if (
      obj.text !== undefined ||
      obj.id !== undefined ||
      obj.identifier !== undefined ||
      obj.role !== undefined
    ) {
      badEntry(
        entry,
        'the long-press options form takes a nested selector — e.g. long-press: { on: { text: "Row" }, duration: 1200 }'
      );
    }
    if (obj.x !== undefined || obj.y !== undefined) {
      badEntry(
        entry,
        "the long-press options form takes a nested point — e.g. long-press: { on: { x: 0.5, y: 0.5 }, duration: 1200 }"
      );
    }
    if (!Object.keys(obj).every((k) => k === "on" || k === "duration")) {
      badEntry(entry, "the long-press options form accepts only { on, duration }");
    }
    if (obj.on === undefined) {
      badEntry(entry, 'long-press needs a target — e.g. long-press: { on: "Row", duration: 1200 }');
    }
    const step: FlowStep = { kind: "long-press", ...parseTarget(obj.on, "long-press.on") };
    if (obj.duration !== undefined) {
      // Like `await.timeout`: reject non-finite values (YAML `.inf` parses to
      // Infinity), which would hold the press forever.
      if (typeof obj.duration !== "number" || !Number.isFinite(obj.duration) || obj.duration <= 0) {
        badEntry(
          entry,
          "long-press.duration needs a positive number of milliseconds (e.g. `duration: 1200`)"
        );
      }
      step.duration = obj.duration;
    }
    return step;
  }

  return { kind: "long-press", ...parseTarget(body, "long-press") };
}

/**
 * Parse a `when:` guard — exactly one condition key: a UI condition
 * (exists|visible|hidden|text, the await/assert shapes) or `platform` (a
 * static per-run test). No `timeout` sibling: the guard is always evaluated
 * with the short assert grace, so a skipped block stays cheap on every clean
 * run.
 */
function parseWhenCondition(raw: unknown): WhenCondition {
  const conditionKeys = `${WAIT_CONDITIONS.join(", ")}, platform`;
  if (raw === null || typeof raw !== "object") {
    badEntry({ when: raw }, `when needs exactly one condition key (${conditionKeys})`);
  }
  const b = raw as Record<string, unknown>;
  const present = [...WAIT_CONDITIONS, "platform"].filter((c) => c in b);
  if (present.length !== 1) {
    badEntry({ when: raw }, `when needs exactly one condition key (${conditionKeys})`);
  }
  if ("timeout" in b) {
    badEntry(
      { when: raw },
      "when takes no timeout — the guard is evaluated with the short assert grace so a skipped block never adds a full await wait"
    );
  }
  if (present[0] === "platform") {
    if (Object.keys(b).length !== 1) {
      badEntry({ when: raw }, "when.platform takes no other keys");
    }
    const p = b.platform;
    if (typeof p !== "string" || !(LAUNCH_PLATFORMS as readonly string[]).includes(p)) {
      badEntry({ when: raw }, `when.platform must be one of ${LAUNCH_PLATFORMS.join(", ")}`);
    }
    return { kind: "platform", platform: p as WhenPlatform };
  }
  // A when guard is the await/assert fields minus `timeout` (rejected above,
  // so always undefined here) — spread the rest so a future WaitFields
  // addition reaches when guards the same way it reaches await/assert.
  const { timeout: _timeout, ...cond } = parseWaitFields(raw, "when");
  return { kind: "ui", ...cond };
}

/**
 * Nesting cap for `when` blocks — the parse-side analog of flow-run's
 * MAX_RUN_DEPTH. `when` is the only step kind whose parse recurses into child
 * steps, and the yaml library happily materializes a cyclic alias
 * (`steps: &s … steps: *s`) as a cyclic object; without a cap that cycle
 * escapes parseFlow as a raw RangeError instead of a structured parse error.
 */
const MAX_WHEN_DEPTH = 20;

/**
 * Parse a `when` step: `{ when: <condition>, steps: [<step>, …] }` — a guarded
 * block whose steps run only when the condition holds. Deliberately no `else`:
 * a when block exists to restore determinism (dismiss the interstitial, get
 * back on the known path), so paths may only reconverge, never diverge.
 */
function parseWhenStep(raw: Record<string, unknown>, depth: number): FlowStep {
  if (depth >= MAX_WHEN_DEPTH) {
    badEntry(
      raw,
      `when blocks nest deeper than ${MAX_WHEN_DEPTH} levels — check for a cyclic YAML alias (\`steps: &s … steps: *s\`)`
    );
  }
  if ("else" in raw) {
    badEntry(
      raw,
      "when has no else — paths may only reconverge, never diverge; two genuinely different paths are two flows"
    );
  }
  if (!Object.keys(raw).every((k) => k === "when" || k === "steps")) {
    badEntry(raw, "a when step takes exactly { when: <condition>, steps: [...] }");
  }
  const condition = parseWhenCondition(raw.when);
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    badEntry(raw, "when needs a non-empty steps list to guard");
  }
  const steps = (raw.steps as unknown[]).map((s) => {
    if (s !== null && typeof s === "object") return fromYamlStep(s as YamlStep, depth + 1);
    return badEntry(s, "step must be an object");
  });
  return { kind: "when", condition, steps };
}

function fromYamlStep(raw: YamlStep, whenDepth = 0): FlowStep {
  const entry = raw as Record<string, unknown>;
  // There is deliberately no per-step `optional:` — it would have to be
  // re-plumbed into every action directive (and each future gesture
  // directive), when a `when:` block already expresses it once for all of
  // them. Rejected, not ignored: Maestro habits will produce it, and a
  // silently-dropped `optional: true` leaves a step the author believes
  // can't fail hard-stopping the flow.
  if ("optional" in raw) {
    badEntry(
      raw,
      "optional is not supported — guard the step with a when: block instead (`when: { visible: <target> }` + `steps:`)"
    );
  }
  const kinds = STEP_DIRECTIVE_KEYS.filter((k) => k in entry);
  if (kinds.length === 0) {
    const hint = Object.keys(entry)
      .map((k) => closestKey(k, STEP_DIRECTIVE_KEYS))
      .find((h) => h !== null);
    badEntry(raw, `unrecognized step kind${hint ? ` (did you mean \`${hint}\`?)` : ""}`);
  }
  if (kinds.length > 1) {
    badEntry(
      raw,
      `a step takes exactly one directive key, found ${kinds.map((k) => `\`${k}\``).join(", ")}`
    );
  }
  // Only a `tool` step carries sibling keys (`args`, `delayMs`); every other
  // directive step is a single-key mapping — its options live INSIDE the
  // value, so a sibling key is a mis-nested or misspelled option. A `when`
  // step also carries siblings (`steps`, and the rejected `else`), but
  // parseWhenStep validates them itself with pointed messages, so the generic
  // check stays out of its way.
  const kind = kinds[0]!;
  if (kind !== "when") {
    const siblings = kind === "tool" ? ["tool", "args", "delayMs"] : [kind];
    const extras = Object.keys(entry).filter((k) => !siblings.includes(k));
    if (extras.length > 0) {
      badEntry(
        raw,
        `a \`${kind}\` step has ${describeUnknownKeys(extras, siblings)}` +
          (kind === "tool"
            ? " — a tool step takes only `tool`, `args`, `delayMs`"
            : ` — step options go inside the \`${kind}:\` value, not beside it`)
      );
    }
  }

  if ("echo" in raw) return { kind: "echo", message: String(raw.echo) };
  if ("launch" in raw) return { kind: "launch", app: parseLaunch(raw.launch) };
  if ("run" in raw) return { kind: "run", flow: String(raw.run) };
  if ("when" in raw) return parseWhenStep(entry, whenDepth);

  if ("tap" in raw) return parseTap((raw as { tap: unknown }).tap, raw);

  if ("long-press" in raw) {
    return parseLongPress((raw as { "long-press": unknown })["long-press"], raw);
  }

  if ("type" in raw) {
    const body = (raw as { type: { into?: unknown; text?: unknown; submit?: unknown } }).type;
    if (!body || typeof body !== "object") badEntry(raw, "type needs { into, text }");
    // A misspelled `sumbit` would silently drop the submit opt-out.
    rejectUnknownKeys(raw, body as Record<string, unknown>, ["into", "text", "submit"], "type");
    if (typeof body.text !== "string" || body.text.length === 0) {
      badEntry(raw, "type needs a non-empty text");
    }
    if (body.submit !== undefined && typeof body.submit !== "boolean") {
      badEntry(raw, "type.submit must be a boolean");
    }
    const step: Extract<FlowStep, { kind: "type" }> = {
      kind: "type",
      into: parseSelector(body.into, "type.into"),
      text: body.text,
    };
    if (body.submit === false) step.submit = false;
    return step;
  }

  if ("await" in raw) {
    return { kind: "await", ...parseWaitFields((raw as { await: unknown }).await, "await") };
  }

  if ("assert" in raw) {
    return { kind: "assert", ...parseWaitFields((raw as { assert: unknown }).assert, "assert") };
  }

  if ("wait" in raw) {
    const ms = Number((raw as { wait: unknown }).wait);
    if (!Number.isFinite(ms) || ms < 0) {
      badEntry(raw, "wait needs a non-negative number of milliseconds (e.g. `wait: 500`)");
    }
    return { kind: "wait", ms };
  }

  if ("scroll-to" in raw) {
    const body = (raw as { "scroll-to": unknown })["scroll-to"];
    // Bare-string sugar for the common case: scroll down until the target is
    // visible (`scroll-to: "Order 1234"`).
    if (typeof body === "string") {
      return {
        kind: "scroll-to",
        target: parseSelector(body, "scroll-to.target"),
        direction: "down",
      };
    }
    if (body === null || typeof body !== "object") {
      badEntry(raw, "scroll-to needs a target selector or { target, direction?, within? }");
    }
    const b = body as Record<string, unknown>;
    // A misspelled `directon` would silently fall back to the default and
    // scroll the opposite way.
    if (!Array.isArray(b)) {
      rejectUnknownKeys(raw, b, ["target", "direction", "within"], "scroll-to");
    }
    if (
      b.direction !== undefined &&
      (typeof b.direction !== "string" ||
        !SCROLL_DIRECTIONS.includes(b.direction as ScrollDirection))
    ) {
      badEntry(raw, `scroll-to direction must be one of ${SCROLL_DIRECTIONS.join(", ")}`);
    }
    const step: FlowStep = {
      kind: "scroll-to",
      target: parseSelector(b.target, "scroll-to.target"),
      direction: (b.direction as ScrollDirection | undefined) ?? "down",
    };
    if (b.within !== undefined) step.within = parseSelector(b.within, "scroll-to.within");
    return step;
  }

  if ("snapshot" in raw) {
    const body = (raw as { snapshot: unknown }).snapshot;
    // A misspelled `maxMissmatch` would silently drop the tolerance.
    if (body !== null && typeof body === "object" && !Array.isArray(body)) {
      rejectUnknownKeys(raw, body as Record<string, unknown>, ["name", "maxMismatch"], "snapshot");
    }
    // Bare-string sugar: `snapshot: home` ≡ `snapshot: { name: home }`.
    const b =
      typeof body === "string"
        ? { name: body }
        : (body as { name?: unknown; maxMismatch?: number });
    if (!b || typeof b !== "object" || typeof b.name !== "string" || !b.name) {
      badEntry(raw, "snapshot needs a name (bare string or { name })");
    }
    // The name becomes a baseline filename, so it must be path-safe (no
    // separators or "..") — same constraint as a flow name.
    if (!FLOW_NAME_PATTERN.test(b.name)) {
      badEntry(
        raw,
        `snapshot name "${b.name}" must match ${FLOW_NAME_PATTERN} (letters, digits, underscore, hyphen)`
      );
    }
    const step: FlowStep = { kind: "snapshot", name: b.name };
    if (b.maxMismatch !== undefined) {
      // The runner compares `mismatchPercentage <= maxMismatch` — a NaN here
      // (e.g. from "5%") would make every comparison false, failing the
      // snapshot even on byte-identical frames.
      const m = Number(b.maxMismatch);
      if (!Number.isFinite(m) || m < 0 || m > 100) {
        badEntry(
          raw,
          "snapshot maxMismatch must be a number between 0 and 100 (percent of pixels)"
        );
      }
      step.maxMismatch = m;
    }
    return step;
  }

  if ("tool" in raw) {
    const r = raw as { tool: string; args?: Record<string, unknown>; delayMs?: number };
    const step: FlowStep = { kind: "tool", name: r.tool, args: r.args ?? {} };
    if (r.delayMs !== undefined) step.delayMs = r.delayMs;
    return step;
  }

  return badEntry(raw, "unrecognized step kind");
}

// ── Serialisation ────────────────────────────────────────────────────

/** Serialize a full flow file to YAML, omitting empty/defaulted fields. */
export function serializeFlow(flow: FlowFile): string {
  const doc: YamlFlowFile = { steps: flow.steps.map(toYamlStep) };
  if (flow.executionPrerequisite) doc.executionPrerequisite = flow.executionPrerequisite;
  // blockQuote: false — a block scalar is not round-trip-safe for our free-text
  // fields: whitespace-only lines inside a multi-line value are silently
  // stripped on re-parse (" \n" comes back as "\n"), and a block scalar at the
  // document tail exposes its raw last line to parseFlow's content.trim(). So
  // parseFlow(serializeFlow(x)) was not the identity. Disabling blockQuote
  // emits multi-line values as double-quoted scalars (escape-exact both ways);
  // single-line values still serialize plain, and legacy files that contain
  // block scalars still parse.
  return yamlStringify(doc, { blockQuote: false });
}

/** Validate cross-field invariants that are checkable without other files. */
export function validateFlow(flow: FlowFile): void {
  if (isE2eFlow(flow) && flow.executionPrerequisite) {
    throw new FailureError(
      "A flow that starts with a launch step must not declare executionPrerequisite — it launches its own app and controls its start state. Drop the leading launch to make it a fragment, or drop executionPrerequisite.",
      {
        error_code: FAILURE_CODES.FLOW_E2E_HAS_PREREQUISITE,
        failure_stage: "flow_file_validate",
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
  }
}

/** Parse a YAML flow file into a FlowFile. */
export function parseFlow(content: string): FlowFile {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return { executionPrerequisite: "", steps: [] };
  }

  const parsed = yamlParse(trimmed) as YamlFlowFile;

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("steps" in parsed) ||
    !Array.isArray(parsed.steps)
  ) {
    throw new FailureError("Invalid flow file: expected an object with a steps array", {
      error_code: FAILURE_CODES.FLOW_FILE_INVALID,
      failure_stage: "flow_file_parse",
      failure_area: "tool_server",
      error_kind: "validation",
    });
  }

  // Same strictness as step bodies: the file has exactly two top-level keys,
  // so a misspelled `executionPrerequisite` must not silently become "".
  const topKeys: readonly string[] = ["executionPrerequisite", "steps"];
  const unknownTop = Object.keys(parsed).filter((k) => !topKeys.includes(k));
  if (unknownTop.length > 0) {
    throw new FailureError(
      `Invalid flow file: ${describeUnknownKeys(unknownTop, topKeys)} — ` +
        `allowed top-level keys: ${topKeys.join(", ")}`,
      {
        error_code: FAILURE_CODES.FLOW_FILE_INVALID,
        failure_stage: "flow_file_parse",
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
  }

  const steps = parsed.steps.map((raw) => {
    if (raw !== null && typeof raw === "object") return fromYamlStep(raw as YamlStep);
    return badEntry(raw, "step must be an object");
  });

  const flow: FlowFile = {
    executionPrerequisite: parsed.executionPrerequisite ?? "",
    steps,
  };
  validateFlow(flow);
  return flow;
}

// ── File helpers ─────────────────────────────────────────────────────

/** Read and parse the flow file, append a step, write it back. */
export async function appendStep(filePath: string, step: FlowStep): Promise<string> {
  const content = await fs.readFile(filePath, "utf8");
  const flow = parseFlow(content);
  flow.steps.push(step);
  // Re-validate with the new step: a leading `launch` recorded into a
  // prerequisite-bearing recording must error here (nothing written), not
  // produce a file that fails to parse at replay.
  validateFlow(flow);
  const updated = serializeFlow(flow);
  await fs.writeFile(filePath, updated, "utf8");
  return updated;
}

export function clientFileDirective(filePath: string, content: string): ClientFileDirective {
  return { [CLIENT_FILE_MARKER]: true, path: filePath, content };
}

/**
 * How a mutating flow tool reports persistence: a plain host path in "host"
 * mode (nothing for the client to do), or a {@link ClientFileDirective} the
 * client resolves by writing the YAML into the agent's project. Either way the
 * field reads as the flow file's path once the client has processed the result.
 */
export type FlowSavedTo = string | ClientFileDirective;

/**
 * Append a step to the active recording and persist it. In "host" mode the
 * file on disk is re-read first (the original behavior — a manual edit made
 * mid-recording is honored); in "client" mode this process never sees the
 * client's disk, so the in-memory copy is authoritative and the updated YAML
 * travels back in the directive.
 */
export async function appendStepToActiveFlow(
  step: FlowStep
): Promise<{ flowFile: string; savedTo: FlowSavedTo; session: RecordingSession }> {
  const session = requireRecordingSession();
  if (session.persist === "host") {
    const flowFile = await appendStep(session.filePath, step);
    session.flow = parseFlow(flowFile);
    return { flowFile, savedTo: session.filePath, session };
  }
  session.flow.steps.push(step);
  try {
    validateFlow(session.flow);
  } catch (err) {
    session.flow.steps.pop(); // keep the in-memory copy consistent: nothing recorded
    throw err;
  }
  const flowFile = serializeFlow(session.flow);
  return { flowFile, savedTo: clientFileDirective(session.filePath, flowFile), session };
}
