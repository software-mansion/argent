import * as path from "node:path";
import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
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

// Re-exported so the flow layer (parser, serializer, report stringifiers, the
// runner's loose-alternative expansion) reads the relation list from the same
// place the match engine defines it.
export { SELECTOR_RELATIONS };
import { SECRET_PLACEHOLDER_MARKER } from "../../utils/secrets";
import { MAX_ROTATE_BY_DEG } from "./flow-rotate-geometry";

const FLOWS_DIR_NAME = path.join(".argent", "flows");

// ── Paths ────────────────────────────────────────────────────────────

/**
 * Validate a caller-supplied `project_root`. Every path helper below joins the
 * flows dir under this root, so the two rules it enforces (absolute, no "..")
 * are what keep a recording's files inside the project the agent named.
 */
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
}

/**
 * The flows dir under an explicit root, as pure path math. It validates
 * nothing, so a caller that already rejects a bad root with its own
 * tool-specific message (see flow-add-step) does not also raise a second,
 * differently-worded one from here.
 */
export function flowsDirFor(root: string): string {
  return path.join(root, FLOWS_DIR_NAME);
}

/** The flows dir under a root that has not been validated yet. */
export function getFlowsDir(projectRoot: string): string {
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

/**
 * The flow file `<project_root>/.argent/flows/<name>.yaml`, as the CALLER
 * spelled it. Pure path math over two validated inputs — this is the path
 * reported back to the agent, not the recording-session key (that is
 * {@link resolveFlowKey}, which asks the filesystem instead).
 *
 * `path.join` folds a trailing slash, `//` and `.` segments but NOT symlinks or
 * case, so two callers can spell one real file two ways here: the ROOT spelled
 * two ways (`/tmp/p` vs `/private/tmp/p` on macOS), the flows dir or the flow
 * file symlinked into a shared vault from two projects, or the NAME cased two
 * ways (`Login` vs `login`) on a case-insensitive volume, which APFS is by
 * default. Keying sessions on this string would mint two sessions — and two
 * independent locks — over one file, so nothing here is a session key.
 */
export function getFlowPath(projectRoot: string, name: string): string {
  const flowsDir = getFlowsDir(projectRoot);
  assertSafeFlowName(name);
  const filePath = path.join(flowsDir, `${name}.yaml`);
  // Defense-in-depth: ensure the resolved path stays inside the flows
  // directory even if the regex above is ever weakened.
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

/**
 * The flow file's identity as the FILESYSTEM sees it, which is what a recording
 * session and its lock are keyed by. Two callers who spell one real file two
 * ways — a symlink into a shared vault, a symlinked `.argent/flows`, a root
 * spelled `/tmp` vs `/private/tmp`, a name cased two ways on APFS — resolve to
 * one key here, so the collision reads as the restart it actually is instead of
 * minting a second session that silently truncates the first.
 *
 * This is the same resolution {@link writeFlowFile} performs before its swap,
 * deliberately: the key and the write agree by construction. Where the
 * filesystem declines to answer at all — a flows dir that does not exist yet —
 * both fall back to the same pure-path spelling and two spellings remain two,
 * which is correct, because two files is what the write then produces. Where it
 * declines only because the target is missing — a dangling vault symlink — both
 * follow the link by hand ({@link followDanglingLink}), so the two spellings
 * become one key, which is equally correct: one file is what the write produces
 * there.
 *
 * It costs one `realpath` pair per recording tool call, on a path already doing
 * file I/O.
 *
 * The earlier objection to normalizing — that the correct normalization is the
 * filesystem's and we cannot ask it — held only for a hand-rolled one. Asking
 * the filesystem is exactly what this does, so a case-SENSITIVE volume (ext4)
 * keeps `Login` and `login` apart on its own: `realpath` there simply fails to
 * find the variant spelling.
 *
 * "client" mode needs no special case. The caller's root does not exist on this
 * host, so both `realpath` calls fail and the fallback returns
 * {@link getFlowPath} unchanged — the old behavior, and the only one available
 * when the file is on another machine. Two clients that share a flow file
 * across that boundary are beyond this process's reach, as they were before.
 */
// `async`, so `getFlowPath`'s validation throws land as a rejection like every
// other failure here rather than synchronously out of a promise-returning call.
export async function resolveFlowKey(projectRoot: string, name: string): Promise<string> {
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
 * Canonical-key resolutions currently IN FLIGHT, keyed by the spelled path.
 * Not a cache — the entry is dropped the moment it settles, so a symlink
 * repointed between two tool calls is seen — but a sequencer.
 *
 * Resolution is `realpath`, which runs on libuv's threadpool and therefore
 * completes in an order unrelated to the order it was requested in. Every
 * recording tool resolves its key before joining its flow file's lock queue, so
 * without this, which of two tool calls acquires the lock first would be
 * decided by threadpool scheduling rather than by which was issued first — a
 * restart could land behind the append it is supposed to discard. Callers that
 * spell one path the same way share one promise, so their continuations run in
 * subscription order and the queue they join stays FIFO.
 *
 * Two DIFFERENT spellings of one file resolve independently and so race, as
 * they did before. Nothing depends on their order: mutual exclusion comes from
 * the resolved key, which is the same for both.
 */
const keyResolutions = new Map<string, Promise<string>>();

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
 * every route that turns a caller's spelling into a file it will open — the
 * four that resolve a flow IDENTITY (replay's `flow_path` and `name` in
 * flow-run.ts, the recorder's two nested flow-execute targets in
 * flow-add-step.ts) and, since the `script:` step, one that resolves a plain
 * `.mjs` — so they can never drift apart in which spellings they accept. That drift is the bug itself twice over: it let
 * a `name` key a report and `__baselines__/` under a spelling `flow_path`
 * refused two arms earlier, and it let the recorder bake a `run:` name whose
 * flow_path spelling its own neighbouring arm would have refused.
 *
 * readdir, not realpath: realpath rewrites a symlinked flow to its target's
 * name, and a flow deliberately runs — and composes — under the link's own
 * name. Every call site hands a pure-ASCII basename (the flow-name charset,
 * plus ".yaml" or ".mjs"), so Unicode-normalizing filesystems cannot make the
 * comparison lie.
 *
 * `addressable` is the pattern the verdict is judged against — the flow-file
 * one by default, {@link SCRIPT_FILE_NAME_PATTERN} for a `script:` path. It
 * decides only whether the caller can be pointed at the on-disk spelling or has
 * to ask for a rename; it never changes which verdict is returned.
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

// ── Recording sessions ───────────────────────────────────────────────

/**
 * Where a recording's YAML is persisted:
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
  /** Flow name, as passed to every recording tool. */
  name: string;
  /** Caller-supplied project root, as passed to every recording tool. */
  projectRoot: string;
  /**
   * The {@link resolveFlowKey} this session is registered under. Stored rather
   * than re-derived, so {@link assertSessionStillLive} asks about the key the
   * session actually holds — and needs no filesystem round trip to do it.
   */
  key: string;
  persist: FlowPersistMode;
  /**
   * Absolute path of the flow file as the CALLER knows it. A real host path in
   * "host" mode; in "client" mode it is only echoed back inside the directive
   * (it names a file on the client's machine, never touched here).
   */
  filePath: string;
  /** In-memory flow content — authoritative in "client" mode. */
  flow: FlowFile;
  /** Order of the last touch, for the LRU eviction backstop. See {@link touch}. */
  lastTouchedSeq: number;
}

/**
 * Live recordings, keyed by {@link resolveFlowKey} — the identity of the
 * artifact being built, as the FILESYSTEM resolves it rather than as a caller
 * spelled it. Two sessions on one key mean two writers on one output file (a
 * genuine collision, reported as a restart); two different keys are two
 * different files, so concurrent agents recording different flows — in one
 * project or across projects, against one device or several — never write into
 * each other's take.
 *
 * The one window the key does not close: two starts BOTH in flight before
 * either has created its file. Neither realpath can see a file that is not
 * there yet, so two spellings of one not-yet-existing file resolve apart, and
 * the two writes then land on one file. It closes itself on the next call —
 * the file exists by then, so both spellings resolve together and the loser
 * finds its key held by the other session, which fails loudly in
 * {@link requireRecordingSession} rather than silently mixing takes.
 *
 * Isolation of the recorded artifact, not of the fact that a recording exists:
 * the not-found path of {@link requireRecordingSession} deliberately names the
 * other live flows in the caller's own project (and counts the rest), so that
 * disclosure is bounded rather than absent. See the comment there for what it
 * discloses and why.
 *
 * One tool-server serves every MCP client, subagent and CLI call using one
 * argent install — `stateFileForBundle` gives each install its own record and
 * autospawn takes a free port, so the singleton is per install bundle, not per
 * machine. Within that scope this map is the only thing standing between two
 * agents and a clobbered flow file. Across it there is nothing: two installs
 * recording the same (project_root, name) hold two of these maps and cannot see
 * each other, so each believes its own session is live while the other
 * truncates and appends. What still holds there is {@link writeFlowFile}'s
 * temp-file swap, which is a filesystem guarantee rather than an in-process
 * one — each write stays whole, but a lost update is not prevented.
 */
const recordings = new Map<string, RecordingSession>();

/**
 * Serializes every mutation of ONE flow file: an append, the reset+register a
 * `flow-start-recording` performs, and the read+clear a `flow-finish-recording`
 * performs. Each of those is a read/await/write straddling at least one
 * microtask, and Express dispatches tool calls concurrently, so without this
 * two of them interleave and one silently loses.
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
  const previous = flowFileLocks.get(key) ?? Promise.resolve();
  // `previous` is always an already-swallowed promise, so a failed holder can
  // never wedge or reject the chain.
  const run = previous.then(() => fn());
  const held = run.catch(() => {});
  flowFileLocks.set(key, held);
  // Drop the entry once this holder is the last one, so the map does not grow
  // by one permanent entry per flow ever recorded.
  void held.then(() => {
    if (flowFileLocks.get(key) === held) flowFileLocks.delete(key);
  });
  return run;
}

/**
 * Run `fn` with exclusive access to one flow file. Exported so the tools whose
 * critical section spans more than an append — `flow-start-recording`'s
 * truncate-then-register, `flow-finish-recording`'s read-then-clear — hold the
 * same lock that {@link appendStepToFlow} takes.
 */
export async function withFlowFileLock<T>(
  projectRoot: string,
  name: string,
  fn: () => Promise<T>
): Promise<T> {
  return withFlowLock(await resolveFlowKey(projectRoot, name), fn);
}

/**
 * Leak backstop only. Sessions are small and auto-spawned servers idle out
 * after 30 min, but a long-lived server could accumulate recordings an agent
 * started and never finished. Well past any realistic concurrent-agent count,
 * so evicting should never be something an agent observes — and if it ever is,
 * the next append fails loudly rather than writing into a recording the server
 * has forgotten. Which function reports it depends on the ordering: an append
 * issued after the eviction fails in {@link requireRecordingSession}, since the
 * key is already gone by the time it resolves; only one whose session was
 * resolved BEFORE the eviction and landed after reaches
 * {@link assertSessionStillLive}.
 */
export const MAX_RECORDINGS = 32;

/**
 * Stamp a session as most-recently-used. A counter rather than `Date.now()`:
 * wall-clock has millisecond resolution, so sessions touched inside one
 * millisecond tie, and the eviction scan's tie-break is map insertion order —
 * which can drop the session that was touched most recently while keeping one
 * that was not touched at all. A counter cannot tie, so "least recently used"
 * means exactly that.
 */
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

export interface RecordingSessionInit {
  name: string;
  projectRoot: string;
  persist: FlowPersistMode;
  filePath: string;
  flow: FlowFile;
}

/**
 * Begin a recording. Returns the session it replaced when one was already live
 * on the same key (a re-record of the same flow, which discards the earlier
 * take), or null — the common case, including starting a second, unrelated
 * recording while others are in progress.
 */
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

/**
 * Every live recording. Feeds the not-found error message, which names only
 * the caller's own project; `steps` is carried for tests and diagnostics.
 */
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
    // Name what was asked for AND what is live, so the agent can self-correct:
    // with concurrent recordings the usual cause is a typo in `name` or the
    // wrong `project_root`.
    //
    // Only this project's recordings are named. The others are counted, not
    // listed: a tool-server bound beyond loopback is shared by unrelated
    // callers (that is what "client" persist mode exists for), and their flow
    // names and absolute project paths are not this caller's to see. A typo in
    // your own project — the case worth recovering from — is still spelled out.
    const active = listActiveRecordings();
    // Compare roots the way the key does (path.join-normalized), or a caller
    // that spells its own root with a trailing slash would be told its live
    // recording is in "another project" — degrading the message in exactly the
    // wrong-project_root case it exists to diagnose.
    const hereDir = getFlowsDir(projectRoot);
    const here = active.filter((r) => getFlowsDir(r.projectRoot) === hereDir);
    const elsewhere = active.length - here.length;
    const others = elsewhere > 0 ? ` (plus ${elsewhere} in other projects)` : "";
    const activeList = here.length
      ? `${here.map((r) => `"${r.name}"`).join(", ")}${others}`
      : `none in this project${others}`;
    // Do NOT tell the agent to just call flow-start-recording. This message is
    // reached when the key was never started, but equally when a take was
    // finished or dropped by the MAX_RECORDINGS backstop — and in those cases
    // the flow file on disk is fully populated while no session owns it. (A key
    // SUPERSEDED by a restart is NOT one of them: the superseding session holds
    // the key, so this call resolves to it and returns success rather than
    // reaching here — and that restart has already truncated the file, so
    // "fully populated" would not hold there anyway.) flow-start-recording
    // truncates unconditionally, so the advice that recovers the never-started
    // case destroys the others. Same doctrine as {@link assertSessionStillLive},
    // which faces the identical ambiguity.
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
  // The key is the file's identity, so a session found under it may have been
  // registered under a DIFFERENT spelling of that one file — a symlink into a
  // shared vault, a symlinked `.argent/flows`, a root spelled `/tmp` vs
  // `/private/tmp`, a name cased two ways on APFS. Handing it over would risk
  // silently enrolling this caller in someone else's take: its steps would land
  // in a file it never addressed, under a prerequisite it never declared, and
  // its finish would report the other agent's steps as its own. A root spelled
  // with a trailing slash is not one of these — `getFlowPath` normalizes both
  // sides before they are compared.
  //
  // Which of two situations this is cannot be told apart from here, so the
  // message must assert neither. It is EITHER the same caller respelling its
  // own root or name — nothing was truncated, the take is live and intact, and
  // re-addressing it under the registered spelling resumes it — OR another
  // caller's restart, which did truncate. Naming the second as fact sent a
  // caller in the first situation to abandon a healthy recording and re-walk
  // the whole flow on the device. The advice that recovers both is the same:
  // use the spelling the session is registered under, which is the one
  // `flow-start-recording` was given.
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
 * {@link appendStepToFlow} makes, and for the same reason. A key that moved
 * under the session (a symlinked flow file whose target went away
 * mid-recording, or a link repointed) re-resolves to something this map does
 * not hold, so the delete missed silently: the finish reported success while
 * the session stayed live, unfinishable, and holding the key against its own
 * restart.
 */
export function clearRecordingSession(session: RecordingSession): void {
  recordings.delete(session.key);
}

export function __resetRecordingsForTesting(): void {
  recordings.clear();
  flowFileLocks.clear();
  keyResolutions.clear();
}

/**
 * How many flow files currently have a lock entry. Test-only: the map's
 * self-cleanup is a leak backstop with no other observable effect, so nothing
 * else can tell a released lock from a retained one.
 */
export function __flowFileLockCountForTesting(): number {
  return flowFileLocks.size;
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
  /**
   * Screen READINESS: the UI tree has content, and neither it nor the rendered
   * pixels are still changing. Spelled `await: { idle: true }` — a condition
   * like any other, but the only one that takes no selector, because stillness
   * is a property of the whole screen. There is no `assert` form: "has it
   * stopped moving yet" is inherently a wait.
   */
  | { kind: "idle"; timeout?: number; stableFor?: number }
  | { kind: "wait"; ms: number }
  | { kind: "scroll-to"; target: FlowSelector; direction: ScrollDirection; within?: FlowSelector }
  | { kind: "pinch"; selector?: FlowSelector; scale: number }
  | { kind: "rotate"; selector?: FlowSelector; by: number }
  | { kind: "snapshot"; name: string; maxMismatch?: number; cropOn?: FlowSelector }
  /**
   * Run a trusted local JavaScript file in a fresh Node process, for setup,
   * cleanup, or any work the device directives cannot do. `path` is the
   * as-written YAML path, resolved against the containing file's directory
   * exactly as a `run:` target is; `timeout` is the hard limit in
   * milliseconds. The runner gives the step no device — the steps around it
   * drive one.
   */
  | { kind: "script"; path: string; timeout?: number };

export type FlowFile = {
  /** Fragments only: documented entry-state contract. "" when unset. */
  executionPrerequisite: string;
  steps: FlowStep[];
};

/**
 * The literal child steps of a block directive, or undefined for a leaf step.
 *
 * The single predicate for "this step has authored children", read at seven
 * sites. Four expand a block that will NOT execute into skip lines, so a report
 * keeps one line per authored step no matter where the run ended: `execSteps`'
 * three gates — a hard stop, a device-free flow, a cancellation — plus
 * `reportBlockSkipped` recursing into a nested block. (A guard-unmet `when`
 * reaches those same skip lines by another route: `execWhenStep` has the block
 * in hand and passes `step.steps` straight to `reportBlockSkipped`.) The fifth
 * is the upload preflight's walk, where a block it cannot see hides a nested
 * `run:`/`snapshot` from validation. The sixth and seventh,
 * `flowRequiresDevice` and `flowScopesDevice` (flow-device.ts), read children
 * not to skip them but to resolve the flow's device decisions from a block's
 * body — the guard against a later block directive whose header reads nothing
 * off the device, and dead in a run while `when`, whose header already
 * classifies device-requiring, is the only block kind.
 *
 * Six sites asked `kind === "when"` directly before this existed: five for the
 * children, one for the dispatch (now {@link isBlockStep}/`execBlockStep`);
 * `flowRequiresDevice`'s walk arrived after the predicate and never had to. A
 * second block directive would have had to remember all six; a forgotten one
 * drops a whole block from the report or preflight silently. Now both are one
 * case here, the same case the PARSER exempts from the single-key sibling
 * check: the kinds come from {@link BLOCK_DIRECTIVE_KEYS}, not restated.
 */
export function blockSteps(step: FlowStep): FlowStep[] | undefined {
  return isBlockStep(step) ? (step.steps satisfies FlowStep[]) : undefined;
}

/**
 * Narrow a step to the kinds {@link BLOCK_DIRECTIVE_KEYS} lists. `Extract` is
 * what makes the list load-bearing: {@link blockSteps}' `.steps` typechecks
 * only while EVERY listed kind's step type carries children. The `satisfies`
 * there pins them to a REQUIRED `steps`; an optional one types as
 * `FlowStep[] | undefined`, which the return type alone would accept while
 * every reader sees a childless leaf.
 */
export function isBlockStep(step: FlowStep): step is BlockStep {
  return isBlockDirectiveKey(step.kind);
}

/**
 * Is a `launch` behind this step still the launch the run BEGINS with?
 *
 * Two kinds are transparent to that question. `echo` narrates. `script` runs a
 * Node process the runner never routes to the device — which is the
 * whole of the seed-then-launch ordering it exists for, so a flow that seeds an
 * order and then launches its app is as launch-led as one that only launches.
 * Every other kind settles the question where it stands: a launch behind it is
 * not the flow's leading one.
 *
 * Both readers spelled this inline as an `echo`-only skip before — the chromium
 * boot hoist (`scanLeadingLaunch`) and the prerequisite rule ({@link
 * isE2eFlow}) — so `script` landed on the opaque side by inheritance rather
 * than by decision, and a `script:`-led chromium flow hoisted no boot, bound to
 * whatever browser happened to be up, and reported a launch it never performed
 * as a pass. The same lead-in walked that flow past the `executionPrerequisite`
 * refusal its `echo`-led twin is given. Neither reader is a `switch`, which is
 * why the exhaustiveness tests could not see them; the `never` binding here is
 * what makes the next kind answer this rather than inherit an answer.
 */
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

/**
 * A flow is end-to-end iff it BEGINS by launching an app — the first step a
 * launch cannot sit behind ({@link precedesLeadingLaunch}) is a `launch`. Such
 * a flow controls its own start state, so it is the natural standalone/suite
 * entry point and must not declare an `executionPrerequisite`. Everything else
 * is a fragment.
 */
export function isE2eFlow(flow: FlowFile): boolean {
  const first = flow.steps.find((s) => !precedesLeadingLaunch(s));
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

/**
 * The one condition that takes no selector. It shares the `await:` key with
 * {@link YamlWaitCondition} but is deliberately NOT part of that union — a step
 * body carries either a selector condition or this one, never a mix — so it is
 * parsed by {@link parseIdleFields} rather than by parseWaitFields.
 */
type YamlIdleCondition = { idle: true; stableFor?: number; timeout?: number };

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
  | { await: (YamlWaitCondition & { timeout?: number }) | YamlIdleCondition }
  | { assert: YamlWaitCondition }
  | { wait: number }
  | { "scroll-to": YamlScrollBody }
  | { pinch: { on?: YamlSelector; scale: number } }
  | { rotate: { on?: YamlSelector; by: number } }
  | { snapshot: string | { name: string; maxMismatch?: number; cropOn?: YamlSelector } }
  // Always a map, deliberately — see parseScriptStep for why `script:` refuses
  // the bare-value sugar four other directives accept.
  | { script: { path: string; timeout?: number } };

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

/**
 * Sugar an `idle` step back under its `await:` key. Optional fields are emitted
 * only when set, so the canonical minimal spelling (`await: { idle: true }`)
 * round-trips unchanged.
 */
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
    case "script": {
      // Key order is preserved, and `path` reads first because it is the
      // step's subject. `timeout` is emitted only when set, so the minimal
      // spelling round-trips unchanged.
      const body: { path: string; timeout?: number } = { path: step.path };
      if (step.timeout !== undefined) body.timeout = step.timeout;
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
      // Declared exhaustive rather than falling through to the `tool` arm. That
      // arm reads `name`, `args` and `delayMs`, so it happens to reject any
      // kind carrying none of them — but a future kind that carries even one
      // would compile there and serialize as somebody else's step, silently
      // rewriting a flow file on the next `flow-add-step` round trip. The
      // binding turns that into a build error.
      const unserialized: never = step;
      void unserialized;
      throw new Error(
        `internal: no YAML spelling for step kind "${(unserialized as FlowStep).kind}"`
      );
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
 * MAX_BLOCK_DEPTH. A size bound, not a depth bound, because each level can open
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
  // What the author is allowed to write, which is NOT the same as what this
  // function parses: a body naming `idle` is routed to parseIdleFields before
  // we get here, so this list is only ever read by an author whose body named
  // no legal condition, or more than one — and omitting `idle` from it left the
  // one condition they may have been reaching for out of the answer. Only
  // `await` gains it; `assert` and `when:` genuinely have no readiness form.
  const legalKeys = kind === "await" ? [...WAIT_CONDITIONS, IDLE_CONDITION] : WAIT_CONDITIONS;
  if (raw === null || typeof raw !== "object") {
    badEntry({ [kind]: raw }, `${kind} needs a condition (${legalKeys.join(", ")})`);
  }
  const b = raw as Record<string, unknown>;

  // The condition is the key; its value is the selector.
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
    timeout = parseAwaitTimeout({ [kind]: b }, b.timeout);
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
 * The one condition key that takes no selector. Its presence in an
 * `await`/`assert` body routes parsing away from {@link parseWaitFields} — see
 * {@link parseIdleFields}.
 */
const IDLE_CONDITION = "idle";

/**
 * `idle`'s defaults and cadence, spelled here rather than beside the runner
 * because the parser needs all of them: a wait that cannot contain the settle
 * it asks for can never be satisfied, and this file rejects unsatisfiable
 * gates. The runner imports them back.
 */
export const IDLE_DEFAULT_TIMEOUT_MS = 7500;
export const IDLE_DEFAULT_STABLE_FOR_MS = 250;

/** `idle` poll cadence, matching `await-screen-idle`'s own. */
export const IDLE_POLL_MS = 200;

/**
 * How many consecutive intervals must read as still before the screen is
 * called settled. Two, not one, because a single agreeing pair of captures is
 * not evidence of stillness: any animation that reverses — a cross-fade, a
 * pulse, a bounce — has a turning point, and two samples straddling it come
 * back identical while the screen is very much moving. Observed on a 3s
 * white/indigo cross-fade, where a default-shaped step passed on roughly one
 * run in three. A second agreeing interval needs a third sample, which the
 * same phase symmetry cannot supply unless the animation's period happens to
 * match the poll — so the aliasing that survives one comparison does not
 * survive two.
 */
export const IDLE_MIN_STILL_INTERVALS = 2;

/**
 * The stretch a settle is measured over: the intervals it takes, at one poll
 * each. Nothing can be concluded about motion in less.
 */
export const IDLE_SETTLE_SPAN_MS = IDLE_MIN_STILL_INTERVALS * IDLE_POLL_MS;

/**
 * The smallest `timeout:` that can contain a settle holding for `stableFor`. A
 * `timeout:` under this cannot produce a clean settle however still the screen
 * is, so the step would report on a screen it never had the chance to judge.
 *
 * The hold is measured ACROSS the polls, not after them: the runner starts the
 * hold clock on the first read that carries content and settles on the first
 * round that has both {@link IDLE_MIN_STILL_INTERVALS} agreeing intervals AND
 * `stableFor` of elapsed hold. The two costs therefore overlap, and what the
 * wait must contain is whichever of them is longer — plus one poll, the budget
 * the closing round needs to be allowed to start (see the runner's
 * MIN_ROUND_BUDGET_MS).
 *
 * Adding them instead over-demanded by up to {@link IDLE_SETTLE_SPAN_MS}, and
 * taught a cost model the runner does not implement: `timeout: 1000,
 * stableFor: 800` was rejected as impossible and settles in ~820ms, and the
 * default hold was rejected at `timeout: 600` while settling in ~411ms. The
 * two agree exactly at `stableFor: 0`, which is where the sum was derived.
 */
export function idleMinimumTimeoutMs(stableFor: number): number {
  return Math.max(IDLE_SETTLE_SPAN_MS, stableFor) + IDLE_POLL_MS;
}

/**
 * Absolute ceiling on the hold, so an obviously wrong unit (seconds, or a
 * pasted timestamp) is rejected as a number rather than silently becoming a
 * gate no run can pass. The relationship that actually matters is with
 * `timeout`, checked separately.
 */
const IDLE_MAX_STABLE_FOR_MS = 600_000;

/**
 * The `timeout` sibling key an `await` may carry, spelled once for both the
 * selector conditions and `idle`.
 *
 * Non-finite values are rejected alongside non-positive ones: YAML `.inf` (or
 * an overflowing literal like 1e400) parses to Infinity — typeof number and
 * > 0 — which would make the runner's poll deadline unreachable and the await
 * unbounded.
 */
function parseAwaitTimeout(entry: unknown, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    badEntry(
      entry,
      "await.timeout needs a positive number of milliseconds (e.g. `timeout: 10000`)"
    );
  }
  return value as number;
}

/** Bounded non-negative integer option, in milliseconds. */
function parseBoundedMs(entry: unknown, value: unknown, where: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
    badEntry(entry, `${where} needs an integer between 0 and ${max} (milliseconds)`);
  }
  return value as number;
}

/**
 * Parse an `await`/`assert` body carrying the `idle` condition. Returns the
 * finished step, because unlike the selector conditions it has no selector to
 * hand back as fields.
 *
 * `assert` is rejected outright: waiting is the whole point of the check.
 */
function parseIdleFields(raw: Record<string, unknown>, kind: "await" | "assert"): FlowStep {
  const entry = { [kind]: raw };

  if (kind !== "await") {
    // Name the other condition's home too when the body carries one. Reporting
    // the mixing error first sent the author to a second round trip: splitting
    // `assert: { idle: true, visible: X }` as instructed yields
    // `assert: { idle: true }`, which has no assert form either.
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

  // `idle: true` only. A falsey value would spell "assert the screen is NOT
  // settled", which no flow wants and the runner cannot answer.
  if (raw.idle !== true) {
    badEntry(entry, "idle takes only `true` (`await: { idle: true }`)");
  }

  const step: Extract<FlowStep, { kind: "idle" }> = { kind: "idle" };
  if ("timeout" in raw) step.timeout = parseAwaitTimeout(entry, raw.timeout);
  if (raw.stableFor !== undefined) {
    step.stableFor = parseBoundedMs(entry, raw.stableFor, "idle.stableFor", IDLE_MAX_STABLE_FOR_MS);
  }

  // A wait that cannot contain the settle it asks for is a gate that never
  // passes, however still the screen is — and it does not fail quietly: the
  // step spends its whole timeout and then reports either that the screen
  // never stopped moving or that it could not be screenshotted, both of them
  // claims about an app that did nothing. Which one it picks depends on where
  // the budget ran out, so the same file yields different verdicts run to run.
  // Caught here, deviceless.
  //
  // Checked against the EFFECTIVE hold, not just a written-out one: the
  // default is what most steps run with, so leaving it out was the way to get
  // an unsatisfiable step past the parser (`timeout: 100` was accepted while
  // the identical `timeout: 100, stableFor: 250` was rejected).
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

/**
 * Whether an `await`/`assert` body names the `idle` condition rather than an
 * ordinary selector one. Rejects a body that mixes the two rather than silently
 * preferring one.
 */
function isIdleCondition(raw: unknown, kind: "await" | "assert"): boolean {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return false;
  const body = raw as Record<string, unknown>;
  if (!(IDLE_CONDITION in body)) return false;
  // An `assert` body naming idle is wrong however it is spelled, so let
  // parseIdleFields raise the one error that ends the matter — it folds the
  // mixing advice in rather than making the author earn it on a second run.
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
  "script",
];

/**
 * The directive keys that carry a sibling `steps:` list — the single registry
 * of what a block directive is: {@link blockSteps} reads THIS list rather than
 * restating the kinds, so parse time and run time cannot answer differently.
 * Three constraints keep an entry honest. Two judge the keys already listed:
 * `satisfies` rejects a key that is not a real step kind, and blockSteps'
 * `.steps` read rejects a kind with no usable `steps` - `Extract` catches a
 * missing one, its own `satisfies` one that is not a `FlowStep[]`, so a
 * childless directive listed here is a compile error, not a silent runtime
 * `undefined`. Neither can force a key IN, which is what
 * {@link _everyChildBearingKindIsRegistered} does — without it a child-bearing
 * kind added later is simply absent here, and absent is not an error.
 *
 * At parse time these keys are exempt from the single-key sibling check,
 * because their own parser validates their siblings with pointed messages.
 */
export const BLOCK_DIRECTIVE_KEYS = ["when"] as const satisfies readonly FlowStep["kind"][];

/** The step kinds {@link BLOCK_DIRECTIVE_KEYS} names. */
type BlockDirectiveKind = (typeof BLOCK_DIRECTIVE_KEYS)[number];

/** The step union those kinds select - what {@link isBlockStep} narrows to. */
export type BlockStep = Extract<FlowStep, { kind: BlockDirectiveKind }>;

/**
 * Every step kind whose type carries a `steps` property, whatever its spelling:
 * optional, `readonly`, any element type. Distributes over the union and asks
 * `keyof` rather than matching structurally, because the obvious
 * `Extract<FlowStep, { steps: FlowStep[] }>` misses a `steps?` or a
 * `readonly FlowStep[]` - anything not both required and assignable to
 * `FlowStep[]` reads as a childless leaf.
 */
type ChildBearingKind<S extends FlowStep = FlowStep> = S extends unknown
  ? "steps" extends keyof S
    ? S["kind"]
    : never
  : never;

/** The child-bearing step kinds {@link BLOCK_DIRECTIVE_KEYS} fails to list. */
type UnregisteredBlockKind = Exclude<ChildBearingKind, BlockDirectiveKind>;

/**
 * Forces a child-bearing kind INTO the registry — the direction the two
 * constraints on {@link BLOCK_DIRECTIVE_KEYS} cannot cover, since both only
 * judge kinds already listed. An unlisted one parses like any other step and
 * then reads as `undefined` from {@link blockSteps}, so every reader listed
 * there silently misses its children. {@link ChildBearingKind} is what makes
 * this reach every spelling of `steps`, not just the one a structural match
 * names. Spelled as a conditional rather than a bare `never` so the compile
 * error names the missing kind.
 */
const _everyChildBearingKindIsRegistered: [UnregisteredBlockKind] extends [never]
  ? true
  : UnregisteredBlockKind = true;

/**
 * Is this directive key a block directive? The parser and runner's only
 * CLASSIFYING read of {@link BLOCK_DIRECTIVE_KEYS} ({@link assertBlockDepth}
 * reads it to NAME the keys in its message); the widening is the lookup
 * itself — the const tuple's own `includes` accepts only keys already known to
 * be block kinds, which is the question being asked.
 */
function isBlockDirectiveKey(key: string): key is BlockDirectiveKind {
  return (BLOCK_DIRECTIVE_KEYS as readonly string[]).includes(key);
}

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
  // A guard asks what is on the screen NOW, so "has it stopped moving yet" is
  // not a question it can ask. Say that outright, the way the assert form does,
  // rather than listing the keys the author could have written and leaving them
  // to infer that the one they did write is not among them.
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
 * Nesting cap for block directives — the parse-side analog of flow-run's
 * MAX_RUN_DEPTH. A block directive is the only kind of step whose parse
 * recurses into child steps, and the yaml library happily materializes a cyclic
 * alias (`steps: &s … steps: *s`) as a cyclic object; without a cap that cycle
 * escapes parseFlow as a raw RangeError instead of a structured parse error.
 *
 * ONE counter shared by every block directive, deliberately: a per-directive
 * counter would let an alternating chain evade all of them and reopen the hole.
 */
const MAX_BLOCK_DEPTH = 20;

/**
 * Guard a block directive's recursion depth. Called FIRST in a block's parse —
 * before its own key/shape checks — so an entry that has REACHED the cap
 * reports the depth rather than its second defect: nest `when` to the cap and
 * give the entry AT it an `else:`, a third sibling key, or an unknown condition
 * key, and it reports the depth, not that check's message. (A cyclic alias is
 * NOT that case — the same object repeats at every level, so a shape defect in
 * it fires at depth 0 and a well-formed cycle reaches the cap with or without
 * this call.) That early call buys the error PRECEDENCE only, not the cap
 * itself: {@link parseBlockSteps} asserts again before it recurses, so
 * forgetting the early call costs a directive the precedence and nothing more.
 */
function assertBlockDepth(raw: unknown, depth: number): void {
  if (depth >= MAX_BLOCK_DEPTH) {
    const directives = BLOCK_DIRECTIVE_KEYS.map((key) => `\`${key}:\``).join("/");
    badEntry(
      raw,
      `${directives} blocks nest deeper than ${MAX_BLOCK_DEPTH} levels — check for a cyclic YAML alias (\`steps: &s … steps: *s\`)`
    );
  }
}

/**
 * Parse a block directive's sibling `steps:` list: non-empty, every entry an
 * object, each parsed one level deeper so the shared depth cap sees the whole
 * chain. `emptyDetail` is the directive's own message for an absent or empty
 * list — the one part worth phrasing per directive, since it is where an author
 * lands when they wrote the guard but not the body.
 *
 * Asserts the depth cap here too, on the one path every block directive must go
 * through to recurse, so no directive can opt out of the cap by forgetting the
 * early {@link assertBlockDepth} call. `depth` is unchanged between the two
 * calls, so for a directive that made the early one this is a no-op. While
 * every registered directive makes that call, no input can make THIS assert the
 * one that fires, so nothing pins it until one skips the early call.
 */
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

/**
 * Parse a `when` step: `{ when: <condition>, steps: [<step>, …] }` — a guarded
 * block whose steps run only when the condition holds. Deliberately no `else`:
 * a when block exists to restore determinism (dismiss the interstitial, get
 * back on the known path), so paths may only reconverge, never diverge.
 */
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

/**
 * A `script:` step body. **Always a map** — a bare `script: seed.mjs` is
 * rejected, and so is an option written beside the directive key.
 *
 * That is a deliberate exception to the house convention. Four directives
 * (`tap`, `long-press`, `scroll-to`, `snapshot`) accept a bare value or an
 * options map, and `snapshot` is the exact structural analog: `snapshot: home`
 * sugars to `{ name: home }` and {@link toYamlStep} collapses it back. What
 * separates `script:` is what the value IS. In those four the bare form
 * carries the step's SUBJECT and the map hangs options off it; a script step's
 * value is a configuration block whose parts are co-equal, and the parts an
 * author gets wrong are the ones the bare form cannot spell. A flow that began
 * `script: seed.mjs` would have to be rewritten the moment the script needed a
 * time limit, which is the common case — so the one spelling is the map.
 *
 * The sibling-key half of that rule costs no code here: `script` is listed in
 * {@link STEP_DIRECTIVE_KEYS}, which is what lets `fromYamlStep` read the entry
 * as a script step with a stray sibling and reject `script: seed.mjs` +
 * `timeout: 30000` as an unknown key — "step options go inside the `script:`
 * value, not beside it".
 */
function parseScriptStep(raw: unknown, body: unknown): FlowStep {
  if (typeof body === "string") {
    badEntry(
      raw,
      "a `script` step takes a map, not a bare path — write `script: { path: scripts/seed.mjs }`"
    );
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    badEntry(raw, "script needs { path, timeout? }, e.g. `script: { path: scripts/seed.mjs }`");
  }
  const b = body as Record<string, unknown>;
  // `env` lands here too, and must: it is a real key of a later release, and a
  // flow written against a tool server that does not honour it yet would run
  // with the bare allowlist environment — none of the values the flow spelled
  // out — and report green.
  rejectUnknownKeys(raw, b, ["path", "timeout"], "script");
  const step: Extract<FlowStep, { kind: "script" }> = {
    kind: "script",
    path: parseScriptPath(raw, b.path),
  };
  if (b.timeout !== undefined) step.timeout = parseScriptTimeout(raw, b.timeout);
  return step;
}

/**
 * A `script` step's `path`: the same name rules a `run:` target obeys, spelled
 * for `.mjs`.
 *
 * Identical on purpose. Flows are not required to live in `.argent/flows` —
 * `flow_path` names any YAML on the host, and a `run:` target reaches siblings
 * and parents — so scripts are not required to live in one directory either.
 * `..` is admitted for the same reason it is there: shared code may
 * legitimately sit outside the directory of the flow using it, and there is no
 * path fence at resolution time (see resolveFlowRelativeFile in flow-run.ts).
 * `scripts/` is a convention the authoring skill teaches, not a rule this
 * enforces.
 *
 * Three things differ from {@link parseRunTarget}, and only three:
 *
 * - the extension is `.mjs`, which pins the module type against a project's
 *   `package.json` `type` field;
 * - there is no bare-name completion. `run: login` → `login.yaml` is
 *   back-compat for flows once looked up by name in `.argent/flows`; scripts
 *   have no such history, and the explicit extension is load-bearing;
 * - the basename charset is {@link SCRIPT_FILE_NAME_PATTERN}, the `.mjs`
 *   spelling of the one behind FLOW_FILE_NAME_PATTERN.
 */
function parseScriptPath(raw: unknown, value: unknown): string {
  // Uncoerced, exactly as parseRunTarget is: YAML renders a valueless
  // `path:` as null and a bare scalar as a boolean/number, and String()-ing
  // those first would turn a key the author left empty into a live reference
  // to a "null.mjs" that was never meant to exist.
  if (typeof value !== "string" || value.length === 0) {
    badEntry(
      raw,
      "a `script` step needs a `path` — a .mjs file path relative to this flow's file, e.g. `script: { path: scripts/seed.mjs }`"
    );
  }
  if (value.includes("\\")) {
    badEntry(raw, "a `script` path uses forward slashes, e.g. `path: scripts/seed.mjs`");
  }
  // posix.isAbsolute catches `/...`; the drive-letter test catches every win32
  // device form — absolute ("C:/") and drive-RELATIVE ("C:foo", which even
  // win32.isAbsolute passes but which resolves against that drive's own
  // current directory. No `\`-separated absolute survives the rejection above.
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    badEntry(raw, "a `script` path must be relative to the flow file that references it");
  }
  if (!value.endsWith(".mjs")) {
    if (value.toLowerCase().endsWith(".mjs")) {
      badEntry(raw, "a `script` path must use the lowercase .mjs extension");
    }
    badEntry(
      raw,
      "a `script` path must end in .mjs — the extension pins the module type whatever the project's package.json says"
    );
  }
  if (!SCRIPT_FILE_NAME_PATTERN.test(path.posix.basename(value))) {
    badEntry(
      raw,
      `a \`script\` path's filename must match ${SCRIPT_FILE_NAME_PATTERN} — letters, digits, underscore, hyphen before the .mjs`
    );
  }
  return value;
}

/**
 * The `timeout` a `script` step may carry: its hard time limit, in
 * milliseconds. Non-finite values are rejected alongside non-positive ones for
 * the same reason {@link parseAwaitTimeout} rejects them — YAML `.inf` (or an
 * overflowing literal) is typeof number and > 0, and would leave the step with
 * no deadline at all. The executor clamps whatever survives to the host's
 * configured maximum and says so in the step's report.
 */
function parseScriptTimeout(raw: unknown, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    badEntry(raw, "script.timeout needs a positive number of milliseconds (e.g. `timeout: 30000`)");
  }
  return value as number;
}

function fromYamlStep(raw: YamlStep, blockDepth = 0): FlowStep {
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
    // `idle` is a condition, not a step kind, and it is the one near-miss the
    // docs actively produce: every other condition is written with a selector
    // beside it, so `await:` comes along for free, while this one reads like a
    // directive of its own. Spell the answer rather than reporting that a step
    // kind nobody wrote is unrecognized.
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
  // Only a `tool` step carries sibling keys (`args`, `delayMs`); every other
  // directive step is a single-key mapping — its options live INSIDE the
  // value, so a sibling key is a mis-nested or misspelled option. A block
  // directive also carries siblings (`steps`, and whatever it rejects beside
  // it), but its own parser validates them with pointed messages - a promise
  // flow-utils.test.ts pins per registry entry - so the generic check stays
  // out of its way.
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

  // `await:` / `assert:` carry two families of condition: the selector ones
  // (visible/hidden/exists/text, matched against the UI tree) and `idle`, which
  // takes no selector because stillness is a property of the whole screen. The
  // body's key decides which.
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

  if ("script" in raw) return parseScriptStep(raw, (raw as { script: unknown }).script);

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

  // A raw YAMLParseError carries no failure signal, so a syntax error would
  // abort a whole batch run instead of failing this file alone.
  let parsed: YamlFlowFile;
  try {
    parsed = yamlParse(trimmed) as YamlFlowFile;
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

/**
 * Suffix counter for {@link writeFlowFile}'s scratch file. Paired with the pid,
 * this keeps two concurrent writers off each other's temp file: the counter
 * separates writers inside this process, and the pid separates this process
 * from a SECOND tool-server — a different install bundle can record the same
 * `(project_root, name)` and compute the same scratch path (see the
 * cross-install note on {@link recordings}). The CLI is not one of the writers:
 * it writes the destination flow file directly and mints no scratch file, and
 * host and client persist modes are mutually exclusive per call, so no CLI is
 * writing this directory while the tool-server is.
 */
let flowWriteSeq = 0;

/**
 * What actually went wrong, per errno. The swap needs write permission on the
 * DIRECTORY, which is the surprising part and worth stating — but only when
 * that is the failure. Stating it for every code turned an over-long flow name
 * (`ENAMETOOLONG` out of `rename`) into a report of a directory-permissions
 * problem the user would then go and not find.
 */
function writeFailureHint(
  code: string | undefined,
  filePath: string,
  target: string,
  resolvedDir: string
): string {
  // The directory the swap actually uses — `dirname(realpath(filePath))`, not
  // `dirname(filePath)`. For a flow file that is a symlink into a shared vault
  // those are different directories, and only the first one can be the cause:
  // naming the second sent the reader to a `.argent/flows` that is already
  // writable while the vault, the only unwritable thing in the picture, went
  // unmentioned. Say so when they differ, since "your flows dir is fine, the
  // link target is not" is the whole diagnosis there.
  //
  // Compared against the RESOLVED flows dir, not the spelled one. Every
  // symlinked ANCESTOR moves the target too — which on macOS is every `/tmp`
  // and `/var/folders` path — so comparing against the spelling accused a flow
  // file that is a perfectly ordinary regular file of being a symlink, and
  // contrasted two names for one directory.
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

/**
 * The original error with the internal scratch path rewritten to the flow file,
 * so the cause chain `formatErrorForAgent` renders never names a temp file that
 * was already deleted. Everything else about the errno — code, syscall, the
 * kernel's own wording — is kept.
 */
function scrubTempPath(err: unknown, tmpPath: string, filePath: string): Error {
  if (!(err instanceof Error)) return new Error(String(err));
  if (!err.message.includes(tmpPath)) return err;
  const scrubbed = new Error(err.message.split(tmpPath).join(filePath));
  scrubbed.name = err.name;
  return scrubbed;
}

/**
 * A flow file's REAL path. A saved flow may be a symlink into a shared vault —
 * the runner canonicalizes before reading, and `run:` composition anchors on
 * the real file — and rename(2) replaces the path it is handed, so renaming
 * onto the link's own spelling would swap the symlink for a regular file and
 * strand the vault copy with the pre-recording content. A plain write follows
 * the link; resolving first keeps that behavior while keeping the swap atomic.
 *
 * The directory is resolved separately so that a flow file which does not exist
 * yet (the first write of a recording, which has no realpath of its own) still
 * lands on the same canonical spelling as every later append — otherwise the
 * first swap and the rest would disagree wherever an ancestor is itself a
 * symlink, which is the default for the temp dir on macOS.
 *
 * A DANGLING link is the case `realpath` cannot express — it fails on the whole
 * path rather than answering with the target — and that failure would put the
 * link's own spelling back in front of `rename`, i.e. exactly the swap this
 * exists to prevent. {@link followDanglingLink} resolves it by hand.
 *
 * Shared with {@link resolveFlowKey}, so the identity a recording is keyed by
 * and the file its steps land in can never disagree.
 *
 * `dir` — the flows directory as the filesystem sees it — is returned alongside,
 * because it is the only thing a caller can compare `target`'s directory against
 * to tell "the flow FILE is a symlink" from "some ancestor of it is". Comparing
 * against the spelled `path.dirname(filePath)` cannot: on macOS every `/tmp` and
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

/**
 * How deep a chain of not-yet-existing symlinks {@link followDanglingLink}
 * walks. A backstop against a link cycle, which `readlink` alone cannot detect;
 * far past any real vault layout, which is one hop.
 */
const MAX_DANGLING_LINK_HOPS = 32;

/**
 * Where a link whose TARGET does not exist actually points.
 *
 * `realpath` fails outright on a dangling symlink, so the fallback above would
 * hand back the link's own path — and `rename(2)` replaces the path it is
 * given, so the first write of a recording would swap the symlink for a regular
 * file. That is the shared-vault setup's normal starting state: the link is
 * created before the first recording, or its target is removed by a branch
 * switch or a `git clean`. The vault copy is then never created, the project is
 * permanently detached from the vault, and any sibling project linked to the
 * same target is left dangling — with the tool reporting success.
 *
 * So resolve the link by hand, one hop at a time, canonicalizing each target's
 * DIRECTORY the way {@link canonicalFlowPath} does so the result agrees with
 * what a later append (by then a plain `realpath`) will compute. A path that is
 * not a link — the ordinary "flow file does not exist yet" case — comes back
 * unchanged on the first probe.
 */
async function followDanglingLink(linkPath: string): Promise<string> {
  let current = linkPath;
  for (let hop = 0; hop < MAX_DANGLING_LINK_HOPS; hop++) {
    const target = await fs.readlink(current).catch(() => null);
    if (target === null) return current;
    const resolved = path.resolve(path.dirname(current), target);
    // The rest of the chain may well exist — only the last hop has to dangle
    // for `realpath` to have refused the whole path.
    const real = await fs.realpath(resolved).catch(() => null);
    if (real !== null) return real;
    const targetDir = await fs.realpath(path.dirname(resolved)).catch(() => path.dirname(resolved));
    current = path.join(targetDir, path.basename(resolved));
  }
  return current;
}

/** Whether this process may write `filePath` — its mode as the kernel reads it. */
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
 * such a reader could land in the window between the truncate and the write and
 * parse a truncated file, or an empty one — and `parseFlow("")` yields
 * `{ steps: [] }` with no error, which replays as a top-level PASS over zero
 * steps.
 *
 * Writing to a temp file beside the target and renaming makes the swap atomic:
 * a reader sees either the whole previous file or the whole new one. Beside the
 * TARGET, note — `canonicalFlowPath`'s result — which for a symlinked flow is
 * the vault the link points into, not `path.dirname(filePath)`; rename(2) is
 * atomic only within one filesystem, and that is the pairing that guarantees it.
 *
 * The temp name is dotted and `.tmp`-suffixed so a half-written scratch file can
 * never be mistaken for a flow: `getFlowPath` only ever produces `<name>.yaml`,
 * and every site that enumerates a flows directory — `argent flow list`,
 * {@link classifyOnDiskSpelling}, the CLI's recursive suite walk — filters on
 * `.yaml` plus `FLOW_NAME_PATTERN`, so none of them can see one. Keep both
 * halves of that agreement if either side changes.
 *
 * It deliberately does NOT embed the flow name. A flow name has no length cap
 * (`FLOW_NAME_PATTERN` constrains the character set only), so `<name>.yaml` can
 * legitimately run to NAME_MAX — and prefixing that with a discriminator would
 * push the scratch name past the limit, turning an append that used to work
 * into ENAMETOOLONG. pid + counter is unique on its own: the counter separates
 * writers inside this process, the pid separates this process from a second
 * tool-server (a different install bundle) that could be writing the same
 * directory.
 *
 * The swap costs one thing a write-through would have kept, accepted for the
 * atomicity: it needs write permission on the DIRECTORY rather than on the
 * file, and it replaces the inode, so a hardlink to the flow file does not
 * survive an append. The file's own MODE is not among the costs — see below.
 */
async function writeFlowFile(filePath: string, content: string): Promise<void> {
  const { dir: resolvedDir, target } = await canonicalFlowTarget(filePath);
  // Null when the flow file does not exist yet (the first write of a recording),
  // which has no mode to preserve and nothing to be refused by.
  const previousMode = await fs.stat(target).then(
    (s) => s.mode & 0o7777,
    () => null
  );
  if (previousMode !== null && !(await isWritable(target))) {
    // The swap needs permission on the directory, not on the file, so it would
    // replace a `chmod 0444` flow file regardless — turning a plain write's
    // EACCES into a silent success that also relaxed the mode to the umask
    // default. Refuse instead, so a read-only flow file goes on meaning what it
    // meant before the write became atomic.
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
    // Atomic within a filesystem, and the temp file is a sibling of the target,
    // so it is always the same one.
    await fs.rename(tmpPath, target);
  } catch (err) {
    // Leave no scratch file behind, whichever half failed. The write itself can
    // fail with the file already created (ENOSPC, EIO), so this has to cover it
    // too — nothing else ever sweeps this directory.
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    // Rethrow against the flow file, never the scratch path. The temp name is
    // an internal detail — pid+counter suffixed, and already removed above — so
    // surfacing its raw errno (`EACCES: … open '.argent-flow-<pid>-<n>.tmp'`)
    // would name a file that no longer exists and never mention the flow.
    //
    // That applies to the CAUSE as much as to this message:
    // `formatErrorForAgent` walks the cause chain and appends each new message,
    // so attaching the raw errno puts the scratch path in front of the agent
    // anyway — through the one string it actually reads. Scrub the path out of
    // the cause and keep the rest, which is the part worth having.
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

/**
 * Why the flows directory could not be created, per errno. Separate from
 * {@link writeFailureHint} because the surprising cause differs: the swap's
 * hazard is needing permission on the directory, while `mkdir -p`'s is a path
 * COMPONENT that is not a directory — which for a caller-supplied
 * `project_root` almost always means it named a file.
 */
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

/**
 * Create or reset a flow file with `content`, making the parent directory if
 * needed. Atomic (see {@link writeFlowFile}).
 *
 * Both halves are classified. The tool description promises this "fails if the
 * `.argent/flows/` directory cannot be created OR the flow file cannot be
 * written", and leaving the mkdir outside the wrapping made only the second
 * half keep that promise: a `project_root` naming an existing file, or an
 * unwritable one, surfaced as a bare `ENOTDIR`/`EACCES` under
 * REGISTRY_TOOL_EXECUTION_FAILED — no remediation hint, and telemetry
 * attributing a flow failure to the registry — while the same permission
 * problem one line later returned FLOW_FILE_WRITE_FAILED with a hint.
 */
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

/**
 * How many steps the flow file currently holds, or undefined if it cannot be
 * read or parsed.
 *
 * For counting what a truncate is about to destroy, and therefore only ever
 * called in "host" mode. In "client" mode the file lives on the client's
 * machine and this host cannot read it at all, so the in-memory copy is both
 * the take and the only thing countable — the guarantee below does not carry
 * across that boundary. The tool descriptions do not spell that out — they are
 * kept to what the tool does; the agent-facing statement of it lives in
 * `packages/skills/skills/argent-create-flow/references/live-authoring.md`, in
 * the "Starting always truncates the `.yaml`" bullet.
 *
 * The file — not the session's in-memory `flow` — is the take in "host" mode:
 * {@link appendStep}
 * re-reads it before every append and `flow-finish-recording` reads it back for
 * its summary, so a hand-edit made mid-recording (a documented workflow) is
 * part of the take even though the in-memory copy only catches up on the next
 * append.
 *
 * Undefined rather than 0 on a failure, because the two are not the same
 * answer: a hand-edit can leave YAML that `parseFlow` rejects, and reporting
 * "0 steps discarded" there would understate the loss in exactly the case that
 * caused it. The caller reports no count instead.
 */
export async function countStepsOnDisk(filePath: string): Promise<number | undefined> {
  try {
    return parseFlow(await fs.readFile(filePath, "utf8")).steps.length;
  } catch {
    return undefined;
  }
}

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
  await writeFlowFile(filePath, updated);
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
 * A tool resolves its session up front, then runs the step LIVE — which can take
 * minutes — before appending. In that window the recording it holds may have
 * been finished, restarted or evicted, leaving it with a session object that is
 * no longer the one registered for its key. Writing anyway is the worst outcome:
 * the step lands in a file that now belongs to a *different* take and the caller
 * is told it succeeded. Re-check identity at write time, inside the flow-file
 * lock, and fail loudly.
 *
 * The lock makes this exact against the other flow tools, which all mutate
 * `recordings` for a key while holding that key's lock. It is NOT exact against
 * {@link evictIfOverCapacity}, which runs under some OTHER key's lock and can
 * therefore drop this session between the check and the write. That race is
 * benign — the step still lands in the file it was recorded for, and only the
 * NEXT call on the key reports the recording gone.
 */
function assertSessionStillLive(session: RecordingSession, step: FlowStep): void {
  const current = recordings.get(session.key);
  if (current === session) return;
  // A key that is occupied by a DIFFERENT session was restarted; an empty key
  // was either finished or evicted by the MAX_RECORDINGS backstop, which the
  // server cannot tell apart after the fact — so name both rather than guess.
  const why = current
    ? "it was restarted while this step was running, so the step belongs to the discarded take"
    : "it was finished (or dropped by the concurrent-recording cap) while this step was running";
  // Do NOT send the agent to flow-start-recording here. It truncates
  // unconditionally, and on every branch there is now something to lose: the
  // live take that just claimed this key (which restarting would both wipe and
  // steal), or the finished flow sitting on disk. Recording under a fresh name
  // is the only recovery that destroys nothing.
  // Branch the same way `why` does. Asserting "this key now belongs to another
  // take" on the `!current` branch is false by construction — that branch is
  // selected precisely because the key is empty, and `startRecordingSession`
  // registers under this key's lock, so a take that had claimed it would have
  // selected the other branch. Naming a competing agent that does not exist
  // sends an agent whose own finish (or the eviction named one clause earlier)
  // ended the recording looking for the wrong cause.
  const whatIsAtStake = current
    ? `This key now belongs to another take and flow-start-recording truncates, so re-record ` +
      `under a fresh name rather than restarting this one.`
    : `The key is now free, but the finished take is on disk and flow-start-recording truncates ` +
      `it unconditionally, so re-record under a fresh name rather than restarting this one.`;
  const recovery =
    `Nothing was added to the flow file` +
    (step.kind === "echo"
      ? ". "
      : ", but the step itself already ran on the device — repeating it repeats that action. ") +
    whatIsAtStake;
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

/**
 * Append a step to a recording and persist it. In "host" mode the file on disk
 * is re-read first (the original behavior — a manual edit made mid-recording is
 * honored); in "client" mode this process never sees the client's disk, so the
 * in-memory copy is authoritative and the updated YAML travels back in the
 * directive.
 */
export async function appendStepToFlow(
  session: RecordingSession,
  step: FlowStep
): Promise<{ savedTo: FlowSavedTo; stepCount: number }> {
  // The session's OWN key, not a fresh resolution of it: the lock this append
  // takes and the identity {@link assertSessionStillLive} checks must be the
  // same one, or a key that moved under the session (a symlink repointed
  // mid-recording) would let the append hold one lock while asserting about
  // another.
  return withFlowLock(session.key, async () => {
    assertSessionStillLive(session, step);
    session.lastTouchedSeq = touch();
    if (session.persist === "host") {
      const flowFile = await appendStep(session.filePath, step);
      session.flow = parseFlow(flowFile);
      // Count inside the lock, off the just-refreshed `session.flow`: a caller
      // reading `session.flow.steps.length` after this returns would be racing
      // a concurrent same-key append, which can reassign `session.flow` between
      // the release here and that read.
      return { savedTo: session.filePath, stepCount: session.flow.steps.length };
    }
    session.flow.steps.push(step);
    try {
      // Both of these can reject on a bad step — validateFlow on a cross-field
      // violation, serializeFlow on an unrepresentable one (e.g. a tap with
      // un-normalized coordinates). Roll back on either: in client mode this
      // in-memory copy is the ONLY copy, so leaving the rejected step in it
      // poisons the recording — every later append, and the finish itself,
      // would re-hit the same error with no way to recover.
      validateFlow(session.flow);
      const flowFile = serializeFlow(session.flow);
      return {
        savedTo: clientFileDirective(session.filePath, flowFile),
        stepCount: session.flow.steps.length,
      };
    } catch (err) {
      session.flow.steps.pop(); // keep the in-memory copy consistent: nothing recorded
      throw err;
    }
  });
}
