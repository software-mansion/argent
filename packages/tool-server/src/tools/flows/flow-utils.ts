import * as path from "node:path";
import * as fs from "node:fs/promises";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";
import { CLIENT_FILE_MARKER, type ClientFileDirective } from "@argent/registry";
import {
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
 * The app a `launch` step starts from scratch. A bare string applies to every
 * platform; the map form targets a specific bundle id / package per platform.
 * A flow that BEGINS with a `launch` step is an e2e flow (standalone-runnable,
 * controls its own start state); one that doesn't is a fragment.
 */
export type Launch = string | { ios?: string; android?: string; chromium?: string; vega?: string };

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
 * `{ identifier }` selectors stay strict everywhere, including across the
 * serialize/parse round-trip every recorded step performs.
 */
export type FlowSelector = Selector & { loose?: boolean };

export type FlowStep =
  | { kind: "tool"; name: string; args: Record<string, unknown>; delayMs?: number }
  | { kind: "echo"; message: string }
  | { kind: "launch"; app: Launch }
  | { kind: "run"; flow: string }
  | { kind: "tap"; selector?: FlowSelector; x?: number; y?: number }
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
 * start state, so it is the natural standalone/suite entry point, must not
 * declare an `executionPrerequisite`, and cannot be composed via `run:`.
 * Everything else is a fragment.
 */
export function isE2eFlow(flow: FlowFile): boolean {
  const first = flow.steps.find((s) => s.kind !== "echo");
  return first?.kind === "launch";
}

/** Resolve the launch app id for a platform, or null when none is declared for it. */
export function appIdForPlatform(launch: Launch | undefined, platform: string): string | null {
  if (launch === undefined) return null;
  if (typeof launch === "string") return launch;
  const v = (launch as Record<string, string | undefined>)[platform];
  return v ?? null;
}

/**
 * A selector in YAML is sugared: a bare string is shorthand for `{ text: <string> }`
 * (the common case), and the full `{ text?, identifier?, role? }` map is still
 * accepted for identifier/role locators.
 */
type YamlSelector = string | Selector;

/** A tap targets an element (selector, possibly a bare string) or a raw point. */
type TapBody = YamlSelector | { x: number; y: number };

/**
 * The body of an `await`/`assert` step. The condition is the key, not a separate
 * `condition:` field:
 *   - `{ visible: "Account" }`            ← exists/visible/hidden take a selector
 *   - `{ text: { in: "Taps:", contains: "Taps: 0" } }`  ← substring check
 *   - `{ text: { in: "Taps:", equals: "Taps: 0" } }`    ← exact-text check
 *   - `{ visible: "Account", timeout: 10000 }`            ← custom timeout (await only)
 */
type YamlWaitBody = (
  | { exists: YamlSelector }
  | { visible: YamlSelector }
  | { hidden: YamlSelector }
  | { text: { in: YamlSelector; contains: string } }
  | { text: { in: YamlSelector; equals: string } }
) & { timeout?: number };

/** `scroll-to` body: a bare target (scrolls down), or a map with options. */
type YamlScrollBody =
  | YamlSelector
  | { target: YamlSelector; direction?: ScrollDirection; within?: YamlSelector };

type YamlStep =
  | { echo: string }
  | { launch: Launch }
  | { run: string }
  | { tool: string; args?: Record<string, unknown>; delayMs?: number }
  | { tap: TapBody }
  | { type: { into: YamlSelector; text: string; submit?: boolean } }
  | { await: YamlWaitBody }
  | { assert: YamlWaitBody }
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
function selectorToYaml(sel: FlowSelector): YamlSelector {
  if (
    sel.loose &&
    sel.text !== undefined &&
    sel.identifier === undefined &&
    sel.role === undefined
  ) {
    return sel.text;
  }
  const { loose: _loose, ...rest } = sel;
  return { ...rest };
}

/** Sugar an await/assert step into the condition-as-key YAML body. */
function waitToYaml(
  condition: WaitCondition,
  selector: FlowSelector,
  expectedText: string | undefined,
  textMatch: TextMatchMode | undefined,
  timeoutMs: number | undefined
): YamlWaitBody {
  const sel = selectorToYaml(selector);
  let body: YamlWaitBody;
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
      body =
        textMatch === "equals"
          ? { text: { in: sel, equals: expectedText ?? "" } }
          : { text: { in: sel, contains: expectedText ?? "" } };
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
    case "tap": {
      const body: TapBody = step.selector
        ? selectorToYaml(step.selector)
        : { x: step.x!, y: step.y! };
      return { tap: body };
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
  throw new FailureError(`Unrecognized flow entry (${detail}): ${JSON.stringify(raw)}`, {
    error_code: FAILURE_CODES.FLOW_ENTRY_UNRECOGNIZED,
    failure_stage: "flow_file_parse_step",
    failure_area: "tool_server",
    error_kind: "validation",
  });
}

function parseSelector(raw: unknown, where: string): FlowSelector {
  // Bare-string sugar: a string is shorthand for a text selector, marked
  // `loose` so the flow runner tries the identifier locator first and falls
  // back to text — a hand-written `foo` then matches `testID="foo"` too. An
  // explicit `{ text }` / `{ identifier }` map is strict (no `loose`).
  if (typeof raw === "string") {
    const r = selectorSchema.safeParse({ text: raw });
    if (!r.success) badEntry(raw, `${where}: ${r.error.issues[0]?.message ?? "invalid selector"}`);
    return { ...r.data, loose: true };
  }
  const r = selectorSchema.safeParse(raw);
  if (!r.success) badEntry(raw, `${where}: ${r.error.issues[0]?.message ?? "invalid selector"}`);
  return r.data;
}

const WAIT_CONDITIONS: readonly WaitCondition[] = ["exists", "visible", "hidden", "text"];

const SCROLL_DIRECTIONS: readonly ScrollDirection[] = ["up", "down", "left", "right"];

type WaitFields = {
  condition: WaitCondition;
  selector: FlowSelector;
  expectedText?: string;
  textMatch?: TextMatchMode;
  timeout?: number;
};

/**
 * Parse the body of an `await`/`assert` step into its condition + selector +
 * optional expected text. The condition is the key and its value is the
 * selector (`{ visible: "Home" }`, `{ text: { in, contains } }`). The `text`
 * check takes exactly one of `contains` (substring) or `equals` (exact text).
 * `await` additionally accepts an optional `timeout` sibling key (milliseconds).
 */
function parseWaitFields(raw: unknown, kind: "await" | "assert"): WaitFields {
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
  if (kind === "await" && "timeout" in b) {
    if (typeof b.timeout !== "number" || b.timeout <= 0) {
      badEntry({ [kind]: b }, "await.timeout must be a positive number");
    }
    timeout = b.timeout as number;
  }

  // `text` locates an element (`in`) and checks its rendered content against
  // exactly one of `contains` (substring) or `equals` (exact text).
  if (condition === "text") {
    const t = b.text;
    if (t === null || typeof t !== "object") {
      badEntry({ [kind]: b }, `${kind} text needs { in: <selector>, contains|equals: <string> }`);
    }
    const tb = t as Record<string, unknown>;
    const hasContains = "contains" in tb;
    const hasEquals = "equals" in tb;
    if (hasContains === hasEquals) {
      badEntry({ [kind]: b }, `${kind} text needs exactly one of \`contains\` or \`equals\``);
    }
    const textMatch: TextMatchMode = hasEquals ? "equals" : "contains";
    const expected = hasEquals ? tb.equals : tb.contains;
    if (typeof expected !== "string" || expected.length === 0) {
      badEntry({ [kind]: b }, `${kind} text needs a non-empty \`${textMatch}\``);
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

const LAUNCH_PLATFORMS = ["ios", "android", "chromium", "vega"] as const;

/** Parse a `launch` step body: a bare app id, or a per-platform map. */
function parseLaunch(raw: unknown): Launch {
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (raw !== null && typeof raw === "object") {
    const b = raw as Record<string, unknown>;
    const keys = Object.keys(b);
    const valid =
      keys.length > 0 &&
      keys.every(
        (k) =>
          (LAUNCH_PLATFORMS as readonly string[]).includes(k) &&
          typeof b[k] === "string" &&
          (b[k] as string).length > 0
      );
    if (valid) return b as Launch;
  }
  return badEntry(
    { launch: raw },
    `launch needs an app id (bare string) or a per-platform map ({ ${LAUNCH_PLATFORMS.join(" | ")}: <app id> })`
  );
}

function fromYamlStep(raw: YamlStep): FlowStep {
  if ("echo" in raw) return { kind: "echo", message: String(raw.echo) };
  if ("launch" in raw) return { kind: "launch", app: parseLaunch(raw.launch) };
  if ("run" in raw) return { kind: "run", flow: String(raw.run) };

  if ("tap" in raw) {
    const body = (raw as { tap: unknown }).tap;
    const obj = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    // A tap targets either an element (selector) or a raw point (x/y) — a body
    // mixing both is ambiguous (which wins?) and rejected rather than silently
    // resolved one way.
    if (obj.x !== undefined || obj.y !== undefined) {
      if (obj.text !== undefined || obj.identifier !== undefined || obj.role !== undefined) {
        badEntry(raw, "tap takes a selector or x/y coordinates, not both");
      }
      if (typeof obj.x !== "number" || typeof obj.y !== "number") {
        badEntry(raw, "a coordinate tap needs numeric x and y");
      }
      return { kind: "tap", x: obj.x, y: obj.y };
    }
    return { kind: "tap", selector: parseSelector(body, "tap") };
  }

  if ("type" in raw) {
    const body = (raw as { type: { into?: unknown; text?: unknown; submit?: unknown } }).type;
    if (!body || typeof body !== "object") badEntry(raw, "type needs { into, text }");
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
    if (b.maxMismatch !== undefined) step.maxMismatch = Number(b.maxMismatch);
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
  return yamlStringify(doc);
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
