import * as path from "node:path";
import * as fs from "node:fs/promises";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";
import {
  CLIENT_FILE_MARKER,
  FLOW_NAME_PATTERN,
  FLOW_FILE_NAME_PATTERN,
  type ClientFileDirective,
} from "@argent/registry";
import {
  hasVisibleText,
  selectorFieldsSchema,
  selectorSchema,
  SELECTOR_RELATIONS,
  type Selector,
  type SelectorRelation,
  type WaitCondition,
  type TextMatchMode,
} from "../../utils/ui-tree-match";

// Re-exported so the flow layer (parser, serializer, report stringifiers, the
// runner's loose-alternative expansion) reads the relation list from the same
// place the match engine defines it.
export { SELECTOR_RELATIONS };
import { SECRET_PLACEHOLDER_MARKER } from "../../utils/secrets";
import { MAX_ROTATE_BY_DEG } from "./flow-rotate-geometry";

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

/** The flows dir under an explicit root — for callers that must not resolve
 * against the active-project-root global (see flow-add-step). */
export function flowsDirFor(root: string): string {
  return path.join(root, FLOWS_DIR_NAME);
}

export function getFlowsDir(): string {
  return flowsDirFor(requireActiveProjectRoot());
}

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

/**
 * How the flow file a caller addressed is spelled in its own directory.
 * `listed`: the directory carries that basename byte-for-byte — or its listing
 * could not be read at all, which vouches for nothing and so must refuse
 * nothing (an execute-only parent directory lets stat through while refusing
 * readdir, and the exact-named contract may well be honored there).
 * `case_folded`: no entry carries it, but one differs from it only by case —
 * exactly what a case-insensitive filesystem (APFS, NTFS) opens for a reader
 * that asked for a spelling nothing on disk has, and the whole point of the
 * check. `absent`: nothing matches even case-insensitively, i.e. the file is
 * simply not there. `addressable` says whether the on-disk spelling is one the
 * flow layer's own ladders accept, so a caller can be pointed at it instead of
 * at a rename.
 */
export type OnDiskSpelling =
  | { state: "listed" }
  | { state: "case_folded"; actual: string; addressable: boolean }
  | { state: "absent" };

/**
 * Classify the supplied basename against `dir`'s listing. One classifier serves
 * every route that turns a caller's spelling into a flow identity — replay's
 * `flow_path` and `name` (flow-run.ts) and the recorder's two nested
 * flow-execute targets (flow-add-step.ts) — so they can never drift apart in
 * which spellings they accept. That drift is the bug itself twice over: it let
 * a `name` key a report and `__baselines__/` under a spelling `flow_path`
 * refused two arms earlier, and it let the recorder bake a `run:` name whose
 * flow_path spelling its own neighbouring arm would have refused.
 *
 * readdir, not realpath: realpath rewrites a symlinked flow to its target's
 * name, and a flow deliberately runs — and composes — under the link's own
 * name. Every call site hands a pure-ASCII basename (flow-name charset +
 * ".yaml"), so Unicode-normalizing filesystems cannot make the comparison lie.
 *
 * What an `absent` verdict means is the caller's to decide, and they differ:
 * `flow_path` arrives with the boundary's stat already vouching for the file,
 * so a listing that lacks it is itself the phantom-spelling bug, while a `name`
 * may simply not name a saved flow — an ordinary missing-flow error the later
 * read reports far better than a casing complaint could.
 */
