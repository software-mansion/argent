import * as path from "node:path";
import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { MIN_SCRIPT_TIMEOUT_MS } from "@argent/configuration-core";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";
import {
  CLIENT_FILE_MARKER,
  FLOW_NAME_PATTERN,
  FLOW_FILE_NAME_PATTERN,
  SCRIPT_FILE_NAME_PATTERN,
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

export { SELECTOR_RELATIONS };
import { SECRET_PLACEHOLDER_MARKER } from "../../utils/secrets";
import { withKeyedLock } from "../../utils/keyed-lock";
import { MAX_ROTATE_BY_DEG } from "./flow-rotate-geometry";
import { describeScriptEnvProblem } from "./script/flow-script-env";

const FLOWS_DIR_NAME = path.join(".argent", "flows");

export function assertValidProjectRoot(root: string): void {
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
  if (root.split(/[\\/]+/).includes("..")) {
    throw new FailureError(`project_root must not contain ".." segments (got "${root}").`, {
      error_code: FAILURE_CODES.FLOW_PROJECT_ROOT_INVALID,
      failure_stage: "flow_project_root_dotdot",
      failure_area: "tool_server",
      error_kind: "validation",
    });
  }
}

export function flowsDirFor(root: string): string {
  return path.join(root, FLOWS_DIR_NAME);
}

function getFlowsDir(projectRoot: string): string {
  assertValidProjectRoot(projectRoot);
  return flowsDirFor(projectRoot);
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

export function getFlowPath(projectRoot: string, name: string): string {
  const flowsDir = getFlowsDir(projectRoot);
  assertSafeFlowName(name);
  const filePath = path.join(flowsDir, `${name}.yaml`);
  const rel = path.relative(flowsDir, filePath);
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

async function resolveFlowKey(projectRoot: string, name: string): Promise<string> {
  const spelled = getFlowPath(projectRoot, name);
  const inFlight = keyResolutions.get(spelled);
  if (inFlight) return inFlight;
  const resolving = canonicalFlowPath(spelled).finally(() => {
    if (keyResolutions.get(spelled) === resolving) keyResolutions.delete(spelled);
  });
  keyResolutions.set(spelled, resolving);
  return resolving;
}

/**
 * Canonical-key resolutions currently IN FLIGHT, keyed by the spelled path. A
 * sequencer, not a cache — the entry is dropped the moment it settles, so a
 * symlink repointed between two tool calls is seen.
 *
 * `realpath` runs on libuv's threadpool and so completes out of request order,
 * and every recording tool resolves its key before joining its flow file's lock
 * queue — so without this, threadpool scheduling would decide which of two tool
 * calls acquires the lock first, and a restart could land behind the append it
 * is supposed to discard. Callers spelling one path the same way share one
 * promise, so the queue they join stays FIFO.
 *
 * Two DIFFERENT spellings of one file resolve independently and so race.
 * Nothing depends on their order: mutual exclusion comes from the resolved key,
 * which is the same for both.
 */
const keyResolutions = new Map<string, Promise<string>>();

/**
 * How the flow file a caller addressed is spelled in its own directory.
 * `listed`: the directory carries that basename byte-for-byte — or its listing
 * could not be read at all (an execute-only parent lets stat through while
 * refusing readdir), which vouches for nothing and so must refuse nothing.
 * `case_folded`: no entry carries it, but one differs only by case — what a
 * case-insensitive filesystem (APFS, NTFS) opens for a spelling nothing on disk
 * has. `absent`: nothing matches even case-insensitively. `addressable` says
 * whether the on-disk spelling is one the flow layer's own ladders accept, so a
 * caller can be pointed at it instead of at a rename.
 */
export type OnDiskSpelling =
  | { state: "listed" }
  | { state: "case_folded"; actual: string; addressable: boolean }
  | { state: "absent" };

/**
 * Classify the supplied basename against `dir`'s listing. One classifier serves
 * every route that turns a caller's spelling into a file it will open — a flow,
 * or since the `script:` step a plain `.mjs` or `.sh` — so they can never drift
 * apart in which spellings they accept.
 *
 * readdir, not realpath: realpath rewrites a symlinked flow to its target's
 * name, and a flow deliberately runs — and composes — under the link's own
 * name. Every call site hands a pure-ASCII basename (the flow-name charset,
 * plus ".yaml", ".mjs" or ".sh"), so Unicode-normalizing filesystems cannot make
 * the comparison lie.
 *
 * What an `absent` verdict means is the caller's to decide, and they differ:
 * `flow_path` arrives with the boundary's stat already vouching for the file,
 * so a listing that lacks it is itself the phantom-spelling bug, while a `name`
 * may simply not name a saved flow — an ordinary missing-flow error the later
 * read reports far better than a casing complaint could.
 */
export async function classifyOnDiskSpelling(
  dir: string,
  base: string,
  addressable: RegExp = FLOW_FILE_NAME_PATTERN
): Promise<OnDiskSpelling> {
  const entries = await fs.readdir(dir).catch(() => null);
  if (entries === null || entries.includes(base)) return { state: "listed" };
  const actual = entries.find((entry) => entry.toLowerCase() === base.toLowerCase());
  if (actual === undefined) return { state: "absent" };
  return { state: "case_folded", actual, addressable: addressable.test(actual) };
}

export type FlowPersistMode = "host" | "client";

export interface RecordedStepWarning {
  warning: string;
  kind: "conversion" | "wait" | "env";
  step: string;
}

export interface RecordingSession {
  name: string;
  projectRoot: string;
  key: string;
  persist: FlowPersistMode;
  filePath: string;
  flow: FlowFile;
  stepWarnings?: Map<number, RecordedStepWarning>;
  discardedWarnings?: number;
  lastTouchedSeq: number;
}

/**
 * Live recordings, keyed by {@link resolveFlowKey} — the identity of the
 * artifact being built, as the FILESYSTEM resolves it rather than as a caller
 * spelled it. Two sessions on one key mean two writers on one output file (a
 * collision, reported as a restart); two different keys are two different
 * files, so concurrent agents recording different flows never write into each
 * other's take.
 *
 * The one window the key does not close: two starts BOTH in flight before
 * either has created its file. Neither realpath can see a file that is not
 * there yet, so two spellings of one not-yet-existing file resolve apart and
 * both writes land on one file. It closes itself on the next call — the file
 * exists by then, so both spellings resolve together and the loser fails in
 * {@link requireRecordingSession} rather than silently mixing takes.
 *
 * The singleton is per install bundle, not per machine: `stateFileForBundle`
 * gives each install its own record and autospawn takes a free port. Across
 * that boundary there is nothing — two installs recording the same
 * (project_root, name) hold two of these maps and cannot see each other, so
 * each believes its own session is live while the other truncates and appends.
 * What still holds is {@link writeFlowFile}'s temp-file swap: each write stays
 * whole, but a lost update is not prevented.
 */
const recordings = new Map<string, RecordingSession>();

/**
 * Serializes every mutation of ONE flow file: an append, the reset+register a
 * `flow-start-recording` performs, and the read+clear a `flow-finish-recording`
 * performs. Each is a read/await/write straddling at least one microtask, and
 * Express dispatches tool calls concurrently, so without this two of them
 * interleave and one silently loses.
 *
 * Keyed by the flow path, NOT by the session object: a restart *replaces* the
 * session, so a lock the session owned could not exclude the very operation
 * that supersedes it — the restart would truncate the file while an append from
 * the discarded take was mid-flight, and that step would land in the new take.
 *
 * Per file, not global: two recordings write two different files and must not
 * queue behind each other.
 */
const flowFileLocks = new Map<string, Promise<unknown>>();

async function withFlowLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return withKeyedLock(flowFileLocks, key, fn);
}

export async function withFlowFileLock<T>(
  projectRoot: string,
  name: string,
  fn: () => Promise<T>
): Promise<T> {
  return withFlowLock(await resolveFlowKey(projectRoot, name), fn);
}

export const MAX_RECORDINGS = 32;

let touchSeq = 0;
function touch(): number {
  return ++touchSeq;
}

function evictIfOverCapacity(): void {
  while (recordings.size > MAX_RECORDINGS) {
    let oldestKey: string | undefined;
    let oldestSeq = Infinity;
    for (const [key, session] of recordings) {
      if (session.lastTouchedSeq < oldestSeq) {
        oldestSeq = session.lastTouchedSeq;
        oldestKey = key;
      }
    }
    if (oldestKey === undefined) return;
    recordings.delete(oldestKey);
  }
}

interface RecordingSessionInit {
  name: string;
  projectRoot: string;
  persist: FlowPersistMode;
  filePath: string;
  flow: FlowFile;
}

export async function startRecordingSession(
  init: RecordingSessionInit
): Promise<RecordingSession | null> {
  const key = await resolveFlowKey(init.projectRoot, init.name);
  const previous = recordings.get(key) ?? null;
  recordings.set(key, { ...init, key, lastTouchedSeq: touch() });
  evictIfOverCapacity();
  return previous;
}

export async function getRecordingSession(
  projectRoot: string,
  name: string
): Promise<RecordingSession | undefined> {
  return recordings.get(await resolveFlowKey(projectRoot, name));
}

export function listActiveRecordings(): { name: string; projectRoot: string; steps: number }[] {
  return [...recordings.values()].map((s) => ({
    name: s.name,
    projectRoot: s.projectRoot,
    steps: s.flow.steps.length,
  }));
}

export async function requireRecordingSession(
  projectRoot: string,
  name: string
): Promise<RecordingSession> {
  const session = await getRecordingSession(projectRoot, name);
  if (!session) {
    // Name what is live so the agent can self-correct: with concurrent
    // recordings the usual cause is a typo in `name` or the wrong
    // `project_root`. Only this project's recordings are named; the others are
    // counted, because a tool-server bound beyond loopback is shared by
    // unrelated callers whose flow names and absolute project paths are not
    // this caller's to see.
    const active = listActiveRecordings();
    const hereDir = getFlowsDir(projectRoot);
    const here = active.filter((r) => getFlowsDir(r.projectRoot) === hereDir);
    const elsewhere = active.length - here.length;
    const others = elsewhere > 0 ? ` (plus ${elsewhere} in other projects)` : "";
    const activeList = here.length
      ? `${here.map((r) => `"${r.name}"`).join(", ")}${others}`
      : `none in this project${others}`;
    // Do NOT tell the agent to just call flow-start-recording. This message is
    // reached when the key was never started, but equally when a take was
    // finished or dropped by the MAX_RECORDINGS backstop — where the flow file
    // on disk is fully populated while no session owns it. flow-start-recording
    // truncates unconditionally, so the advice that recovers the never-started
    // case destroys the others. Same doctrine as
    // {@link assertSessionStillLive}, which faces the identical ambiguity.
    throw new FailureError(
      `No active recording for flow "${name}" in ${projectRoot}. ` +
        `If you have not started it yet, call flow-start-recording — but note it ` +
        `truncates, so if ${getFlowPath(projectRoot, name)} already holds a take you ` +
        `want (finished, or interrupted by a restart), copy it aside or record under ` +
        `a fresh name instead. Active recordings: ${activeList}.`,
      {
        error_code: FAILURE_CODES.FLOW_NO_ACTIVE_RECORDING,
        failure_stage: "flow_require_recording",
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
  }
  const asked = getFlowPath(projectRoot, name);
  const held = getFlowPath(session.projectRoot, session.name);
  if (asked !== held) {
    throw new FailureError(
      `Recording of "${name}" in ${projectRoot} is not registered under that spelling — ${held} ` +
        `and ${asked} are the same file on this filesystem (a symlink, or a case-insensitive ` +
        `volume), and the live take on it is registered as "${session.name}" in ` +
        `${session.projectRoot}. If that is your own recording spelled another way, re-address ` +
        `it exactly as you passed it to flow-start-recording — the take is intact and still ` +
        `recording. If it is another caller's, their flow-start-recording truncated yours; ` +
        `record under a name that resolves to its own file rather than restarting here, which ` +
        `would destroy their take in turn.`,
      {
        error_code: FAILURE_CODES.FLOW_NO_ACTIVE_RECORDING,
        failure_stage: "flow_recording_key_aliased",
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
  }
  session.lastTouchedSeq = touch();
  return session;
}

/**
 * Retire a finished recording, by the key the session actually HOLDS rather
 * than a fresh resolution of its spelling — the same choice
 * {@link appendStepToFlow} makes. A key that moved under the session (a
 * symlinked flow file whose target went away mid-recording) re-resolves to
 * something this map does not hold, so the delete would miss silently: the
 * finish reports success while the session stays live, unfinishable, and
 * holding the key against its own restart.
 */
export function clearRecordingSession(session: RecordingSession): void {
  recordings.delete(session.key);
}

export function __resetRecordingsForTesting(): void {
  recordings.clear();
  flowFileLocks.clear();
  keyResolutions.clear();
}

export function __flowFileLockCountForTesting(): number {
  return flowFileLocks.size;
}

export type ChromiumLaunch = string | { path: string; args?: string[] };

export type Launch =
  | string
  | {
      native?: string;
      ios?: string;
      android?: string;
      vega?: string;
      chromium?: ChromiumLaunch;
    };

export type ScrollDirection = "up" | "down" | "left" | "right";

/**
 * Direction of a `swipe` — the FINGER's travel, the opposite sense of
 * `scroll-to`'s content direction: `swipe: left` reveals what is to the right.
 */
export type SwipeDirection = "up" | "down" | "left" | "right";

export type GestureTarget = { selector: FlowSelector } | { x: number; y: number };

/**
 * A selector as a flow step carries it: the shared {@link Selector} plus an
 * internal `loose` flag, set when the selector came from bare-string sugar
 * (`tap: foo`). A loose selector resolves identifier-first, then falls back to
 * text (label/value), so a hand-written `foo` matches `testID="foo"` as well as
 * visible text. The flag is honored only by the flow runner (`flow-actions.ts`)
 * and never serialized as a field — the YAML spelling carries it exactly (bare
 * string ⇔ loose, map ⇔ strict; `selectorToYaml`/`parseSelector` are inverses)
 * — and it is never forwarded into a tool's input.
 *
 * The relational slots re-narrow to FlowSelector so the flag survives at every
 * nesting level: a map selector is itself always strict, but its scope may be a
 * bare string (`within: profile-card`), and that level keeps the fallback. Only
 * a bare string can be loose and it carries no relation of its own, so a loose
 * level is always a LEAF of the relation tree — the runner's alternative
 * expansion relies on this shape.
 *
 * `any` is the universal selector (CSS `*`): no own constraint, so the parser
 * accepts it only paired with a relation. The match engine needs no field for
 * it — a selector with no own fields already matches every node — so it stays
 * on this flow-side type and is dropped before the engine sees the selector
 * (see `selectorAlternatives`).
 */
export type FlowSelector = Omit<Selector, "within" | "after" | "next"> & {
  loose?: boolean;
  any?: boolean;
  within?: FlowSelector;
  after?: FlowSelector;
  next?: FlowSelector;
};

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

export type WhenPlatform = (typeof LAUNCH_PLATFORMS)[number];

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
  | {
      kind: "swipe";
      from?: GestureTarget;
      direction?: SwipeDirection;
      to?: GestureTarget;
      by?: { x?: number; y?: number };
      momentum?: boolean;
      duration?: number;
    }
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
  | { kind: "idle"; timeout?: number; stableFor?: number }
  | { kind: "wait"; ms: number }
  | { kind: "scroll-to"; target: FlowSelector; direction: ScrollDirection; within?: FlowSelector }
  | { kind: "pinch"; selector?: FlowSelector; scale: number }
  | { kind: "rotate"; selector?: FlowSelector; by: number }
  | { kind: "snapshot"; name: string; maxMismatch?: number; cropOn?: FlowSelector }
  | { kind: "script"; path: string; timeout?: number; env?: ScriptEnv };

/**
 * Environment values a `script` step's process reads from its environment —
 * `process.env` under Node, `$NAME` under bash, since the extension decides
 * which. Strings, matching what an environment can carry; a name matching
 * `[A-Za-z_][A-Za-z0-9_]*`. A value may hold `{{secret:NAME}}`, resolved on the
 * machine running the tool server just before the process starts.
 */
export type ScriptEnv = Record<string, string>;

export type FlowFile = {
  executionPrerequisite: string;
  /**
   * Flow-level environment DEFAULTS for every `script` step in this file, and
   * in the fragments it composes with `run:`. A default at any depth, so a
   * `flow-execute` run-time value overrides it; a step's own `env` is not a
   * default and wins over both.
   *
   * Modelled here rather than read straight off the YAML because
   * {@link serializeFlow} rebuilds the whole document from this type: a key
   * missing from it would be deleted by the next recorded step.
   */
  env?: ScriptEnv;
  steps: FlowStep[];
};

export function blockSteps(step: FlowStep): FlowStep[] | undefined {
  return isBlockStep(step) ? (step.steps satisfies FlowStep[]) : undefined;
}

export function isBlockStep(step: FlowStep): step is BlockStep {
  return isBlockDirectiveKey(step.kind);
}

export function precedesLeadingLaunch(step: FlowStep): boolean {
  switch (step.kind) {
    case "echo":
    case "script":
      return true;
    case "launch":
    case "run":
    case "when":
    case "tool":
    case "tap":
    case "long-press":
    case "swipe":
    case "type":
    case "await":
    case "assert":
    case "idle":
    case "wait":
    case "scroll-to":
    case "pinch":
    case "rotate":
    case "snapshot":
      return false;
    default: {
      const unclassified: never = step;
      void unclassified;
      return false;
    }
  }
}

function isE2eFlow(flow: FlowFile): boolean {
  const first = flow.steps.find((s) => !precedesLeadingLaunch(s));
  return first?.kind === "launch";
}

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

export function chromiumLaunchSpec(
  launch: Launch | undefined
): { path: string; args?: string[] } | null {
  if (launch === undefined) return null;
  if (typeof launch === "string") return { path: launch };
  const c = launch.chromium;
  if (c === undefined) return null;
  return typeof c === "string" ? { path: c } : { path: c.path, args: c.args };
}

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

type YamlTarget = YamlSelector | { x: number; y: number };

type TapBody = YamlTarget | { on: YamlTarget; times?: number };

type SwipeBody =
  | SwipeDirection
  | {
      from?: YamlTarget;
      direction?: SwipeDirection;
      to?: YamlTarget;
      by?: { x?: number; y?: number };
      momentum?: boolean;
      duration?: number;
    };

type YamlWaitCondition =
  | { exists: YamlSelector }
  | { visible: YamlSelector }
  | { hidden: YamlSelector }
  | { text: { in: YamlSelector; contains: string } }
  | { text: { in: YamlSelector; equals: string } }
  | { text: { in: YamlSelector; matches: string } };

type YamlTextWaitCondition = Extract<YamlWaitCondition, { text: unknown }>;

type YamlIdleCondition = { idle: true; stableFor?: number; timeout?: number };

type YamlScrollBody =
  | YamlSelector
  | { target: YamlSelector; direction?: ScrollDirection; within?: YamlSelector };

type YamlWhenBody = YamlWaitCondition | { platform: WhenPlatform };

type YamlStep =
  | { echo: string }
  | { launch: Launch }
  | { run: string }
  | { when: YamlWhenBody; steps: YamlStep[] }
  | { tool: string; args?: Record<string, unknown>; delayMs?: number }
  | { tap: TapBody }
  | { "long-press": YamlTarget | { on: YamlTarget; duration?: number } }
  | { swipe: SwipeBody }
  | { type: { into: YamlSelector; text: string; submit?: boolean } }
  | { await: (YamlWaitCondition & { timeout?: number }) | YamlIdleCondition }
  | { assert: YamlWaitCondition }
  | { wait: number }
  | { "scroll-to": YamlScrollBody }
  | { pinch: { on?: YamlSelector; scale: number } }
  | { rotate: { on?: YamlSelector; by: number } }
  | { snapshot: string | { name: string; maxMismatch?: number; cropOn?: YamlSelector } }
  | { script: { path: string; timeout?: number; env?: ScriptEnv } };

type YamlFlowFile = {
  env?: ScriptEnv;
  executionPrerequisite?: string;
  steps: YamlStep[];
};

/**
 * Sugar a selector for YAML output: a LOOSE text-only selector collapses to a
 * bare string (`{ text: "Login", loose: true }` → `"Login"`); everything else —
 * including a strict `{ text }` — keeps the map form. `parseSelector` is the
 * exact inverse (bare string ⇒ loose, map ⇒ strict). Collapsing a strict text
 * selector too would promote it to loose on re-parse, sending it through the
 * identifier-first fallback it was never verified against — e.g. a
 * recorder-captured `{ text: "Save" }` hijacked by a `testID="save"` elsewhere
 * on screen.
 */
export function selectorToYaml(sel: FlowSelector): YamlSelector {
  const unknown = Object.keys(sel).filter((key) => !WRITABLE_SELECTOR_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new Error(
      `Cannot serialize flow selector: ${describeUnknownKeys(unknown, WRITABLE_SELECTOR_KEYS)} - ` +
        `allowed keys: ${WRITABLE_SELECTOR_KEYS.join(", ")}.`
    );
  }

  if (sel.text !== undefined && sel.textMatches !== undefined) {
    throw new Error(
      "Cannot serialize flow selector without losing constraints: both `text` and " +
        "`textMatches` are set, but flow YAML can represent only one `text` constraint " +
        '(a literal string or `{ matches: "<regex>" }`). Use either literal or regex text matching.'
    );
  }

  if (sel.text !== undefined && (typeof sel.text !== "string" || !hasVisibleText(sel.text))) {
    throw new Error(
      "Cannot serialize flow selector: `text` must contain at least one visible character " +
        "(icon-font/private-use and zero-width characters render as nothing). Select by " +
        "identifier or role, or use a coordinate tap."
    );
  }

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

// eslint-disable-next-line no-control-regex
const INLINE_UNSAFE = /[\u0000-\u001f\u007f-\u009f]/g;
const INLINE_SHORT: Record<string, string> = {
  "\b": "\\b",
  "\t": "\\t",
  "\n": "\\n",
  "\f": "\\f",
  "\r": "\\r",
};

/**
 * A value going inline into a one-line label, with its control characters
 * spelled the way JSON spells them: a raw newline in a selector field splits a
 * report step across two lines, and a raw escape byte repaints the reader's
 * terminal. ONLY the control characters — a backslash in a regex source or an
 * identifier is content, and doubling it would print a pattern nobody could
 * copy back into the .yaml.
 */
export function escapeInline(value: string): string {
  return value.replace(
    INLINE_UNSAFE,
    (c) => INLINE_SHORT[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

export function describeSelector(s: FlowSelector): string {
  const { loose: _loose, any, within, after, next, ...rest } = s;
  const scopes = { within, after, next };
  const fields = Object.entries(rest)
    .map(([k, v]) =>
      k === "textMatches"
        ? `text=/${escapeInline(String(v))}/`
        : `${k === "identifier" ? "id" : k}=${JSON.stringify(String(v))}`
    )
    .join(" ");
  const parts = [any ? "*" : undefined, fields || undefined].filter((p) => p !== undefined);
  for (const relation of SELECTOR_RELATIONS) {
    const scope = scopes[relation];
    if (scope !== undefined) parts.push(`${relation} (${describeSelector(scope)})`);
  }
  return parts.join(" ");
}

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

/** Serialize a swipe's `from`/`to`, adding the unknown-key check parseTarget
 * applies to a coordinate target. It cannot live in targetToYaml: `tap` and
 * `long-press` hand that the whole FlowStep, whose own keys are legitimate
 * there. */
function swipeTargetToYaml(target: GestureTarget, label: string): YamlTarget {
  const yaml = targetToYaml(target);
  if (
    typeof yaml !== "string" &&
    "x" in yaml &&
    !Object.keys(target).every((key) => key === "x" || key === "y")
  ) {
    throw new Error(`Cannot serialize flow ${label}: a coordinate target takes only { x, y }`);
  }
  return yaml;
}

/**
 * The tap/swipe boundary, not a magnitude policy: a travel-vector magnitude
 * under the platform recognizers' slop (~8dp Android, ~10pt iOS) is read as a
 * tap. One conservative NORMALIZED floor, because the flow layer has no point
 * dimensions to convert the physical slop with: 0.03 sits at or just above the
 * slop on the narrowest axis of any phone, at the cost of over-rejecting a thin
 * band of deliverable travel on longer axes.
 */
export const SWIPE_MIN_TRAVEL = 0.03;

/**
 * The same boundary on the TIME axis: gesture-swipe interpolates one move per
 * ~16ms frame, so a sub-floor duration leaves the content too few of them to
 * track the travel and it overshoots by multiples (0.6 of the screen at 16ms
 * moves iOS 14343px, against 1247px at the default 300ms). The overshoot decays
 * with the frame count rather than switching off, so this is an envelope, not a
 * cliff. 150ms is also the wall clock `momentum: false`'s ease-out needs to read
 * as a stop rather than a flick; a genuinely sub-floor flick belongs in a raw
 * `tool: gesture-swipe` step.
 */
const SWIPE_MIN_DURATION_MS = 150;

/**
 * The other end of the same axis, about cost rather than fidelity: the dispatch
 * is one real 16ms sleep per frame with the finger held down, so `duration` is
 * wall clock the run spends and wall clock the device spends under a touch
 * nothing can cancel from outside. `duration: 1e21` cleared every other check
 * and never returned. 10s is the envelope MAX_DERIVED_ROTATE_MS already sets for
 * one continuous gesture, an order of magnitude above the 300ms default.
 */
const SWIPE_MAX_DURATION_MS = 10_000;

/**
 * The same ceiling on `long-press.duration`: a held finger costs wall clock
 * whether it travels or not. Written as the swipe bound because on Chromium it
 * IS that bound - a long-press dispatches `gesture-drag` with from == to - so
 * the two cannot drift without the flow parsing clean and then dying inside the
 * registry on one platform. Bounded at parse so the author hears about it at
 * authoring time, on every platform.
 */
const LONG_PRESS_MAX_DURATION_MS = SWIPE_MAX_DURATION_MS;

function swipeByToYaml(by: { x?: number; y?: number }): { x?: number; y?: number } {
  const keys = Object.keys(by);
  if (keys.some((key) => key !== "x" && key !== "y")) {
    throw new Error("Cannot serialize flow swipe.by: accepts only x and y");
  }

  const axes = (["x", "y"] as const).filter((axis) => by[axis] !== undefined);
  if (axes.length === 0) {
    throw new Error("Cannot serialize flow swipe.by: needs at least one of x or y");
  }

  const result: { x?: number; y?: number } = {};
  for (const axis of axes) {
    const value = by[axis]!;
    if (!Number.isFinite(value) || value === 0 || value < -1 || value > 1) {
      throw new Error(
        `Cannot serialize flow swipe.by.${axis}: must be a non-zero fraction of the screen between -1 and 1`
      );
    }
    result[axis] = value;
  }
  const magnitude = Math.hypot(result.x ?? 0, result.y ?? 0);
  if (magnitude < SWIPE_MIN_TRAVEL) {
    throw new Error(
      `Cannot serialize flow swipe.by: travels only ${magnitude} — below the minimum swipe travel of ${SWIPE_MIN_TRAVEL} — a travel that small is a tap, not a swipe`
    );
  }
  return result;
}

export function swipeByLabel(by: { x?: number; y?: number }): string {
  return (["x", "y"] as const)
    .filter((axis) => by[axis] !== undefined)
    .map((axis) => `${axis}=${by[axis]}`)
    .join(", ");
}

function isPositiveMs(raw: unknown): raw is number {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0;
}

function positiveMsToYaml(value: number, label: string): number {
  if (!isPositiveMs(value)) {
    throw new Error(`Cannot serialize flow ${label}: needs a positive number of milliseconds`);
  }
  return value;
}

function swipeDurationToYaml(value: number): number {
  const duration = positiveMsToYaml(value, "swipe.duration");
  if (duration < SWIPE_MIN_DURATION_MS) {
    throw new Error(
      `Cannot serialize flow swipe.duration: only ${duration}ms — below the minimum swipe duration of ${SWIPE_MIN_DURATION_MS}ms — that leaves too few 16ms frames for the content to track the travel it was given, so it overshoots instead of landing on it`
    );
  }
  if (duration > SWIPE_MAX_DURATION_MS) {
    throw new Error(
      `Cannot serialize flow swipe.duration: ${duration}ms - above the maximum swipe duration of ${SWIPE_MAX_DURATION_MS}ms - the step would hold a finger on the screen for exactly that long, one dispatched frame per 16ms`
    );
  }
  return duration;
}

function longPressDurationToYaml(value: number): number {
  const duration = positiveMsToYaml(value, "long-press.duration");
  if (duration > LONG_PRESS_MAX_DURATION_MS) {
    throw new Error(
      `Cannot serialize flow long-press.duration: ${duration}ms - above the maximum long-press duration of ${LONG_PRESS_MAX_DURATION_MS}ms - the step would hold a finger down for exactly that long`
    );
  }
  return duration;
}

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
  if (timeoutMs !== undefined) body.timeout = positiveMsToYaml(timeoutMs, "await.timeout");
  return body;
}

function idleToYaml(step: Extract<FlowStep, { kind: "idle" }>): YamlStep {
  const body: YamlIdleCondition = { idle: true };
  if (step.stableFor !== undefined) body.stableFor = step.stableFor;
  if (step.timeout !== undefined) body.timeout = step.timeout;
  return { await: body };
}

function toYamlStep(step: FlowStep): YamlStep {
  switch (step.kind) {
    case "echo":
      return { echo: step.message };
    case "idle":
      return idleToYaml(step);
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
      const target = targetToYaml(step);
      return { tap: step.times !== undefined ? { on: target, times: step.times } : target };
    }
    case "long-press": {
      const target = targetToYaml(step);
      return {
        "long-press":
          step.duration !== undefined
            ? { on: target, duration: longPressDurationToYaml(step.duration) }
            : target,
      };
    }
    case "swipe": {
      const travels = (["direction", "to", "by"] as const).filter((key) => step[key] !== undefined);
      if (travels.length !== 1) {
        throw new Error("Cannot serialize flow swipe: needs exactly one of direction, to, or by");
      }

      if (step.momentum !== undefined && typeof step.momentum !== "boolean") {
        throw new Error("Cannot serialize flow swipe.momentum: must be true or false");
      }

      if (
        step.direction !== undefined &&
        step.from === undefined &&
        step.to === undefined &&
        step.by === undefined &&
        step.momentum !== false &&
        step.duration === undefined
      ) {
        return { swipe: step.direction };
      }
      const body: Exclude<SwipeBody, SwipeDirection> = {};
      if (step.from !== undefined) body.from = swipeTargetToYaml(step.from, "swipe.from");
      if (step.direction !== undefined) body.direction = step.direction;
      if (step.to !== undefined) body.to = swipeTargetToYaml(step.to, "swipe.to");
      if (step.by !== undefined) body.by = swipeByToYaml(step.by);
      if (step.momentum === false) body.momentum = false;
      if (step.duration !== undefined) body.duration = swipeDurationToYaml(step.duration);
      return { swipe: body };
    }
    case "type": {
      const body: { into: YamlSelector; text: string; submit?: boolean } = {
        into: selectorToYaml(step.into),
        text: step.text,
      };
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
      return {
        pinch: step.selector
          ? { on: selectorToYaml(step.selector), scale: step.scale }
          : { scale: step.scale },
      };
    case "rotate":
      return {
        rotate: step.selector
          ? { on: selectorToYaml(step.selector), by: step.by }
          : { by: step.by },
      };
    case "snapshot": {
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
    case "script": {
      const body: { path: string; timeout?: number; env?: ScriptEnv } = { path: step.path };
      if (step.timeout !== undefined) body.timeout = step.timeout;
      // Emitted whenever the step carries one, empty included — the rule
      // `serializeFlow` states for the top-level map, and for its reason:
      // `parseScriptStep` sets `env` from the KEY's presence, not from its
      // size, so dropping an empty map makes parseFlow(serializeFlow(x))
      // something other than the identity and deletes an `env: {}` the author
      // wrote as soon as the next step is appended.
      if (step.env) body.env = { ...step.env };
      return { script: body };
    }
    case "tool": {
      const y: { tool: string; args?: Record<string, unknown>; delayMs?: number } = {
        tool: step.name,
      };
      if (Object.keys(step.args).length > 0) y.args = step.args;
      if (step.delayMs !== undefined) y.delayMs = step.delayMs;
      return y;
    }
    default: {
      const unserialized: never = step;
      void unserialized;
      throw new Error(
        `internal: no YAML spelling for step kind "${(unserialized as FlowStep).kind}"`
      );
    }
  }
}

// Ceiling on how much of the offending entry a diagnostic echoes. The entry is
// not always a hand-authored flow step: a mistyped `run:` path can select any
// in-project YAML file, and this message travels verbatim into
// StepReport.reason — which `argent flow run` prints to stdout and
// flowRunToMcpContent emits into the agent's context — so an unbounded render
// would ship that file's values (multi-KB payloads, secrets) to both surfaces.
// 200 chars still shows a genuine flow entry in full.
const MAX_ENTRY_RENDER_CHARS = 200;

function badEntry(raw: unknown, detail: string): never {
  // A cyclic YAML alias materializes as a cyclic object — JSON.stringify would
  // throw and mask the validation message.
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

function parsePositiveMs(raw: unknown, entry: unknown, label: string, example: string): number {
  if (!isPositiveMs(raw)) {
    badEntry(entry, `${label} needs a positive number of milliseconds (e.g. \`${example}\`)`);
  }
  return raw;
}

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
  return best !== null && bestDistance <= Math.max(1, Math.floor(best.length / 3)) ? best : null;
}

function describeUnknownKeys(unknown: string[], allowed: readonly string[]): string {
  const listed = unknown.map((k) => {
    const hint = closestKey(k, allowed);
    return hint ? `\`${k}\` (did you mean \`${hint}\`?)` : `\`${k}\``;
  });
  return `unknown key${unknown.length > 1 ? "s" : ""} ${listed.join(", ")}`;
}

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

const SELECTOR_KEYS: readonly string[] = [
  "text",
  "id",
  "identifier",
  "role",
  "any",
  ...SELECTOR_RELATIONS,
];

const WRITABLE_SELECTOR_KEYS = Object.keys({
  text: true,
  textMatches: true,
  identifier: true,
  role: true,
  any: true,
  loose: true,
  within: true,
  after: true,
  next: true,
} satisfies Record<keyof FlowSelector, true>);

/**
 * Total scopes one selector may carry, counted across its whole relation TREE
 * rather than down a single branch. A size bound, not a depth bound, because
 * each level can open three branches: capping depth alone still admits 3^depth
 * scopes, and the runner's loose-alternative expansion is exponential in the
 * number of bare-string scopes (`selectorAlternatives`), so a few hundred bytes
 * of YAML could exhaust the heap before a single tree read. Bounding the count
 * bounds the depth too, so this also defuses the cyclic YAML alias
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
  if (typeof raw === "string") {
    const r = selectorSchema.safeParse({ text: raw });
    if (!r.success) badEntry(raw, `${where}: ${r.error.issues[0]?.message ?? "invalid selector"}`);
    return { ...r.data, loose: true };
  }
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    rejectUnknownKeys(raw, raw as Record<string, unknown>, SELECTOR_KEYS, `${where}: selector`);
  }
  const scopes: { [K in SelectorRelation]?: FlowSelector } = {};
  let universal = false;
  let fieldsRaw = raw;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const restRaw = { ...(raw as Record<string, unknown>) };
    const present = SELECTOR_RELATIONS.filter((relation) => relation in restRaw);
    for (const relation of present) {
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
  let normalized = fieldsRaw;
  if (fieldsRaw !== null && typeof fieldsRaw === "object" && "id" in fieldsRaw) {
    const { id, ...rest } = fieldsRaw as { id: unknown } & Record<string, unknown>;
    if ("identifier" in rest) {
      badEntry(raw, `${where}: selector takes \`id\` or \`identifier\` (its alias), not both`);
    }
    normalized = { ...rest, identifier: id };
  }
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

function parseWaitFields(raw: unknown, kind: "await" | "assert" | "when"): WaitFields {
  const legalKeys = kind === "await" ? [...WAIT_CONDITIONS, IDLE_CONDITION] : WAIT_CONDITIONS;
  if (raw === null || typeof raw !== "object") {
    badEntry({ [kind]: raw }, `${kind} needs a condition (${legalKeys.join(", ")})`);
  }
  const b = raw as Record<string, unknown>;

  const present = WAIT_CONDITIONS.filter((c) => c in b);
  if (present.length !== 1) {
    badEntry({ [kind]: b }, `${kind} needs exactly one condition key (${legalKeys.join(", ")})`);
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
    timeout = parsePositiveMs(b.timeout, { [kind]: b }, "await.timeout", "timeout: 10000");
  }

  rejectUnknownKeys(
    { [kind]: b },
    b,
    kind === "await" ? [...WAIT_CONDITIONS, "timeout"] : WAIT_CONDITIONS,
    kind
  );

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

const IDLE_CONDITION = "idle";

export const IDLE_DEFAULT_TIMEOUT_MS = 7500;
export const IDLE_DEFAULT_STABLE_FOR_MS = 250;

export const IDLE_POLL_MS = 200;

/**
 * How many consecutive intervals must read as still before the screen is called
 * settled. Two, not one, because a single agreeing pair of captures is not
 * evidence of stillness: any animation that reverses — a cross-fade, a pulse, a
 * bounce — has a turning point, and two samples straddling it come back
 * identical while the screen is very much moving. Observed on a 3s cross-fade,
 * where a default-shaped step passed on roughly one run in three. A second
 * agreeing interval needs a third sample, which the same phase symmetry cannot
 * supply unless the animation's period happens to match the poll.
 */
export const IDLE_MIN_STILL_INTERVALS = 2;

export const IDLE_SETTLE_SPAN_MS = IDLE_MIN_STILL_INTERVALS * IDLE_POLL_MS;

/**
 * The smallest `timeout:` that can contain a settle holding for `stableFor`.
 * Below it no screen, however still, can produce a clean settle, so the step
 * reports on a screen it never had the chance to judge.
 *
 * The hold is measured ACROSS the polls, not after them: the runner starts the
 * hold clock on the first read that carries content and settles on the first
 * round that has both {@link IDLE_MIN_STILL_INTERVALS} agreeing intervals AND
 * `stableFor` of elapsed hold. The two costs overlap, so the wait must contain
 * whichever is longer — plus one poll, the budget the closing round needs to be
 * allowed to start (the runner's MIN_ROUND_BUDGET_MS).
 *
 * Adding them instead over-demanded by up to {@link IDLE_SETTLE_SPAN_MS}:
 * `timeout: 1000, stableFor: 800` was rejected as impossible and settles in
 * ~820ms. The two agree exactly at `stableFor: 0`, where the sum was derived.
 */
export function idleMinimumTimeoutMs(stableFor: number): number {
  return Math.max(IDLE_SETTLE_SPAN_MS, stableFor) + IDLE_POLL_MS;
}

const IDLE_MAX_STABLE_FOR_MS = 600_000;

function parseAwaitTimeout(entry: unknown, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    badEntry(
      entry,
      "await.timeout needs a positive number of milliseconds (e.g. `timeout: 10000`)"
    );
  }
  return value as number;
}

function parseBoundedMs(entry: unknown, value: unknown, where: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
    badEntry(entry, `${where} needs an integer between 0 and ${max} (milliseconds)`);
  }
  return value as number;
}

function parseIdleFields(raw: Record<string, unknown>, kind: "await" | "assert"): FlowStep {
  const entry = { [kind]: raw };

  if (kind !== "await") {
    const mixed = WAIT_CONDITIONS.filter((c) => c in raw);
    badEntry(
      entry,
      "idle has no assert form — it waits for the screen to stop changing, which is an `await`" +
        (mixed.length > 0
          ? `. Give it its own step as \`await: { idle: true }\` and leave \`${mixed.join(
              "`, `"
            )}\` in the assert — a step checks exactly one condition`
          : "")
    );
  }
  rejectUnknownKeys(entry, raw, ["idle", "stableFor", "timeout"], kind);

  if (raw.idle !== true) {
    badEntry(entry, "idle takes only `true` (`await: { idle: true }`)");
  }

  const step: Extract<FlowStep, { kind: "idle" }> = { kind: "idle" };
  if ("timeout" in raw) step.timeout = parseAwaitTimeout(entry, raw.timeout);
  if (raw.stableFor !== undefined) {
    step.stableFor = parseBoundedMs(entry, raw.stableFor, "idle.stableFor", IDLE_MAX_STABLE_FOR_MS);
  }

  const timeoutMs = step.timeout ?? IDLE_DEFAULT_TIMEOUT_MS;
  const stableFor = step.stableFor ?? IDLE_DEFAULT_STABLE_FOR_MS;
  const needed = idleMinimumTimeoutMs(stableFor);
  if (timeoutMs < needed) {
    badEntry(
      entry,
      `idle needs a timeout of at least ${needed}ms to hold still for ` +
        `${step.stableFor === undefined ? `the default ` : ``}${stableFor}ms: a settle is ` +
        `${IDLE_MIN_STILL_INTERVALS + 1} reads spanning ${IDLE_MIN_STILL_INTERVALS} ` +
        `${IDLE_POLL_MS}ms polls, and the hold is counted across those polls rather than after ` +
        `them — so the wait has to contain whichever of the two is longer, plus the ` +
        `${IDLE_POLL_MS}ms of budget the closing round has to have left to be allowed to start. ` +
        `Raise ` +
        `\`timeout\`${step.stableFor === undefined ? "" : " or lower `stableFor`"}`
    );
  }
  return step;
}

function isIdleCondition(raw: unknown, kind: "await" | "assert"): boolean {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return false;
  const body = raw as Record<string, unknown>;
  if (!(IDLE_CONDITION in body)) return false;
  if (kind === "assert") return true;
  const selectorConditions = WAIT_CONDITIONS.filter((c) => c in body);
  if (selectorConditions.length > 0) {
    badEntry(
      { [kind]: body },
      `${kind} mixes \`${IDLE_CONDITION}\` with \`${selectorConditions.join("`, `")}\` — a step ` +
        `checks exactly one condition`
    );
  }
  return true;
}

const LAUNCH_PLATFORMS = ["ios", "android", "chromium", "vega"] as const;

export const SELECTABLE_PLATFORMS = [...LAUNCH_PLATFORMS, "ios-remote"] as const;
export type SelectablePlatform = (typeof SELECTABLE_PLATFORMS)[number];

const LAUNCH_MAP_KEYS = ["native", ...LAUNCH_PLATFORMS] as const;

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

function parseLaunch(raw: unknown): Launch {
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const b = raw as Record<string, unknown>;
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

export const STEP_DIRECTIVE_KEYS: readonly string[] = [
  "echo",
  "launch",
  "run",
  "when",
  "tool",
  "tap",
  "long-press",
  "swipe",
  "type",
  "await",
  "assert",
  "wait",
  "scroll-to",
  "pinch",
  "rotate",
  "snapshot",
  "script",
];

export const BLOCK_DIRECTIVE_KEYS = ["when"] as const satisfies readonly FlowStep["kind"][];

type BlockDirectiveKind = (typeof BLOCK_DIRECTIVE_KEYS)[number];

export type BlockStep = Extract<FlowStep, { kind: BlockDirectiveKind }>;

type ChildBearingKind<S extends FlowStep = FlowStep> = S extends unknown
  ? "steps" extends keyof S
    ? S["kind"]
    : never
  : never;

type UnregisteredBlockKind = Exclude<ChildBearingKind, BlockDirectiveKind>;

const _everyChildBearingKindIsRegistered: [UnregisteredBlockKind] extends [never]
  ? true
  : UnregisteredBlockKind = true;

function isBlockDirectiveKey(key: string): key is BlockDirectiveKind {
  return (BLOCK_DIRECTIVE_KEYS as readonly string[]).includes(key);
}

/**
 * Parse `times` on a tap body: an integer tap count dispatched as ONE multi-tap
 * gesture (2 = double-tap; N *independent* taps are N tap steps). `times: 1` is
 * the default and normalizes to absent, keeping parse/serialize exact inverses.
 * The cap matches the gesture-tap tool's clickCount bound.
 */
function parseTapTimes(raw: unknown, entry: unknown): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 10) {
    badEntry(entry, "tap.times must be an integer between 1 and 10 (2 = double-tap)");
  }
  return raw === 1 ? undefined : raw;
}

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
 * Parse a gesture target (a `tap`/`long-press` body, its `on:` value, or a
 * swipe's `from:`/`to:`): a selector (bare string = loose, map = strict) or a
 * raw normalized point `{ x, y }`. A map mixing selector fields with x/y is
 * ambiguous — and zod would silently STRIP the coordinates from a selector
 * map — so it is rejected loudly. Only the point-acting directives call this;
 * the observing directives take `parseSelector` directly.
 */
function parseTarget(raw: unknown, where: string): GestureTarget {
  if (raw !== null && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (obj.x !== undefined || obj.y !== undefined) {
      if (hasSelectorField(obj)) {
        badEntry(raw, `${where} takes a selector or x/y coordinates, not both`);
      }
      if (typeof obj.x !== "number" || typeof obj.y !== "number") {
        badEntry(raw, `${where}: a coordinate target needs numeric x and y`);
      }
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
      const duration = parsePositiveMs(
        obj.duration,
        entry,
        "long-press.duration",
        "duration: 1200"
      );
      if (duration > LONG_PRESS_MAX_DURATION_MS) {
        badEntry(
          entry,
          `long-press.duration is ${duration}ms - above the maximum long-press duration of ${LONG_PRESS_MAX_DURATION_MS}ms; the step holds a finger down for exactly that long, and on Chromium it dispatches a gesture-drag that refuses more`
        );
      }
      step.duration = duration;
    }
    return step;
  }

  return { kind: "long-press", ...parseTarget(body, "long-press") };
}

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

function parseWhenCondition(raw: unknown): WhenCondition {
  const conditionKeys = `${WAIT_CONDITIONS.join(", ")}, platform`;
  if (raw === null || typeof raw !== "object") {
    badEntry({ when: raw }, `when needs exactly one condition key (${conditionKeys})`);
  }
  const b = raw as Record<string, unknown>;
  if (IDLE_CONDITION in b) {
    badEntry(
      { when: raw },
      "when has no idle form — stillness is a wait, and a guard asks what is on the screen now. " +
        "Put `await: { idle: true }` before the block instead"
    );
  }
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
  const { timeout: _timeout, ...cond } = parseWaitFields(raw, "when");
  // `{{secret:NAME}}` resolves only inside the text-entry tools (a `type:`
  // step), never in condition evaluation, so a guard carrying one tests for
  // literal placeholder text that is never on screen: exists/visible/text
  // guards are permanently false and a `hidden` guard vacuously true. In an
  // assert that mistake fails loudly on the first run; here the guard silently
  // degenerates into a constant, so it fails at parse instead.
  const { selector, expectedText } = cond;
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
 * Nesting cap for block directives — the parse-side analog of flow-run's
 * MAX_RUN_DEPTH. A block directive is the only kind of step whose parse recurses
 * into child steps, and the yaml library happily materializes a cyclic alias
 * (`steps: &s … steps: *s`) as a cyclic object; without a cap that cycle escapes
 * parseFlow as a raw RangeError instead of a structured parse error.
 *
 * ONE counter shared by every block directive: a per-directive counter would let
 * an alternating chain evade all of them.
 */
const MAX_BLOCK_DEPTH = 20;

function assertBlockDepth(raw: unknown, depth: number): void {
  if (depth >= MAX_BLOCK_DEPTH) {
    const directives = BLOCK_DIRECTIVE_KEYS.map((key) => `\`${key}:\``).join("/");
    badEntry(
      raw,
      `${directives} blocks nest deeper than ${MAX_BLOCK_DEPTH} levels — check for a cyclic YAML alias (\`steps: &s … steps: *s\`)`
    );
  }
}

function parseBlockSteps(
  raw: Record<string, unknown>,
  depth: number,
  emptyDetail: string
): FlowStep[] {
  assertBlockDepth(raw, depth);
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) badEntry(raw, emptyDetail);
  return (raw.steps as unknown[]).map((s) => {
    if (s !== null && typeof s === "object") return fromYamlStep(s as YamlStep, depth + 1);
    return badEntry(s, "step must be an object");
  });
}

function parseWhenStep(raw: Record<string, unknown>, depth: number): FlowStep {
  assertBlockDepth(raw, depth);
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
  const steps = parseBlockSteps(raw, depth, "when needs a non-empty steps list to guard");
  return { kind: "when", condition, steps };
}

export function runTargetName(target: string): string {
  return path.posix.basename(target, ".yaml");
}

/**
 * Shape-check a `run:` value: a relative, forward-slashed path whose final
 * segment is a flow name, with the `.yaml` extension optional (see
 * {@link completeRunExtension}). `..` is deliberately legal — shared fragments
 * may live outside the flows dir, and a fragment reaching sideways to
 * `../shared/login.yaml` is a documented layout. Only the SHAPE is checked here;
 * nothing about WHERE the path lands. At run time execRunStep joins it onto the
 * containing flow file's own directory and resolves the result with kernel
 * semantics (see canonicalFlowPath in flow-file-refs.ts) — deliberately not a
 * lexical collapse, since a `..` after a symlinked component names the parent of
 * the link's target, not of the spelling. There is no path fence there: a target
 * runs if the tool server can read it, and fails with that file's own ENOENT if
 * it cannot.
 */
function parseRunTarget(raw: unknown, value: unknown): string {
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
 * `login.yaml` beside the containing flow file, exactly as the spelled-out form
 * does. This is the compatibility path for flows written when a `run:` target
 * was a saved-flow NAME looked up in `.argent/flows` — a bare name resolves to
 * the same file it always did, since those flows sit in that one directory.
 *
 * Completed HERE rather than at resolution time so exactly one spelling reaches
 * everything downstream: canonicalFlowPath's read, the fragment's on-disk casing
 * check, the report's `target`, and runDisplayName — which slices a fixed
 * `".yaml".length` off the target and would truncate a real path segment given a
 * bare one (see flow-run.ts). Re-serializing a parsed flow therefore writes the
 * completed spelling back, which is the intended one-way migration.
 *
 * The test is the CANDIDATE's basename, not the supplied value's: basename()
 * strips a trailing slash, so testing `${basename(value)}.yaml` would complete
 * `shared/` to the unopenable `shared/.yaml`. Anything else the candidate cannot
 * name — a wrong extension (`login.yml`), a mis-cased one (`Login.YAML`), an
 * empty target — leaves the value untouched for the caller's extension
 * diagnostics, which name the real problem better than a silent completion to
 * `login.yml.yaml` could.
 */
function completeRunExtension(value: string): string {
  if (value.endsWith(".yaml")) return value;
  const candidate = `${value}.yaml`;
  return FLOW_FILE_NAME_PATTERN.test(path.posix.basename(candidate)) ? candidate : value;
}

function parseScriptStep(raw: unknown, body: unknown): FlowStep {
  if (typeof body === "string") {
    badEntry(
      raw,
      "a `script` step takes a map, not a bare path — write `script: { path: scripts/seed.sh }`"
    );
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    badEntry(
      raw,
      "script needs { path, timeout?, env? }, e.g. `script: { path: scripts/seed.mjs }`"
    );
  }
  const b = body as Record<string, unknown>;
  rejectUnknownKeys(raw, b, ["path", "timeout", "env"], "script");
  const step: Extract<FlowStep, { kind: "script" }> = {
    kind: "script",
    path: parseScriptPath(raw, b.path),
  };
  if (b.timeout !== undefined) step.timeout = parseScriptTimeout(raw, b.timeout);
  if (b.env !== undefined) step.env = parseScriptEnv(raw, b.env);
  return step;
}

/**
 * A `script` step's own `env` map. Refused here — deviceless, naming the key —
 * rather than after the run has started, for the reason
 * {@link parseScriptTimeout} is.
 */
export function parseScriptEnv(raw: unknown, value: unknown): ScriptEnv {
  const problem = describeScriptEnvProblem(value);
  if (problem) badEntry(raw, `script \`env\` ${problem}`);
  return { ...(value as ScriptEnv) };
}

export function parseScriptPath(raw: unknown, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    badEntry(
      raw,
      "a `script` step needs a `path` — a .mjs or .sh file path relative to this flow's file, e.g. `script: { path: scripts/seed.mjs }`"
    );
  }
  if (value.includes("\\")) {
    badEntry(raw, "a `script` path uses forward slashes, e.g. `path: scripts/seed.mjs`");
  }
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    badEntry(raw, "a `script` path must be relative to the flow file that references it");
  }
  if (!SCRIPT_EXTENSIONS.some((extension) => value.endsWith(extension))) {
    const miscased = SCRIPT_EXTENSIONS.find((extension) => value.toLowerCase().endsWith(extension));
    if (miscased) {
      badEntry(raw, `a \`script\` path must use the lowercase ${miscased} extension`);
    }
    badEntry(
      raw,
      "a `script` path must end in .mjs or .sh — the extension is what picks the interpreter, and .mjs also pins the module type whatever the project's package.json says"
    );
  }
  if (!SCRIPT_FILE_NAME_PATTERN.test(path.posix.basename(value))) {
    badEntry(
      raw,
      `a \`script\` path's filename must match ${SCRIPT_FILE_NAME_PATTERN} — letters, digits, underscore, hyphen before the extension`
    );
  }
  return value;
}

export function scriptInterpreter(scriptPath: string): "node" | "bash" {
  return scriptPath.endsWith(".sh") ? "bash" : "node";
}

const SCRIPT_EXTENSIONS = [".mjs", ".sh"] as const;

export function hasScriptExtension(scriptPath: string): boolean {
  return SCRIPT_EXTENSIONS.some((extension) => scriptPath.endsWith(extension));
}

/**
 * The `timeout` a `script` step may carry, in milliseconds. The finiteness
 * check is not redundant: YAML `.inf` is typeof number and greater than 0. The
 * executor clamps whatever survives to the host's configured maximum and says
 * so in the step's report.
 *
 * The floor is {@link MIN_SCRIPT_TIMEOUT_MS} — the same constant the executor
 * floors the host's `scripts.maxTimeoutMs` to, read from one place rather than
 * spelled twice: a parse floor above the run-time one would refuse a limit the
 * host would have honoured, and one below it would accept a limit the host
 * silently raises. Its value is sized from the fixed cost of the step rather
 * than from the script — a fork, a Node boot, the runner preload and the
 * script's own import all run before the first line the limit is meant to
 * bound.
 *
 * A `.sh` adds the interpreter lookup, the exchange directory and bash's own
 * start in front of the script, and the floor was re-measured rather than
 * assumed when bash arrived: on the published bundle layout, 30 runs each, the
 * lookup is 5-9ms (almost all of it the one PATH probe), the exchange directory
 * is under a millisecond, and a whole `.sh` step costs 8-14ms more than the
 * `.mjs` step beside it at the median — the same order as the Node boot both
 * pay. The floor stands for both, and for both it is tight rather than
 * generous: a step that asks for 100ms is asking to be bounded by its own
 * start.
 *
 * No other millisecond option shares that floor. Each draws its bound from the
 * work it measures: `await`'s `timeout` takes 1
 * and `wait` takes 0, `idle`'s `timeout` carries a 600ms floor derived from the
 * settle reads it has to fit, and `idle.stableFor` a bounded integer range.
 * What this one measures starts a PROCESS first, so a limit under the floor
 * buys no short step — it buys one that ends at its time limit, or one whose
 * verdict tracks how busy the host was, and either way an errored script step
 * stops the flow. `timeout: 0.5` is the extreme of it:
 * Node holds no timer under 1ms, so the report quotes back a limit that never
 * ran. Refused here, deviceless and naming the key, rather than after the run
 * has started.
 */
export function parseScriptTimeout(raw: unknown, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    badEntry(raw, "script.timeout needs a positive number of milliseconds (e.g. `timeout: 30000`)");
  }
  if (value < MIN_SCRIPT_TIMEOUT_MS) {
    badEntry(
      raw,
      `script.timeout is in milliseconds and needs at least ${MIN_SCRIPT_TIMEOUT_MS} — the step ` +
        `spends its first tens of milliseconds starting the process the script runs in, so ` +
        `${value} leaves the script too little to run in and errors the step (30 seconds is ` +
        `\`timeout: 30000\`)`
    );
  }
  return value as number;
}

const OUTPUT_REFERENCE_MARKER = "{{output:";

interface StepField {
  where: string;
  altWhere?: string;
  value: string;
}

function* selectorFields(sel: FlowSelector, where: string, patterns = false): Generator<StepField> {
  if (sel.text !== undefined) yield { where: `${where}.text`, value: sel.text };
  if (patterns && sel.textMatches !== undefined) {
    yield { where: `${where}.text.matches`, value: sel.textMatches };
  }
  if (sel.identifier !== undefined) yield { where: `${where}.id`, value: sel.identifier };
  if (sel.role !== undefined) yield { where: `${where}.role`, value: sel.role };
  for (const relation of SELECTOR_RELATIONS) {
    const nested = sel[relation];
    if (nested !== undefined) yield* selectorFields(nested, `${where}.${relation}`, patterns);
  }
}

function* argFields(
  value: unknown,
  where: string,
  seen: Set<object> = new Set()
): Generator<StepField> {
  if (typeof value === "string") {
    yield { where, value };
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) yield* argFields(item, `${where}[${i}]`, seen);
  } else if (value instanceof Map) {
    // `%YAML 1.1` + `!!omap` materializes a real Map, whose entries
    // Object.entries reports as none.
    for (const [key, item] of value) yield* argFields(item, `${where}.${String(key)}`, seen);
  } else if (value instanceof Set) {
    // `!!set` members ARE the values, so they carry no key of their own and the
    // path stays the container's.
    for (const item of value) yield* argFields(item, where, seen);
  } else {
    for (const [key, item] of Object.entries(value))
      yield* argFields(item, `${where}.${key}`, seen);
  }
  seen.delete(value);
}

function gestureTargetPath(
  step: Extract<FlowStep, { kind: "tap" | "long-press" | "pinch" | "rotate" }>
): { path: string; alt?: string } {
  if (step.kind === "pinch" || step.kind === "rotate") return { path: `${step.kind}.on` };
  const option = step.kind === "tap" ? step.times : step.duration;
  if (option !== undefined) return { path: `${step.kind}.on` };
  return { path: step.kind, alt: `${step.kind}.on` };
}

function* conditionFields(
  kind: string,
  cond: {
    condition: WaitCondition;
    selector: FlowSelector;
    expectedText?: string;
    textMatch?: TextMatchMode;
  },
  patterns = false
): Generator<StepField> {
  yield* selectorFields(
    cond.selector,
    cond.condition === "text" ? `${kind}.text.in` : `${kind}.${cond.condition}`,
    patterns
  );
  if (cond.expectedText !== undefined && (patterns || cond.textMatch !== "matches")) {
    yield {
      where: cond.textMatch ? `${kind}.text.${cond.textMatch}` : `${kind}.text`,
      value: cond.expectedText,
    };
  }
}

function* outputReferenceFields(step: FlowStep): Generator<StepField> {
  switch (step.kind) {
    case "echo":
      yield { where: "echo", value: step.message };
      return;
    case "tool":
      yield* argFields(step.args, "args");
      return;
    case "type":
      yield* selectorFields(step.into, "type.into");
      yield { where: "type.text", value: step.text };
      return;
    case "await":
    case "assert":
      yield* conditionFields(step.kind, step);
      return;
    case "when":
      // Patterns included HERE and nowhere else. `{{output:…}}` is on no
      // resolver list, so a regex carrying one matches nothing — which a `tap`,
      // an `await` or an `assert` reports on its first run. A `when` does not:
      // an unmatchable guard is simply not met, the block is skipped, and the
      // run is green. Same reasoning, and same field set, as the `{{secret:`
      // scan in parseWhenCondition.
      if (step.condition.kind === "ui") yield* conditionFields("when", step.condition, true);
      return;
    case "tap":
    case "long-press":
    case "pinch":
    case "rotate": {
      if (!step.selector) return;
      const { path, alt } = gestureTargetPath(step);
      for (const field of selectorFields(step.selector, path)) {
        yield alt ? { ...field, altWhere: `${alt}${field.where.slice(path.length)}` } : field;
      }
      return;
    }
    case "swipe":
      if (step.from && "selector" in step.from) {
        yield* selectorFields(step.from.selector, "swipe.from");
      }
      if (step.to && "selector" in step.to) {
        yield* selectorFields(step.to.selector, "swipe.to");
      }
      return;
    case "scroll-to":
      yield* selectorFields(step.target, "scroll-to.target");
      if (step.within) yield* selectorFields(step.within, "scroll-to.within");
      return;
    case "snapshot":
      if (step.cropOn) yield* selectorFields(step.cropOn, "snapshot.cropOn");
      return;
    case "script":
      // An `env` value is where a `{{output:` reference will belong in a later
      // release, so it is refused here for the reason every other field is: the
      // spelling reaches the script as literal text today, and a flow written
      // against that release must not pass quietly on this one.
      for (const [name, value] of Object.entries(step.env ?? {})) {
        yield { where: `script.env.${name}`, value };
      }
      return;
    case "launch":
    case "run":
    case "idle":
    case "wait":
      return;
    default: {
      const unclassified: never = step;
      void unclassified;
      return;
    }
  }
}

export function holdsOutputReference(step: FlowStep): boolean {
  for (const field of outputReferenceFields(step)) {
    if (field.value.includes(OUTPUT_REFERENCE_MARKER)) return true;
  }
  return blockSteps(step)?.some(holdsOutputReference) ?? false;
}

/**
 * A refused value as its message quotes it, cut to the shared entry ceiling.
 *
 * Counted, the way {@link badEntry} counts its own cut. The refusals this
 * serves name a MARKER inside the value — `{{output:` — and a value long
 * enough to be cut is a value whose marker may be on the far side of the cut,
 * so a bare `…` left the author reading two hundred characters that do not
 * contain the thing the message is about, with nothing to say the rest exists.
 */
export function renderedValue(value: string): string {
  if (value.length <= MAX_ENTRY_RENDER_CHARS) return value;
  const elided = value.length - MAX_ENTRY_RENDER_CHARS;
  return `${value.slice(0, MAX_ENTRY_RENDER_CHARS)}…(+${elided} chars)`;
}

function assertNoOutputReferences(steps: FlowStep[], trail: number[] = []): void {
  steps.forEach((step, i) => {
    const at = [...trail, i + 1];
    for (const field of outputReferenceFields(step)) {
      if (!field.value.includes(OUTPUT_REFERENCE_MARKER)) continue;
      const rendered = renderedValue(field.value);
      const locator = field.altWhere
        ? `\`${field.where}\` (spelled \`${field.altWhere}\` if the target sits under \`on:\`)`
        : `\`${field.where}\``;
      throw new FailureError(
        `Step ${at.join(".")} (\`${step.kind}\`): ${locator} uses unsupported template syntax. ` +
          `Replace it with the literal value the step needs: ${JSON.stringify(rendered)}`,
        {
          error_code: FAILURE_CODES.FLOW_ENTRY_UNRECOGNIZED,
          failure_stage: "flow_output_reference",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }
    const inner = blockSteps(step);
    if (inner) assertNoOutputReferences(inner, at);
  });
}

const SWIPE_DIRECTIONS: readonly SwipeDirection[] = ["up", "down", "left", "right"];

const SWIPE_OPTION_KEYS = ["from", "direction", "to", "by", "momentum", "duration"] as const;

function parseSwipeBy(raw: unknown, entry: unknown): { x?: number; y?: number } {
  if (raw === null || typeof raw !== "object") {
    badEntry(entry, "swipe.by needs { x } and/or { y } — signed 0–1 fractions of the screen");
  }
  const obj = raw as Record<string, unknown>;
  rejectUnknownKeys(entry, obj, ["x", "y"], "swipe.by");
  if (obj.x === undefined && obj.y === undefined) {
    badEntry(entry, "swipe.by needs at least one of x, y");
  }
  const by: { x?: number; y?: number } = {};
  for (const axis of ["x", "y"] as const) {
    const v = obj[axis];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v === 0 || v < -1 || v > 1) {
      badEntry(
        entry,
        `swipe.by.${axis} must be a non-zero fraction of the screen between -1 and 1 (omit the axis instead of 0)`
      );
    }
    by[axis] = v;
  }
  // `by`'s delta is static, so this device-less magnitude is the whole check -
  // the runtime `by` branch adds no second guard, which would spuriously reject a
  // delta landing one ulp under the floor after an in-bounds passthrough.
  const magnitude = Math.hypot(by.x ?? 0, by.y ?? 0);
  if (magnitude < SWIPE_MIN_TRAVEL) {
    badEntry(
      entry,
      `swipe.by travels only ${magnitude} — below the minimum swipe travel of ${SWIPE_MIN_TRAVEL}; a travel that small is a tap, not a swipe`
    );
  }
  return by;
}

function parseSwipe(body: unknown, entry: unknown): FlowStep {
  if (typeof body === "string") {
    if (!(SWIPE_DIRECTIONS as readonly string[]).includes(body)) {
      badEntry(
        entry,
        `swipe takes a direction (${SWIPE_DIRECTIONS.join(", ")}) — to anchor on an element use swipe: { from: <target>, direction: … }`
      );
    }
    return { kind: "swipe", direction: body as SwipeDirection };
  }
  if (body === null || typeof body !== "object") {
    badEntry(entry, `swipe needs a direction (${SWIPE_DIRECTIONS.join(", ")}) or an options map`);
  }
  const obj = body as Record<string, unknown>;

  if (hasSelectorField(obj)) {
    badEntry(
      entry,
      'the swipe options form takes a nested target — e.g. swipe: { from: { text: "Card" }, direction: left }'
    );
  }
  if (obj.x !== undefined || obj.y !== undefined) {
    badEntry(
      entry,
      "the swipe options form takes a nested point — e.g. swipe: { from: { x: 0.5, y: 0.5 }, direction: left }"
    );
  }
  // `settle` was this flag's old spelling, with the opposite polarity. Rejected
  // by name rather than by rejectUnknownKeys' generic message, and never aliased:
  // `settle: true` maps to `momentum: false`, so a silent rewrite would invert
  // what the author wrote.
  if (obj.settle !== undefined) {
    badEntry(
      entry,
      "swipe.settle was renamed to swipe.momentum, with the opposite sense — write `momentum: false` for the momentum-free swipe that `settle: true` used to mean (plain `settle: false` was the default, so just drop it)"
    );
  }
  rejectUnknownKeys(entry, obj, SWIPE_OPTION_KEYS, "swipe");

  const travels = (["direction", "to", "by"] as const).filter((k) => obj[k] !== undefined);
  if (travels.length !== 1) {
    badEntry(entry, "swipe needs exactly one of `direction`, `to`, or `by`");
  }

  const step: FlowStep = { kind: "swipe" };
  if (obj.from !== undefined) step.from = parseTarget(obj.from, "swipe.from");
  switch (travels[0]!) {
    case "direction": {
      if (
        typeof obj.direction !== "string" ||
        !(SWIPE_DIRECTIONS as readonly string[]).includes(obj.direction)
      ) {
        badEntry(entry, `swipe.direction must be one of ${SWIPE_DIRECTIONS.join(", ")}`);
      }
      step.direction = obj.direction as SwipeDirection;
      break;
    }
    case "to":
      step.to = parseTarget(obj.to, "swipe.to");
      break;
    case "by":
      step.by = parseSwipeBy(obj.by, entry);
      break;
  }
  if (obj.momentum !== undefined) {
    if (typeof obj.momentum !== "boolean") {
      badEntry(entry, "swipe.momentum must be true or false");
    }
    if (!obj.momentum) step.momentum = false;
  }
  if (obj.duration !== undefined) {
    const duration = parsePositiveMs(obj.duration, entry, "swipe.duration", "duration: 800");
    if (duration < SWIPE_MIN_DURATION_MS) {
      badEntry(
        entry,
        `swipe.duration is only ${duration}ms — below the minimum swipe duration of ${SWIPE_MIN_DURATION_MS}ms; that leaves too few 16ms frames for the content to track the travel it was given, so it overshoots instead of landing on it`
      );
    }
    if (duration > SWIPE_MAX_DURATION_MS) {
      badEntry(
        entry,
        `swipe.duration is ${duration}ms - above the maximum swipe duration of ${SWIPE_MAX_DURATION_MS}ms; the step holds a finger on the screen for exactly that long, one dispatched frame per 16ms, and nothing outside the run can cut it short`
      );
    }
    step.duration = duration;
  }
  return step;
}

function fromYamlStep(raw: YamlStep, blockDepth = 0): FlowStep {
  const entry = raw as Record<string, unknown>;
  if ("optional" in raw) {
    badEntry(
      raw,
      "optional is not supported — guard the step with a when: block instead (`when: { visible: <target> }` + `steps:`)"
    );
  }
  const kinds = STEP_DIRECTIVE_KEYS.filter((k) => k in entry);
  if (kinds.length === 0) {
    if (IDLE_CONDITION in entry) {
      badEntry(raw, `idle is a condition, not a step kind — write it as \`await: { idle: true }\``);
    }
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
  const kind = kinds[0]!;
  if (!isBlockDirectiveKey(kind)) {
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
  if ("when" in raw) return parseWhenStep(entry, blockDepth);

  if ("tap" in raw) return parseTap((raw as { tap: unknown }).tap, raw);

  if ("long-press" in raw) {
    return parseLongPress((raw as { "long-press": unknown })["long-press"], raw);
  }
  if ("swipe" in raw) return parseSwipe((raw as { swipe: unknown }).swipe, raw);

  if ("type" in raw) {
    const body = (raw as { type: { into?: unknown; text?: unknown; submit?: unknown } }).type;
    if (!body || typeof body !== "object") badEntry(raw, "type needs { into, text }");
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
    const body = (raw as { await: unknown }).await;
    if (isIdleCondition(body, "await")) {
      return parseIdleFields(body as Record<string, unknown>, "await");
    }
    return { kind: "await", ...parseWaitFields(body, "await") };
  }

  if ("assert" in raw) {
    const body = (raw as { assert: unknown }).assert;
    if (isIdleCondition(body, "assert")) {
      return parseIdleFields(body as Record<string, unknown>, "assert");
    }
    return { kind: "assert", ...parseWaitFields(body, "assert") };
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
    if (body !== null && typeof body === "object" && !Array.isArray(body)) {
      rejectUnknownKeys(
        raw,
        body as Record<string, unknown>,
        ["name", "maxMismatch", "cropOn"],
        "snapshot"
      );
    }
    const b =
      typeof body === "string"
        ? { name: body }
        : (body as { name?: unknown; maxMismatch?: number; cropOn?: unknown });
    if (!b || typeof b !== "object" || typeof b.name !== "string" || !b.name) {
      badEntry(raw, "snapshot needs a name (bare string or { name })");
    }
    if (!FLOW_NAME_PATTERN.test(b.name)) {
      badEntry(
        raw,
        `snapshot name "${b.name}" must match ${FLOW_NAME_PATTERN} (letters, digits, underscore, hyphen)`
      );
    }
    const step: FlowStep = { kind: "snapshot", name: b.name };
    if (b.maxMismatch !== undefined) {
      const m = Number(b.maxMismatch);
      if (!Number.isFinite(m) || m < 0 || m > 100) {
        badEntry(
          raw,
          "snapshot maxMismatch must be a number between 0 and 100 (percent of pixels)"
        );
      }
      step.maxMismatch = m;
    }
    if (b.cropOn !== undefined) {
      step.cropOn = parseSelector(b.cropOn, "snapshot.cropOn");
    }
    return step;
  }

  if ("script" in raw) return parseScriptStep(raw, (raw as { script: unknown }).script);

  if ("tool" in raw) {
    const r = raw as { tool: string; args?: Record<string, unknown>; delayMs?: number };
    const step: FlowStep = { kind: "tool", name: r.tool, args: r.args ?? {} };
    if (r.delayMs !== undefined) step.delayMs = r.delayMs;
    return step;
  }

  return badEntry(raw, "unrecognized step kind");
}

export function serializeFlow(flow: FlowFile): string {
  // `env` first, because it is a header the whole file reads under. Emitted
  // whenever the flow carries one, empty included: `parseFlow` sets `env` from
  // the KEY's presence, not from its size, so dropping an empty map is what
  // breaks parseFlow(serializeFlow(x)) — and deletes an `env: {}` an author
  // wrote as soon as the next step is appended.
  const doc: YamlFlowFile = {
    ...(flow.env ? { env: { ...flow.env } } : {}),
    steps: flow.steps.map(toYamlStep),
  };
  if (flow.executionPrerequisite) doc.executionPrerequisite = flow.executionPrerequisite;
  // blockQuote: false — a block scalar is not round-trip-safe for our free-text
  // fields: whitespace-only lines inside a multi-line value are silently
  // stripped on re-parse (" \n" comes back as "\n"), and a block scalar's own
  // chomping decides what its last line keeps, so a value at the document tail
  // comes back changed. Either way parseFlow(serializeFlow(x)) is not the
  // identity. Disabling it emits multi-line values as double-quoted scalars
  // (escape-exact both ways); single-line values still serialize plain, and
  // legacy files containing block scalars still parse.
  //
  // doubleQuotedMinMultiLineLength: Infinity — "escape-exact both ways" holds
  // only while the double-quoted scalar stays on ONE line. Past the emitter's
  // default of 40 characters it writes a MULTI-LINE double-quoted scalar, and a
  // whitespace-only line inside one is written as `\ ` and re-parses as a
  // backslash — so `parseFlow(serializeFlow(x))` is not the identity for
  // exactly the shape `env` exists to carry, a PEM key or a service-account
  // blob, where a changed value changes what a side-effecting script DOES
  // rather than what a log line reads. Forcing the single-line form escapes
  // every break as `\n` instead.
  //
  // lineWidth: 0 — and that is only half of it, because the emitter FOLDS a
  // long line whatever form it chose. A fold placed between an escaped space
  // and an escaped newline eats the space: a value ending `…aaa  a \n…` comes
  // back `…aaa  a\n…`, one character shorter than the author wrote and with
  // nothing to say so. Rare and silent, which is the combination this rule
  // exists for; `flow-script-env.test.ts` pins a minimized value that
  // reproduces it, and states the rate its own generator found. Zero disables
  // folding, so every scalar stays on one physical line and every break is an
  // escape. The cost is document-wide and cosmetic: a long `echo` message or
  // `executionPrerequisite` is written on one line rather than wrapped at 80
  // columns.
  return yamlStringify(doc, {
    blockQuote: false,
    doubleQuotedMinMultiLineLength: Infinity,
    lineWidth: 0,
  });
}

/**
 * Refuse a `{{output:` reference in an `env` map, wherever the map came from.
 *
 * The spelling belongs to a later release, and every other field that will take
 * one is refused today for the same reason: left alone it reaches the script as
 * literal text and the step PASSES, so a flow written against that release would
 * change behaviour under it without a word. `whose` names the map — "The flow's",
 * "This run's" — so the author knows which one to edit.
 */
export function assertNoEnvOutputReferences(env: ScriptEnv | undefined, whose: string): void {
  for (const [name, value] of Object.entries(env ?? {})) {
    if (!value.includes(OUTPUT_REFERENCE_MARKER)) continue;
    throw new FailureError(
      `${whose} \`env.${name}\` uses unsupported template syntax. ` +
        `Replace it with the literal value the script needs: ${JSON.stringify(renderedValue(value))}`,
      {
        error_code: FAILURE_CODES.FLOW_ENTRY_UNRECOGNIZED,
        failure_stage: "flow_output_reference",
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
  }
}

export function validateFlow(flow: FlowFile): void {
  assertNoEnvOutputReferences(flow.env, "The flow's");
  assertNoOutputReferences(flow.steps);
  if (isE2eFlow(flow) && flow.executionPrerequisite) {
    throw new FailureError(
      "A flow whose first step other than `echo:`/`script:` is a `launch` must not declare executionPrerequisite — it launches its own app and controls its start state. Drop that launch to make it a fragment, or drop executionPrerequisite.",
      {
        error_code: FAILURE_CODES.FLOW_E2E_HAS_PREREQUISITE,
        failure_stage: "flow_file_validate",
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
  }
}

/**
 * A flow file's document and its top-level shape, with the steps untouched.
 *
 * The half of {@link parseFlow} that answers questions about the FILE rather
 * than about its steps: the trims, the YAML parse, the top-level key rule and
 * the `env` rule. `parseFlow` goes on to the steps from the same result, which
 * is what keeps one reading of a file's head. `undefined` for a file holding
 * nothing.
 */
function readFlowHead(content: string): YamlFlowFile | undefined {
  // Trimmed at the START, and at the trailing edge only back to the last line
  // break. What is left of the trim is what nothing can be part of a value.
  //
  // The trailing edge is where the loss was: `String.prototype.trim` strips the
  // whole Unicode whitespace class and YAML's plain scalars strip only the ASCII
  // one, so a value ending in U+00A0 — the shape a token pasted out of a web UI
  // has — lost that character whenever it was the last scalar in the file, which
  // is where the serializer puts a recorded step's `env` value. That value sits
  // on the last CONTENT line, so stopping at the line break keeps it.
  //
  // What is past that break is a line holding nothing but whitespace, and YAML
  // accepts only space and tab there — so a lone U+00A0, a stray carriage return
  // from a half-applied line-ending conversion, a vertical tab or a BOM read as
  // a second top-level node at column 1 and the file stopped parsing AT ALL:
  // not the `env:` block, the whole thing, for every caller of this function.
  // The paste artefact the line above exists for is the same artefact that
  // lands there.
  //
  // Nothing at the leading edge can be part of a value either, because the top
  // level of a flow file is a map, so that trim costs nothing and keeps what it
  // always covered: a file whose first line opens with a TAB, which YAML refuses
  // as indentation and this accepted before.
  //
  // A trailing CR is taken off FIRST, because it is the half of a CRLF whose LF
  // a line-ending conversion dropped — the document's own last break, not a
  // character of the last value. Without that the trailing rule never fires (it
  // is anchored on a break, and this file has none), and a CRLF-authored flow
  // that lost its final LF read one character longer than the author wrote: a
  // block-style `echo` came back `"hello\r"` and a `TOK:` value `"abc\r"`,
  // while the flow-style spelling of the same file stopped parsing at all —
  // "Unexpected scalar at node end".
  //
  // No file argent WRITES can end in a raw CR, which is what makes this safe:
  // `serializeFlow` escapes a CR inside a value as the two characters `\r` and
  // ends the document with a newline. The parser itself is no help here — it
  // keeps a raw CR as ordinary content, so it cannot tell the two apart — which
  // leaves one shape this costs: a HAND-authored plain scalar that is the
  // file's last value and really does end in a literal CR. That character is a
  // line ending far more often than it is a value, and the shape it comes from
  // is a half-applied conversion.
  //
  // `+`, because the same conversion applied twice ends a file in two.
  const body = content
    .replace(/^\s+/, "")
    .replace(/\r+$/, "")
    .replace(/\n\s+$/, "\n");
  if (body.length === 0) return undefined;

  let parsed: YamlFlowFile;
  try {
    parsed = yamlParse(body, { stringKeys: true }) as YamlFlowFile;
  } catch (err) {
    throw new FailureError(
      `Invalid flow file: ${err instanceof Error ? err.message : String(err)}`,
      {
        error_code: FAILURE_CODES.FLOW_FILE_INVALID,
        failure_stage: "flow_file_parse",
        failure_area: "tool_server",
        error_kind: "validation",
      },
      err instanceof Error ? { cause: err } : undefined
    );
  }

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

  const topKeys: readonly string[] = ["executionPrerequisite", "steps", "env"];
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

  // Before the steps: a file whose `env` is malformed is malformed as a whole,
  // and the author reads the first refusal, not the deepest one.
  if (parsed.env !== undefined) {
    const problem = describeScriptEnvProblem(parsed.env);
    if (problem) {
      throw new FailureError(`Invalid flow file: \`env\` ${problem}`, {
        error_code: FAILURE_CODES.FLOW_FILE_INVALID,
        failure_stage: "flow_file_parse",
        failure_area: "tool_server",
        error_kind: "validation",
      });
    }
  }

  return parsed;
}

export function parseFlow(content: string): FlowFile {
  const parsed = readFlowHead(content);
  if (parsed === undefined) {
    return { executionPrerequisite: "", steps: [] };
  }

  const steps = parsed.steps.map((raw) => {
    if (raw !== null && typeof raw === "object") return fromYamlStep(raw as YamlStep);
    return badEntry(raw, "step must be an object");
  });

  const flow: FlowFile = {
    executionPrerequisite: parsed.executionPrerequisite ?? "",
    ...(parsed.env !== undefined ? { env: { ...(parsed.env as ScriptEnv) } } : {}),
    steps,
  };
  validateFlow(flow);
  return flow;
}

let flowWriteSeq = 0;

function writeFailureHint(
  code: string | undefined,
  filePath: string,
  target: string,
  resolvedDir: string
): string {
  // The directory the swap actually uses — `dirname(realpath(filePath))`, not
  // `dirname(filePath)`. For a flow file that is a symlink into a shared vault
  // those differ, and only the first can be the cause: naming the second sent
  // the reader to a `.argent/flows` that is already writable while the vault,
  // the only unwritable thing in the picture, went unmentioned.
  //
  // Compared against the RESOLVED flows dir, not the spelled one: every
  // symlinked ANCESTOR moves the target too — which on macOS is every `/tmp`
  // and `/var/folders` path — so comparing against the spelling accused an
  // ordinary regular file of being a symlink.
  const dir = path.dirname(target);
  const via =
    dir === resolvedDir
      ? ""
      : ` (${path.basename(filePath)} is a symlink, so the write lands in ${dir}, not in ${resolvedDir})`;
  switch (code) {
    case "EACCES":
    case "EPERM":
    case "EROFS":
      return (
        `an append replaces the file via a sibling temp file and rename, so ${dir} must be ` +
        `writable — permission on the flow file itself is not enough${via}.`
      );
    case "ENOSPC":
    case "EDQUOT":
      return `the filesystem holding ${dir} is out of space (or over quota)${via}.`;
    case "ENAMETOOLONG":
      return `the flow name makes ${path.basename(target)} longer than this filesystem allows — use a shorter name.`;
    case "ENOENT":
      return `${dir} does not exist${via}.`;
    default:
      return `an append replaces the file via a sibling temp file and rename in ${dir}${via}.`;
  }
}

function scrubTempPath(err: unknown, tmpPath: string, filePath: string): Error {
  if (!(err instanceof Error)) return new Error(String(err));
  if (!err.message.includes(tmpPath)) return err;
  const scrubbed = new Error(err.message.split(tmpPath).join(filePath));
  scrubbed.name = err.name;
  return scrubbed;
}

/**
 * A flow file's REAL path. A saved flow may be a symlink into a shared vault,
 * and rename(2) replaces the path it is handed, so renaming onto the link's own
 * spelling would swap the symlink for a regular file and strand the vault copy
 * with the pre-recording content. A plain write follows the link; resolving
 * first keeps that behavior while keeping the swap atomic.
 *
 * The directory is resolved separately so that a flow file which does not exist
 * yet (the first write of a recording, which has no realpath of its own) still
 * lands on the same canonical spelling as every later append — otherwise the
 * first swap and the rest would disagree wherever an ancestor is itself a
 * symlink, which is the default for the temp dir on macOS.
 *
 * A DANGLING link is the case `realpath` cannot express — it fails on the whole
 * path rather than answering with the target — and that failure would put the
 * link's own spelling back in front of `rename`. {@link followDanglingLink}
 * resolves it by hand.
 *
 * Shared with {@link resolveFlowKey}, so the identity a recording is keyed by
 * and the file its steps land in can never disagree.
 *
 * `dir` — the flows directory as the filesystem sees it — is returned alongside,
 * because it is the only thing a caller can compare `target`'s directory against
 * to tell "the flow FILE is a symlink" from "some ancestor of it is". The
 * spelled `path.dirname(filePath)` cannot: on macOS every `/tmp` and
 * `/var/folders` path has a symlinked ancestor.
 */
async function canonicalFlowTarget(filePath: string): Promise<{ dir: string; target: string }> {
  const dir = await fs.realpath(path.dirname(filePath)).catch(() => path.dirname(filePath));
  const real = await fs.realpath(filePath).catch(() => null);
  if (real !== null) return { dir, target: real };
  return { dir, target: await followDanglingLink(path.join(dir, path.basename(filePath))) };
}

async function canonicalFlowPath(filePath: string): Promise<string> {
  return (await canonicalFlowTarget(filePath)).target;
}

const MAX_DANGLING_LINK_HOPS = 32;

async function followDanglingLink(linkPath: string): Promise<string> {
  let current = linkPath;
  for (let hop = 0; hop < MAX_DANGLING_LINK_HOPS; hop++) {
    const target = await fs.readlink(current).catch(() => null);
    if (target === null) return current;
    const resolved = path.resolve(path.dirname(current), target);
    const real = await fs.realpath(resolved).catch(() => null);
    if (real !== null) return real;
    const targetDir = await fs.realpath(path.dirname(resolved)).catch(() => path.dirname(resolved));
    current = path.join(targetDir, path.basename(resolved));
  }
  return current;
}

async function isWritable(filePath: string): Promise<boolean> {
  return fs.access(filePath, fsConstants.W_OK).then(
    () => true,
    () => false
  );
}

/**
 * Replace a flow file's contents so no reader can ever observe it half-written.
 *
 * {@link withFlowFileLock} serializes WRITERS, but every reader of a flow YAML
 * stays outside it — `flow-execute`'s own load, its `run:` fragment load,
 * `flow-read-prerequisite`, `flow-add-step`'s sibling-fragment check — and the
 * `argent` CLI reads these files from another process entirely, where an
 * in-process lock cannot reach. A plain `fs.writeFile` opens with O_TRUNC, so
 * such a reader could land between the truncate and the write and parse a
 * truncated or empty file — and `parseFlow("")` yields `{ steps: [] }` with no
 * error, which replays as a top-level PASS over zero steps.
 *
 * Writing to a temp file beside the target and renaming makes the swap atomic.
 * Beside the TARGET, note — `canonicalFlowPath`'s result, which for a symlinked
 * flow is the vault the link points into, not `path.dirname(filePath)`;
 * rename(2) is atomic only within one filesystem, and that pairing is what
 * guarantees it.
 *
 * The temp name is dotted and `.tmp`-suffixed so a half-written scratch file can
 * never be mistaken for a flow: `getFlowPath` only ever produces `<name>.yaml`,
 * and every site that enumerates a flows directory — `argent flow list`,
 * {@link classifyOnDiskSpelling}, the CLI's recursive suite walk — filters on
 * `.yaml` plus `FLOW_NAME_PATTERN`. Keep both halves of that agreement if either
 * side changes.
 *
 * It deliberately does NOT embed the flow name. A flow name has no length cap
 * (`FLOW_NAME_PATTERN` constrains the character set only), so `<name>.yaml` can
 * legitimately run to NAME_MAX — and prefixing that with a discriminator would
 * push the scratch name past the limit, turning an append that used to work into
 * ENAMETOOLONG. pid + counter is unique on its own (see {@link flowWriteSeq}).
 *
 * The swap costs one thing a write-through would have kept, accepted for the
 * atomicity: it needs write permission on the DIRECTORY rather than on the file,
 * and it replaces the inode, so a hardlink to the flow file does not survive an
 * append. The file's own MODE is not among the costs — see below.
 */
async function writeFlowFile(filePath: string, content: string): Promise<void> {
  const { dir: resolvedDir, target } = await canonicalFlowTarget(filePath);
  const previousMode = await fs.stat(target).then(
    (s) => s.mode & 0o7777,
    () => null
  );
  if (previousMode !== null && !(await isWritable(target))) {
    // The swap needs permission on the directory, not on the file, so it would
    // replace a `chmod 0444` flow file regardless — turning a plain write's
    // EACCES into a silent success that also relaxed the mode to the umask
    // default. Refuse instead.
    throw new FailureError(
      `Failed to write flow file ${filePath} (EACCES) — ${target} is not writable ` +
        `(mode ${previousMode.toString(8).padStart(4, "0")}). An append replaces the file via a ` +
        `sibling temp file and rename, which needs permission on the directory rather than on ` +
        `the file — so this is refused explicitly rather than quietly overwriting a flow you ` +
        `made read-only. chmod it writable to record over it.`,
      {
        error_code: FAILURE_CODES.FLOW_FILE_WRITE_FAILED,
        failure_stage: "flow_file_write",
        failure_area: "tool_server",
        error_kind: "unknown",
      }
    );
  }
  const tmpPath = path.join(
    path.dirname(target),
    `.argent-flow-${process.pid}-${++flowWriteSeq}.tmp`
  );
  try {
    await fs.writeFile(tmpPath, content, "utf8");
    // The scratch file was created under this process's umask, and rename
    // carries ITS mode over — so without this every append would quietly
    // rewrite the flow file's permissions to 0644.
    if (previousMode !== null) await fs.chmod(tmpPath, previousMode);
    await fs.rename(tmpPath, target);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    const errno = err instanceof Error ? (err as NodeJS.ErrnoException) : undefined;
    const code = typeof errno?.code === "string" ? errno.code : undefined;
    throw new FailureError(
      `Failed to write flow file ${filePath}${code ? ` (${code})` : ""} — ${writeFailureHint(code, filePath, target, resolvedDir)}`,
      {
        error_code: FAILURE_CODES.FLOW_FILE_WRITE_FAILED,
        failure_stage: "flow_file_write",
        failure_area: "tool_server",
        error_kind: "unknown",
      },
      { cause: scrubTempPath(err, tmpPath, filePath) }
    );
  }
}

function mkdirFailureHint(code: string | undefined, dir: string): string {
  switch (code) {
    case "ENOTDIR":
      return (
        `a component of ${dir} exists and is not a directory — check that project_root ` +
        `names a directory rather than a file.`
      );
    case "EACCES":
    case "EPERM":
    case "EROFS":
      return `the nearest existing parent of ${dir} is not writable.`;
    case "ENOSPC":
    case "EDQUOT":
      return `the filesystem holding ${dir} is out of space (or over quota).`;
    case "ENAMETOOLONG":
      return `${dir} is longer than this filesystem allows.`;
    default:
      return `${dir} could not be created.`;
  }
}

export async function writeNewFlowFile(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err) {
    const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
    throw new FailureError(
      `Failed to create the flows directory ${dir}${typeof code === "string" ? ` (${code})` : ""} — ` +
        mkdirFailureHint(typeof code === "string" ? code : undefined, dir),
      {
        error_code: FAILURE_CODES.FLOW_FILE_WRITE_FAILED,
        failure_stage: "flow_dir_create",
        failure_area: "tool_server",
        error_kind: "unknown",
      },
      { cause: err instanceof Error ? err : new Error(String(err)) }
    );
  }
  await writeFlowFile(filePath, content);
}

export async function countStepsOnDisk(filePath: string): Promise<number | undefined> {
  try {
    return parseFlow(await fs.readFile(filePath, "utf8")).steps.length;
  } catch {
    return undefined;
  }
}

/**
 * The recording's flow-level `env` as the FILE spells it right now.
 *
 * The disk copy, not `session.flow`: that one is only as fresh as the last
 * append, so a top-level `env:` the agent hand-added before the first recorded
 * step is invisible to it — and `flow-add-script` has to run the script under
 * the same map the replay will take, or the recording proves nothing. Throws
 * what `parseFlow` throws; the caller words the refusal.
 */
export async function flowEnvOnDisk(session: RecordingSession): Promise<ScriptEnv | undefined> {
  return parseFlow(await fs.readFile(session.filePath, "utf8")).env;
}

async function appendStep(filePath: string, step: FlowStep): Promise<string> {
  const content = await fs.readFile(filePath, "utf8");
  const flow = parseFlow(content);
  flow.steps.push(step);
  validateFlow(flow);
  const updated = serializeFlow(flow);
  await writeFlowFile(filePath, updated);
  return updated;
}

export function clientFileDirective(filePath: string, content: string): ClientFileDirective {
  return { [CLIENT_FILE_MARKER]: true, path: filePath, content };
}

export type FlowSavedTo = string | ClientFileDirective;

/**
 * A tool resolves its session up front, then runs the step LIVE — which can take
 * minutes — before appending. In that window the recording it holds may have
 * been finished, restarted or evicted, leaving it with a session object that is
 * no longer the one registered for its key. Writing anyway is the worst outcome:
 * the step lands in a file that now belongs to a *different* take and the caller
 * is told it succeeded. Re-check identity at write time, inside the flow-file
 * lock.
 *
 * The lock makes this exact against the other flow tools, which all mutate
 * `recordings` for a key while holding that key's lock. It is NOT exact against
 * {@link evictIfOverCapacity}, which runs under some OTHER key's lock and can
 * drop this session between the check and the write. That race is benign — the
 * step still lands in the file it was recorded for, and only the NEXT call on
 * the key reports the recording gone.
 */
/**
 * Whether this session still holds its key, and if not, how it lost it.
 *
 * `restarted` means a DIFFERENT session occupies the key; `gone` means the key
 * is empty, which is either a finish or the MAX_RECORDINGS backstop — the
 * server cannot tell those apart after the fact. {@link assertSessionStillLive}
 * asks this for a caller about to WRITE, and throws on anything but `live`. A
 * caller whose step already ran and has nothing to write still has a report to
 * make, and every claim in it about the flow file — that it is unchanged, and
 * how many steps it holds — is about a file another take may already own.
 * Outside the flow-file lock the answer can go stale the moment it returns, so
 * such a caller reads it to qualify a sentence, never to decide a write.
 */
export function recordingSessionState(session: RecordingSession): "live" | "restarted" | "gone" {
  const current = recordings.get(session.key);
  if (current === session) return "live";
  return current ? "restarted" : "gone";
}

function assertSessionStillLive(session: RecordingSession, step: FlowStep): void {
  const state = recordingSessionState(session);
  if (state === "live") return;
  const why =
    state === "restarted"
      ? "it was restarted while this step was running, so the step belongs to the discarded take"
      : "it was finished (or dropped by the concurrent-recording cap) while this step was running";
  const whatIsAtStake =
    state === "restarted"
      ? `This key now belongs to another take and flow-start-recording truncates, so re-record ` +
        `under a fresh name rather than restarting this one.`
      : `The key is now free, but the finished take is on disk and flow-start-recording truncates ` +
        `it unconditionally, so re-record under a fresh name rather than restarting this one.`;
  const alreadySpent =
    step.kind === "echo"
      ? ". "
      : step.kind === "script"
        ? ", but the script already ran — repeating it repeats whatever it did. "
        : ", but the step itself already ran on the device — repeating it repeats that action. ";
  const recovery = `Nothing was added to the flow file` + alreadySpent + whatIsAtStake;
  throw new FailureError(
    `Recording of "${session.name}" in ${session.projectRoot} is no longer active — ${why}. ` +
      recovery,
    {
      error_code: FAILURE_CODES.FLOW_NO_ACTIVE_RECORDING,
      failure_stage: "flow_session_superseded",
      failure_area: "tool_server",
      error_kind: "validation",
    }
  );
}

function renderStepForCompare(step: FlowStep): string | null {
  try {
    return JSON.stringify(step);
  } catch {
    return null;
  }
}

function sameStepRun(
  now: (string | null)[],
  before: (string | null)[],
  n: number,
  nowFrom: number,
  beforeFrom: number
): boolean {
  if (now.length < nowFrom + n || before.length < beforeFrom + n) return false;
  for (let i = 0; i < n; i += 1) {
    const rendered = now[nowFrom + i];
    if (rendered === null || rendered !== before[beforeFrom + i]) {
      return false;
    }
  }
  return true;
}

/**
 * Is the step at number `n` still the step the verdict at `n` judged?
 *
 * Matching the prefix at the unedited alignment is necessary but not enough. A
 * length change says a step was removed or added, and a prefix that ALSO
 * matches the alignment such an edit would leave behind is consistent with the
 * edit having happened inside it. Two adjacent identical waits hide the shift,
 * and a verdict is not a function of content: the probe read the live device at
 * that step's moment, so identical waits can diverge at one position and agree
 * at another.
 *
 * So a resized file keeps a verdict only where the alignments DISAGREE. The
 * edit can sit anywhere in the prefix, so every position is tried at every size
 * the length change admits. What stays out of reach is an edit that leaves the
 * length alone — a reorder of two identical steps has no witness at all.
 */
function anchorHolds(now: (string | null)[], before: (string | null)[], n: number): boolean {
  if (!sameStepRun(now, before, n, 0, 0)) return false;
  const deleted = before.length - now.length;
  const inserted = now.length - before.length;
  for (let at = 0; at < n; at += 1) {
    for (let size = 1; size <= deleted; size += 1) {
      if (sameStepRun(now, before, n - at, at, at + size)) return false;
    }
    for (let size = 1; size <= inserted; size += 1) {
      if (sameStepRun(now, before, n - at, at + size, at)) return false;
    }
  }
  return true;
}

function dropMovedWarnings(
  warnings: Map<number, RecordedStepWarning> | undefined,
  now: FlowStep[],
  before: FlowStep[]
): number {
  if (!warnings) return 0;
  const nowRendered = now.map(renderStepForCompare);
  const beforeRendered = before.map(renderStepForCompare);
  let dropped = 0;
  for (const n of [...warnings.keys()]) {
    if (anchorHolds(nowRendered, beforeRendered, n)) continue;
    warnings.delete(n);
    dropped += 1;
  }
  return dropped;
}

export async function appendStepToFlow(
  session: RecordingSession,
  step: FlowStep
): Promise<{ savedTo: FlowSavedTo; stepCount: number; flowEnv?: ScriptEnv }> {
  // The session's OWN key, not a fresh resolution of it: the lock this append
  // takes and the identity {@link assertSessionStillLive} checks must be the
  // same one, or a key that moved under the session (a symlink repointed
  // mid-recording) would let the append hold one lock while asserting about
  // another.
  return withFlowLock(session.key, async () => {
    assertSessionStillLive(session, step);
    session.lastTouchedSeq = touch();
    if (session.persist === "host") {
      const before = session.flow.steps;
      const flowFile = await appendStep(session.filePath, step);
      session.flow = parseFlow(flowFile);
      session.discardedWarnings =
        (session.discardedWarnings ?? 0) +
        dropMovedWarnings(session.stepWarnings, session.flow.steps.slice(0, -1), before);
      // Count inside the lock, off the just-refreshed `session.flow`: a caller
      // reading `session.flow.steps.length` after this returns would be racing a
      // concurrent same-key append, which can reassign `session.flow` between
      // the release here and that read.
      // Reported from inside the lock: a caller comparing it against what it
      // read BEFORE a run that may have taken minutes would otherwise be racing
      // a concurrent same-key append for `session.flow`.
      return {
        savedTo: session.filePath,
        stepCount: session.flow.steps.length,
        ...(session.flow.env ? { flowEnv: session.flow.env } : {}),
      };
    }
    session.flow.steps.push(step);
    try {
      validateFlow(session.flow);
      const flowFile = serializeFlow(session.flow);
      return {
        savedTo: clientFileDirective(session.filePath, flowFile),
        stepCount: session.flow.steps.length,
        ...(session.flow.env ? { flowEnv: session.flow.env } : {}),
      };
    } catch (err) {
      session.flow.steps.pop();
      throw err;
    }
  });
}