export async function classifyOnDiskSpelling(dir: string, base: string): Promise<OnDiskSpelling> {
  const entries = await fs.readdir(dir).catch(() => null);
  if (entries === null || entries.includes(base)) return { state: "listed" };
  const actual = entries.find((entry) => entry.toLowerCase() === base.toLowerCase());
  if (actual === undefined) return { state: "absent" };
  return { state: "case_folded", actual, addressable: FLOW_FILE_NAME_PATTERN.test(actual) };
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
 * exist on the tool-server host; a relative path resolves against the ROOT
 * flow file's canonical (symlink-resolved) directory (the baseline anchor —
 * only the root flow's leading launch ever boots; `run:` targets anchor per
 * containing file, which for the root file is that same directory).
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
 *
 * The relational slots (`within`/`after`/`next`) re-narrow to FlowSelector so
 * the flag survives at every nesting level: a map selector is itself always
 * strict, but its scope may be a bare string (`within: profile-card`), and
 * that level keeps the loose identifier-first fallback. Only a bare string can
 * be loose and a bare string carries no relation of its own, so a loose level
 * is always a LEAF of the relation tree — the runner's alternative expansion
 * relies on this shape.
 *
 * `any` is the universal selector (CSS `*`): it carries no own constraint, so
 * the parser only accepts it paired with a relation. The match engine needs no
 * field for it — a selector with no own fields already matches every node —
 * so it stays on this flow-side type and is dropped before the engine sees the
 * selector (see `selectorAlternatives`), keeping `await-ui-element`'s schema
 * surface unchanged.
 */
export type FlowSelector = Omit<Selector, "within" | "after" | "next"> & {
  loose?: boolean;
  any?: boolean;
  within?: FlowSelector;
  after?: FlowSelector;
  next?: FlowSelector;
};

/**
 * The selector itself plus every selector nested in its relation tree. Used by
 * whole-chain checks (the `when` guard's secret-placeholder scan) so a
 * constraint buried in an `after`/`within` scope is treated exactly like one
 * in the target's own fields.
 */
function selectorTree(sel: FlowSelector): FlowSelector[] {
  const out: FlowSelector[] = [];
  const walk = (s: FlowSelector): void => {
    out.push(s);
    for (const relation of SELECTOR_RELATIONS) {
      const nested = s[relation];
      if (nested !== undefined) walk(nested);
    }
  };
  walk(sel);
  return out;
}

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
  // `flow` is the as-written YAML path, resolved against the containing file's directory.
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
  | { kind: "pinch"; selector?: FlowSelector; scale: number }
  | { kind: "rotate"; selector?: FlowSelector; by: number }
  | { kind: "snapshot"; name: string; maxMismatch?: number; cropOn?: FlowSelector };

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
 *
 * A map selector may also carry relational scopes, the geometric readings of
 * the CSS combinators (flow trees are flat — see the `Selector` type), each
 * taking a full nested selector (bare-string sugar included) that may nest
 * further:
 *   - `within: <selector>` — CSS descendant: the element's frame sits inside
 *     the frame of a distinct element matching the scope,
 *     e.g. `{ text: "Delete", within: { id: "settings-card" } }`.
 *   - `after: <selector>` — CSS `~`: the element follows a distinct match in
 *     reading order, e.g. `{ role: Button, after: { text: "Danger zone" } }`.
 *   - `next: <selector>` — CSS `+`: as `after`, narrowed to the NEAREST
 *     follower, e.g. `{ role: Switch, next: { text: "Wi-Fi" } }`.
 *
 * `any: true` is the CSS `*` universal selector — no own constraint, so it is
 * accepted only alongside a relation, and never alongside `text`/`id`/`role`
 * (which it would make redundant).
 */
type YamlSelector =
  | string
  | (Omit<Selector, "identifier" | "text" | "textMatches" | "within" | "after" | "next"> & {
      id?: string;
      any?: boolean;
      text?: string | { matches: string };
      within?: YamlSelector;
      after?: YamlSelector;
      next?: YamlSelector;
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
 * Deriving the UI arm from {@link YamlWaitCondition} keeps the two in lockstep:
 * the guard is parsed by the same parseWaitFields as await/assert, so a
 * condition shape added there is a when-guard shape too. `timeout` stays out
 * by construction — the await step type adds it as a sibling key, not here.
 */
type YamlWhenBody = YamlWaitCondition | { platform: WhenPlatform };

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
  | { pinch: { on?: YamlSelector; scale: number } }
  | { rotate: { on?: YamlSelector; by: number } }
  | { snapshot: string | { name: string; maxMismatch?: number; cropOn?: YamlSelector } };

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

  // The parser's two `any` rules are invariants of the YAML spelling, not of
  // this type, so a hand-built selector can violate them — and would serialize
  // to a flow file that `parseFlow` then refuses, which for a recorder means
  // the failure lands on a LATER step (every append re-parses the whole file).
  // Same boundary, same doctrine as the guards above: fail where the bad
  // selector was built.
  const scopeCount = SELECTOR_RELATIONS.filter((relation) => sel[relation] !== undefined).length;
  if (sel.any !== undefined) {
    if (sel.any !== true) {
      throw new Error(
        "Cannot serialize flow selector: `any` is the universal selector and takes only `true` — " +
          "omit it to select by text/id/role."
      );
    }
    if (sel.text !== undefined || sel.textMatches !== undefined || sel.identifier || sel.role) {
      throw new Error(
        "Cannot serialize flow selector: `any` already matches every element, so it cannot be " +
          "combined with text/id/role — keep one or the other."
      );
    }
    if (scopeCount === 0) {
      throw new Error(
        "Cannot serialize flow selector: `any` matches every element on screen, so it needs a " +
          `scope (${SELECTOR_RELATIONS.join("/")}) to narrow what it selects.`
      );
    }
  } else if (
    scopeCount > 0 &&
    sel.text === undefined &&
    sel.textMatches === undefined &&
    !sel.identifier &&
    !sel.role
  ) {
    throw new Error(
      `Cannot serialize flow selector: a scope (${SELECTOR_RELATIONS.join("/")}) only narrows ` +
        "where to look — the selector still needs its own text/id/role naming what to find " +
        "there, or `any: true` for any element."
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
      sel.role !== undefined ||
      sel.any !== undefined ||
      SELECTOR_RELATIONS.some((relation) => sel[relation] !== undefined))
  ) {
    const incompatible = [
      sel.textMatches !== undefined ? "textMatches" : undefined,
      sel.identifier !== undefined ? "identifier" : undefined,
      sel.role !== undefined ? "role" : undefined,
      sel.any !== undefined ? "any" : undefined,
      ...SELECTOR_RELATIONS.map((relation) => (sel[relation] !== undefined ? relation : undefined)),
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
  // the internal `textMatches` field spells `text: { matches }`. A relational
  // scope recurses — each level keeps its own bare-string/map spelling.
  const { loose: _loose, any, identifier, textMatches, within, after, next, ...rest } = sel;
  const scopes = { within, after, next };
  const out: Exclude<YamlSelector, string> = { ...rest };
  if (any) out.any = true;
  if (textMatches !== undefined) out.text = { matches: textMatches };
  if (identifier !== undefined) out.id = identifier;
  for (const relation of SELECTOR_RELATIONS) {
    const scope = scopes[relation];
    if (scope !== undefined) out[relation] = selectorToYaml(scope);
  }
  return out;
}

/**
 * Render a selector for a human-readable message (failure reasons, recording
 * warnings). The internal `loose` flag is dropped.
 */
export function describeSelector(s: FlowSelector): string {
  // Split off the non-string members (`loose` flag, `any` marker, relational
  // scopes) before Object.entries so the remaining values are all strings —
  // the scopes render separately below, and stringifying their objects here
  // would be meaningless.
  const { loose: _loose, any, within, after, next, ...rest } = s;
  const scopes = { within, after, next };
  const fields = Object.entries(rest)
    // `identifier` is spelled `id` in flow YAML — print the spelling the flow
    // file uses so the message reads like the step it refers to. A regex
    // matcher prints in /slashes/ so it can't be misread as a literal.
    .map(([k, v]) =>
      k === "textMatches" ? `text=/${v}/` : `${k === "identifier" ? "id" : k}="${v}"`
    )
    .join(" ");
  // The universal selector prints as CSS spells it, so a relation-only target
  // never renders as an empty string.
  const parts = [any ? "*" : undefined, fields || undefined].filter((p) => p !== undefined);
  // Each scope renders after the fields, parenthesized so a nested scope's own
  // fields can't be misread as the target's, and labelled with the YAML key so
  // the message reads like the step it refers to.
  for (const relation of SELECTOR_RELATIONS) {
    const scope = scopes[relation];
    if (scope !== undefined) parts.push(`${relation} (${describeSelector(scope)})`);
  }
  return parts.join(" ");
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
          : waitToYaml(
              step.condition.condition,
              step.condition.selector,
              step.condition.expectedText,
              step.condition.textMatch,
              undefined
            );
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
    case "pinch":
      // Canonical spelling puts `on` before `scale` (key order is preserved).
      return {
        pinch: step.selector
          ? { on: selectorToYaml(step.selector), scale: step.scale }
          : { scale: step.scale },
      };
    case "rotate":
      // Canonical key order puts `on` before `by` (key order is preserved).
      return {
        rotate: step.selector
          ? { on: selectorToYaml(step.selector), by: step.by }
          : { by: step.by },
      };
    case "snapshot": {
      // A name-only snapshot sugars to a bare string.
      if (step.maxMismatch === undefined && step.cropOn === undefined) {
        return { snapshot: step.name };
      }
      const body: { name: string; maxMismatch?: number; cropOn?: YamlSelector } = {
        name: step.name,
      };
      if (step.maxMismatch !== undefined) body.maxMismatch = step.maxMismatch;
      if (step.cropOn !== undefined) body.cropOn = selectorToYaml(step.cropOn);
      return { snapshot: body };
    }
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

// Ceiling on how much of the offending entry a diagnostic echoes. The entry
// is not always a hand-authored flow step: a mistyped `run:` path can select
// any in-project YAML file (a CI config, a partial flow), and this message
// travels verbatim into StepReport.reason — which `argent flow run` prints to
// stdout and flowRunToMcpContent emits into the agent's context — so an
// unbounded render would ship that file's values (multi-KB payloads, secrets)
// to both surfaces. 200 chars still shows a genuine flow entry, the common
// authoring-error case, in full.
const MAX_ENTRY_RENDER_CHARS = 200;

function badEntry(raw: unknown, detail: string): never {
  // A cyclic YAML alias materializes as a cyclic object — JSON.stringify
  // would throw and mask the validation message, so fall back to a marker.
  let rendered: string;
  try {
    rendered = JSON.stringify(raw);
  } catch {
    rendered = "[cyclic entry]";
  }
  if (rendered.length > MAX_ENTRY_RENDER_CHARS) {
    const elided = rendered.length - MAX_ENTRY_RENDER_CHARS;
    rendered = `${rendered.slice(0, MAX_ENTRY_RENDER_CHARS)}…(+${elided} chars)`;
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
// (`identifier` stays accepted as its parse-only alias), the `any` universal
// marker, and the relational scopes (each a nested selector slot).
const SELECTOR_KEYS: readonly string[] = [
  "text",
  "id",
  "identifier",
  "role",
  "any",
  ...SELECTOR_RELATIONS,
];

/**
 * Total number of scopes one selector may carry, counted across its whole
 * relation TREE rather than down a single branch — the selector analog of
 * MAX_WHEN_DEPTH. A size bound, not a depth bound, because each level can open
 * three branches: capping depth alone still admits 3^depth scopes, and the
 * runner's loose-alternative expansion is exponential in the number of
 * bare-string scopes (`selectorAlternatives`), so a few hundred bytes of YAML
 * could exhaust the heap before a single tree read. Bounding the count bounds
 * the depth too, so this keeps defusing the cyclic YAML alias
 * (`&s { text: x, within: *s }`) the yaml library materializes as a cyclic
 * object. Hand-authored selectors carry one or two scopes.
 */
const MAX_SELECTOR_SCOPES = 6;

function parseSelector(
  raw: unknown,
  where: string,
  budget: { scopes: number } = { scopes: MAX_SELECTOR_SCOPES }
): FlowSelector {
  if (budget.scopes < 0) {
    badEntry(
      raw,
      `${where}: a selector carries more than ${MAX_SELECTOR_SCOPES} scopes (${SELECTOR_RELATIONS.join("/")}) in total — check for a cyclic YAML alias (\`&s { …, within: *s }\`)`
    );
  }
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
  // Split off the relational scopes before field validation — each is a nested
  // selector slot (recursively parsed, every form accepted), not a field the
  // shared schema knows. A scope alone selects nothing: it only narrows WHERE
  // to look, so the selector still needs its own fields — or the explicit
  // `any: true` universal marker saying "whatever is there".
  const scopes: { [K in SelectorRelation]?: FlowSelector } = {};
  let universal = false;
  let fieldsRaw = raw;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const restRaw = { ...(raw as Record<string, unknown>) };
    const present = SELECTOR_RELATIONS.filter((relation) => relation in restRaw);
    for (const relation of present) {
      // One shared budget across the whole tree, decremented per scope: sibling
      // branches spend from it too, so three-way nesting cannot multiply.
      budget.scopes--;
      scopes[relation] = parseSelector(restRaw[relation], `${where}.${relation}`, budget);
      delete restRaw[relation];
    }
    if ("any" in restRaw) {
      if (restRaw.any !== true) {
        badEntry(
          raw,
          `${where}: \`any\` takes only \`true\` — it is the CSS \`*\` universal selector (drop the key to select by text/id/role instead)`
        );
      }
      delete restRaw.any;
      if (Object.keys(restRaw).length > 0) {
        badEntry(
          raw,
          `${where}: \`any: true\` already matches every element — drop it, or drop the ${Object.keys(
            restRaw
          )
            .map((k) => `\`${k}\``)
            .join("/")} it makes redundant`
        );
      }
      if (present.length === 0) {
        badEntry(
          raw,
          `${where}: \`any: true\` matches every element on screen — pair it with a scope (${SELECTOR_RELATIONS.join(
            "/"
          )}) so it selects something specific`
        );
      }
      universal = true;
    } else if (present.length > 0 && Object.keys(restRaw).length === 0) {
      badEntry(
        raw,
        `${where}: a selector's \`${present.join("`/`")}\` only scopes where to look — the selector still needs its own text/id/role naming what to find there (or \`any: true\` for any element)`
      );
    }
    fieldsRaw = restRaw;
  }
  const attachScopes = (sel: FlowSelector): FlowSelector => ({ ...sel, ...scopes });
  if (universal) return attachScopes({ any: true });
  // Map form: `id` is the YAML spelling of the internal `identifier` field —
  // rewrite it before schema validation. `identifier` still parses as an alias
  // (existing flow files), but a map carrying both is ambiguous and rejected.
  let normalized = fieldsRaw;
  if (fieldsRaw !== null && typeof fieldsRaw === "object" && "id" in fieldsRaw) {
    const { id, ...rest } = fieldsRaw as { id: unknown } & Record<string, unknown>;
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
      return attachScopes({ ...fields.data, textMatches: pattern });
    }
  }
  const r = selectorSchema.safeParse(normalized);
  if (!r.success) badEntry(raw, `${where}: ${r.error.issues[0]?.message ?? "invalid selector"}`);
  return attachScopes(r.data);
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
  "pinch",
  "rotate",
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
 * Does this map carry any selector key (the `any` marker and the relational
 * scopes included)? Used to tell a selector map apart from the point/option
 * forms in the gesture-body checks below, so a scoped selector mixed with
 * coordinates or options gets the same pointed rejection as any other selector
 * field.
 */
function hasSelectorField(obj: Record<string, unknown>): boolean {
  return (
    obj.text !== undefined ||
    obj.id !== undefined ||
    obj.identifier !== undefined ||
    obj.role !== undefined ||
    obj.any !== undefined ||
    SELECTOR_RELATIONS.some((relation) => obj[relation] !== undefined)
  );
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
      if (hasSelectorField(obj)) {
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
    if (hasSelectorField(obj)) {
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
    if (hasSelectorField(obj)) {
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
 * Parse a `pinch` body — options-map only (`{ on?, scale }`): unlike tap, a
 * bare `pinch: "Map"` is ambiguous (in or out?), so there is no bare form.
 * `scale` is validity-checked only (finite, > 0, ≠ 1 — a no-op scale is
 * almost certainly a mistake); there is deliberately no magnitude cap — an
 * extreme scale just decomposes into more chained gestures at run time.
 */
function parsePinch(body: unknown, entry: unknown): FlowStep {
  if (body === null || typeof body !== "object") {
    badEntry(
      entry,
      'pinch takes an options map — e.g. pinch: { on: "Map", scale: 3 } (a bare "pinch: Map" is ambiguous: in or out?)'
    );
  }
  const obj = body as Record<string, unknown>;
  if (hasSelectorField(obj)) {
    badEntry(entry, 'pinch takes a nested selector — e.g. pinch: { on: "Map", scale: 3 }');
  }
  rejectUnknownKeys(entry, obj, ["on", "scale"], "pinch");
  if (
    typeof obj.scale !== "number" ||
    !Number.isFinite(obj.scale) ||
    obj.scale <= 0 ||
    obj.scale === 1
  ) {
    badEntry(
      entry,
      "pinch.scale must be a finite number > 0 and ≠ 1 (2 = zoom in 2×, 0.5 = zoom out to half)"
    );
  }
  const step: FlowStep = { kind: "pinch", scale: obj.scale };
  if (obj.on !== undefined) step.selector = parseSelector(obj.on, "pinch.on");
  return step;
}

/**
 * Parse a `rotate` body — options-map only (`{ on?, by }`): like pinch, there
 * is no bare form (`rotate: "Map"` names no angle). `by` is degrees,
 * + clockwise / − counter-clockwise, finite, ≠ 0, and within
 * ±{@link MAX_ROTATE_BY_DEG} — the largest sweep one continuous gesture
 * delivers at the fixed run-time pace. This is the two-finger gesture — not
 * the `rotate` tool, which changes device orientation.
 */
function parseRotate(body: unknown, entry: unknown): FlowStep {
  if (body === null || typeof body !== "object") {
    badEntry(
      entry,
      'rotate takes an options map — e.g. rotate: { on: "Map", by: 90 } (an angle is required)'
    );
  }
  const obj = body as Record<string, unknown>;
  if (
    obj.text !== undefined ||
    obj.id !== undefined ||
    obj.identifier !== undefined ||
    obj.role !== undefined
  ) {
    badEntry(entry, 'rotate takes a nested selector — e.g. rotate: { on: "Map", by: 90 }');
  }
  rejectUnknownKeys(entry, obj, ["on", "by"], "rotate");
  if (typeof obj.by !== "number" || !Number.isFinite(obj.by) || obj.by === 0) {
    badEntry(entry, "rotate.by must be a finite non-zero number of degrees (+CW, −CCW)");
  }
  if (Math.abs(obj.by) > MAX_ROTATE_BY_DEG) {
    badEntry(
      entry,
      `rotate.by must be within ±${MAX_ROTATE_BY_DEG}° — one continuous gesture at ~300°/s (10 s max)`
    );
  }
  const step: FlowStep = { kind: "rotate", by: obj.by };
  if (obj.on !== undefined) step.selector = parseSelector(obj.on, "rotate.on");
  return step;
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
  // `{{secret:NAME}}` resolves only inside the text-entry tools (a `type:`
  // step), never in condition evaluation, so a guard carrying one tests for
  // literal placeholder text that is never on screen: exists/visible/text
  // guards are permanently false (the block silently skips every run) and a
  // `hidden` guard is vacuously true (the block always runs). In an assert
  // that mistake fails loudly on the first run; here the guard silently
  // degenerates into a constant — the same silently-wrong class the per-step
  // `optional:` rejection exists for, so it fails at parse too.
  const { selector, expectedText } = cond;
  // Walk the whole relation tree: a placeholder in a `within`/`after`/`next`
  // scope degrades the guard exactly as one in the target's own fields would.
  const guardStrings: (string | undefined)[] = [expectedText];
  for (const s of selectorTree(selector)) {
    guardStrings.push(s.text, s.textMatches, s.identifier, s.role);
  }
  for (const s of guardStrings) {
    if (s !== undefined && s.includes(SECRET_PLACEHOLDER_MARKER)) {
      badEntry(
        { when: raw },
        "when takes no {{secret:…}} placeholder — secrets resolve only in text-entry steps (`type:`), never in condition evaluation, so the guard tests literal placeholder text that is never on screen: permanently false (for `hidden`, vacuously true); use the literal on-screen text instead"
      );
    }
  }
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

/**
 * The report/display name of a `run:` target — its YAML basename stem. Parse
 * guarantees the stem is a safe flow name, so this is also the fragment's
 * attribution in step reports (mirroring how the CLI derives the top-level
 * flow name from the file it runs) — except when the stem collides with the
 * root flow's name, where the runner substitutes the as-written path minus
 * the extension, or `./<stem>` for a bare spelling (see runDisplayName in
 * flow-run.ts).
 */
export function runTargetName(target: string): string {
  return path.posix.basename(target, ".yaml");
}

/**
 * Shape-check a `run:` value: it must be a relative, forward-slashed path whose
 * final segment is a flow name, with the `.yaml` extension optional (see
 * {@link completeRunExtension}). `..` is deliberately legal — shared fragments
 * may live outside the flows dir, and a fragment reaching sideways to
 * `../shared/login.yaml` is a documented layout. Only the SHAPE is checked
 * here; nothing about WHERE the path lands. At run time execRunStep joins it
 * onto the containing flow file's own directory and resolves the result with
 * kernel semantics (see canonicalFlowPath in flow-run.ts) — deliberately not a
 * lexical collapse, since a `..` after a symlinked component names the parent
 * of the link's target, not of the spelling. There is no path fence at that
 * point: a target runs if the tool server can read it, and fails with that
 * file's own ENOENT if it cannot.
 */
function parseRunTarget(raw: unknown, value: unknown): string {
  // The body arrives uncoerced because YAML renders a valueless `run:` (and
  // `run: ~` / `run: null`) as null, and bare scalars as booleans/numbers.
  // String()-ing those before the checks below would hand completeRunExtension
  // the plausible names "null"/"true"/"123" — and since a bare name is now
  // ACCEPTED rather than merely advised against, a directive with no target at
  // all would silently become a live reference to a `null.yaml` that was never
  // meant to exist (and, on a filesystem where one happens to sit beside the
  // flow, would run it). The rejection is what keeps the completion below
  // applying only to targets an author actually wrote.
  if (typeof value !== "string") {
    badEntry(
      raw,
      value === null || value === undefined
        ? "`run` has no target — give it a YAML path relative to this flow's file, e.g. `run: fragments/login.yaml`"
        : "a `run` target must be a YAML path string relative to this flow's file, e.g. `run: fragments/login.yaml`"
    );
  }
  if (value.includes("\\")) {
    badEntry(raw, "a `run` path uses forward slashes, e.g. `run: fragments/login.yaml`");
  }
  // posix.isAbsolute catches `/...`; the drive-letter test catches every win32
  // device form — absolute ("C:/") and drive-RELATIVE ("C:foo", which even
  // win32.isAbsolute passes but which resolves against the drive's cwd). No
  // `\`-separated absolute survives the backslash rejection above.
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    badEntry(raw, "a `run` path must be relative to the flow file that references it");
  }
  const target = completeRunExtension(value);
  if (!target.endsWith(".yaml")) {
    if (target.toLowerCase().endsWith(".yaml")) {
      badEntry(raw, "a `run` path must use the lowercase .yaml extension");
    }
    // Reached only when completion declined the value, so the bare-name form
    // is quoted too: "must end in .yaml" alone would contradict the documented
    // rule for an author who deliberately left the extension off and tripped
    // the charset (`run: my flow`) or a trailing slash (`run: shared/`).
    badEntry(raw, "a `run` path must end in .yaml, or name a sibling flow (`run: login`)");
  }
  if (!FLOW_FILE_NAME_PATTERN.test(path.posix.basename(target))) {
    badEntry(
      raw,
      `a \`run\` target's filename must match ${FLOW_FILE_NAME_PATTERN} — letters, digits, underscore, hyphen before the .yaml`
    );
  }
  return target;
}

/**
 * Complete a `run:` target's optional `.yaml` extension: `run: login` means
 * `login.yaml` beside the containing flow file, exactly as the spelled-out
 * form does. This is the compatibility path for flows written when a `run:`
 * target was a saved-flow NAME looked up in `.argent/flows` — a bare name
 * resolves to the same file it always did, since those flows sit in that one
 * directory and a bare target anchors to their own.
 *
 * Completed HERE rather than at resolution time so exactly one spelling
 * reaches everything downstream: canonicalFlowPath's read, the fragment's
 * on-disk casing check, the report's `target`, and runDisplayName — which
 * slices a fixed `".yaml".length` off the target and would truncate a real
 * path segment given a bare one (see flow-run.ts). Re-serializing a parsed
 * flow therefore writes the completed spelling back, which is the intended
 * one-way migration.
 *
 * The test is the CANDIDATE's basename, not the supplied value's: basename()
 * strips a trailing slash, so testing `${basename(value)}.yaml` would complete
 * `shared/` to the unopenable `shared/.yaml`. Anything else the candidate
 * cannot name — a wrong extension (`login.yml`), a mis-cased one
 * (`Login.YAML`), an empty target — leaves the value untouched for the
 * caller's extension diagnostics, which name the real problem better than a
 * silent completion to `login.yml.yaml` ever could.
 */
function completeRunExtension(value: string): string {
  if (value.endsWith(".yaml")) return value;
  const candidate = `${value}.yaml`;
  return FLOW_FILE_NAME_PATTERN.test(path.posix.basename(candidate)) ? candidate : value;
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
  if ("run" in raw) return { kind: "run", flow: parseRunTarget(raw, raw.run) };
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
    // Name the missing `target` rather than letting the selector schema report
    // "expected object, received undefined" about a key the author never wrote.
    // Newly worth spelling out: `within` is now a SELECTOR key too, so
    // `scroll-to: { within: … }` reads like a scoped selector and is instead an
    // options map with no target — and the sibling scopes don't belong here at
    // all (they scope the target, which carries its own).
    if (b.target === undefined) {
      badEntry(
        raw,
        "scroll-to needs a `target` — its own `within` only anchors the gesture to a scroll " +
          "container, e.g. scroll-to: { target: <selector>, within: { id: list } }. A selector " +
          `scope (${SELECTOR_RELATIONS.join("/")}) goes inside \`target\`.`
      );
    }
    const step: FlowStep = {
      kind: "scroll-to",
      target: parseSelector(b.target, "scroll-to.target"),
      direction: (b.direction as ScrollDirection | undefined) ?? "down",
    };
    if (b.within !== undefined) step.within = parseSelector(b.within, "scroll-to.within");
    return step;
  }

  if ("pinch" in raw) return parsePinch((raw as { pinch: unknown }).pinch, raw);

  if ("rotate" in raw) return parseRotate((raw as { rotate: unknown }).rotate, raw);

  if ("snapshot" in raw) {
    const body = (raw as { snapshot: unknown }).snapshot;
    // A misspelled `maxMissmatch` would silently drop the tolerance.
    if (body !== null && typeof body === "object" && !Array.isArray(body)) {
      rejectUnknownKeys(
        raw,
        body as Record<string, unknown>,
        ["name", "maxMismatch", "cropOn"],
        "snapshot"
      );
    }
    // Bare-string sugar: `snapshot: home` ≡ `snapshot: { name: home }`.
    const b =
      typeof body === "string"
        ? { name: body }
        : (body as { name?: unknown; maxMismatch?: number; cropOn?: unknown });
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
    // `cropOn` narrows the comparison to one element's region. Selector-only —
    // a point has no extent to crop to — so it takes the standard selector slot
    // (bare-string loose / map strict), not the tap/long-press target form.
    if (b.cropOn !== undefined) {
      step.cropOn = parseSelector(b.cropOn, "snapshot.cropOn");
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
