import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import type { Registry } from "@argent/registry";

import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import { flowInsertEchoTool } from "../../src/tools/flows/flow-insert-echo";
import { flowFinishRecordingTool } from "../../src/tools/flows/flow-finish-recording";
import { createFlowAddStepTool } from "../../src/tools/flows/flow-add-step";
import { createRunFlowTool } from "../../src/tools/flows/flow-run";
import { flowReadPrerequisiteTool } from "../../src/tools/flows/flow-read-prerequisite";
import { formatErrorForAgent } from "../../src/utils/format-error";
import {
  __resetRecordingsForTesting,
  getRecordingSession,
  listActiveRecordings,
  MAX_RECORDINGS,
  parseFlow,
  serializeFlow,
  withFlowFileLock,
  __flowFileLockCountForTesting,
  type FlowFile,
  type FlowStep,
} from "../../src/tools/flows/flow-utils";

// Wrap (not replace) `rename` so every call still does the real filesystem
// rename — every other test's atomicity assertions depend on that — while
// letting the atomic-swap test below inspect exactly which paths each write
// renamed between. Everything else in `node:fs/promises` passes through
// untouched.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

/**
 * Concurrency contract of the recording tools. One tool-server serves every MCP
 * client, subagent and CLI call using one argent install, so several agents can
 * legitimately be recording at the same moment — in one project or across
 * projects. (Two INSTALLS run two servers and two recording maps; nothing here
 * covers that, and nothing can — see the note on `recordings` in flow-utils.)
 * A recording is identified by its
 * (project_root, name) key, and these tests assert the ISOLATION that follows:
 * one recording's steps never land in another's file, addressing a key that
 * isn't live fails loudly (naming the ones that are), replaying a flow
 * elsewhere rebinds nothing, and appends to one session can't lose each other.
 *
 * The second half pins the *mutual exclusion* that makes the above hold when
 * the tools genuinely overlap. Every recording tool's critical section straddles
 * an await — a restart's truncate-then-register, a finish's read-then-clear, an
 * append's read-then-write — so each is covered by the per-flow-file lock, and a
 * step that resolved its session before some other tool superseded it must fail
 * rather than write into a file that now belongs to a different take. A finish
 * that fails inside its critical section must also leave the recording live, so
 * the take survives the failure and can be finished on a retry.
 */

const IOS_DEVICE = "00000000-0000-0000-0000-0000000000ab";

// ── Harness ──────────────────────────────────────────────────────────

let roots: string[] = [];

/** A real temp dir standing in for one agent's project root. */
async function makeRoot(label: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `flow-concurrent-${label}-`));
  roots.push(dir);
  return dir;
}

/** A promise plus the function that resolves it. */
function openGate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { promise, open };
}

/** Installed by {@link gateNextSubTool}; consumed by the mock registry. */
let subToolGate: (() => Promise<void>) | null = null;

/**
 * Suspend the NEXT live sub-tool execution and report when it is reached.
 *
 * flow-add-step resolves its recording session, runs the step LIVE (which can
 * take minutes on a device), and only then appends. Parking a step inside that
 * window is what puts an append genuinely in flight across a concurrent
 * restart / finish / eviction — deterministically, with no timing guesses.
 */
function gateNextSubTool(): { reached: Promise<void>; release: () => void } {
  const arrived = openGate();
  const held = openGate();
  subToolGate = async () => {
    // One-shot: later calls (including the ones asserting the recording still
    // works afterwards) run straight through.
    subToolGate = null;
    arrived.open();
    await held.promise;
  };
  return { reached: arrived.promise, release: held.open };
}

function createMockRegistry(): Registry {
  return {
    invokeTool: vi.fn(async (id: string, args?: unknown) => {
      if (id === "list-devices") return { devices: [] };
      // Yield a macrotask, so calls issued without an await in between all
      // finish their LIVE phase before any of them appends. This is NOT what
      // creates the overlap the file tests: `appendStep`'s own
      // `await fs.readFile` already suspends every caller inside the
      // read-modify-write, so the append phases interleave with or without this
      // line. It stands in for a real sub-tool's I/O, and lines the calls up at
      // the same starting gun.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (subToolGate) await subToolGate();
      if (id === "run-sequence") {
        const first = (args as { steps?: Array<{ tool?: string }> })?.steps?.[0];
        if (first?.tool === "screenshot") {
          return {
            completed: 0,
            total: 2,
            steps: [
              {
                tool: "screenshot",
                error: 'Tool "screenshot" is not allowed in run-sequence.',
                dispatched: false,
              },
            ],
          };
        }
        return { completed: 0, total: 2, steps: [{ tool: "keyboard", error: "device went away" }] };
      }
      if (id === "flow-execute" && (args as { name?: string })?.name === "needs-prereq") {
        return {
          flow: "needs-prereq",
          notice: "This flow has an execution prerequisite",
          executionPrerequisite: "On login screen",
        };
      }
      return { ok: true };
    }),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
  } as unknown as Registry;
}

const registry = createMockRegistry();
const addStepTool = createFlowAddStepTool(registry);

const flowPath = (root: string, name: string): string =>
  path.join(root, ".argent", "flows", `${name}.yaml`);

function start(root: string, name: string, executionPrerequisite?: string) {
  return flowStartRecordingTool.execute({}, { name, project_root: root, executionPrerequisite });
}

function addRawStep(root: string, name: string, command: string, args: Record<string, unknown>) {
  return addStepTool.execute({}, { name, project_root: root, command, args: JSON.stringify(args) });
}

/** Record a `tool` step tagged with `marker`, so its file of origin is provable. */
function addStep(root: string, name: string, marker: string) {
  return addRawStep(root, name, "keyboard", { text: marker });
}

function addEcho(root: string, name: string, message: string) {
  return flowInsertEchoTool.execute({}, { name, project_root: root, message });
}

function finish(root: string, name: string) {
  return flowFinishRecordingTool.execute({}, { name, project_root: root });
}

async function writeSavedFlow(root: string, name: string, flow: FlowFile): Promise<void> {
  await fs.mkdir(path.dirname(flowPath(root, name)), { recursive: true });
  await fs.writeFile(flowPath(root, name), serializeFlow(flow), "utf8");
}

/** Collapse steps to their markers so a file's contents read at a glance. */
function markers(steps: FlowStep[]): string[] {
  return steps.map((step) => {
    if (step.kind === "echo") return `echo:${step.message}`;
    if (step.kind === "tool") return `tool:${String(step.args.text)}`;
    return step.kind;
  });
}

async function readSteps(root: string, name: string): Promise<FlowStep[]> {
  return parseFlow(await fs.readFile(flowPath(root, name), "utf8")).steps;
}

async function readMarkers(root: string, name: string): Promise<string[]> {
  return markers(await readSteps(root, name));
}

async function captureFailure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to fail");
}

/** Let real timers and in-flight fs I/O drain, so "still blocked" means blocked. */
function settle(ms = 25): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve to `label` if `promise` settles in time, else to "timed-out". */
async function within<T>(promise: Promise<T>, label: string, ms = 2000): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve("timed-out"), ms);
  });
  try {
    return await Promise.race([promise.then(() => label), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Fill the recording table exactly to its cap; returns the names, oldest first. */
async function fillRecordings(root: string): Promise<string[]> {
  const names = Array.from({ length: MAX_RECORDINGS }, (_, i) => `rec-${i}`);
  for (const name of names) await start(root, name);
  return names;
}

beforeEach(() => {
  __resetRecordingsForTesting();
  subToolGate = null;
  roots = [];
});

afterEach(async () => {
  __resetRecordingsForTesting();
  subToolGate = null;
  await Promise.all(roots.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  roots = [];
});

// ── Two recordings, one project ──────────────────────────────────────

describe("two recordings in one project", () => {
  it("keeps interleaved steps on their own files, in order", async () => {
    const root = await makeRoot("one-project");
    await start(root, "alpha");
    await start(root, "beta");

    expect(
      listActiveRecordings()
        .map((r) => r.name)
        .sort()
    ).toEqual(["alpha", "beta"]);

    // Interleave the two recordings the way two agents sharing the server would.
    await addStep(root, "alpha", "a1");
    await addEcho(root, "beta", "b1");
    await addStep(root, "alpha", "a2");
    await addEcho(root, "beta", "b2");

    expect(await readMarkers(root, "alpha")).toEqual(["tool:a1", "tool:a2"]);
    expect(await readMarkers(root, "beta")).toEqual(["echo:b1", "echo:b2"]);
  });

  it("finishing one leaves the other live and still appendable", async () => {
    const root = await makeRoot("one-project-finish");
    await start(root, "alpha");
    await start(root, "beta");
    await addStep(root, "alpha", "a1");
    await addEcho(root, "beta", "b1");

    const finished = await finish(root, "alpha");
    expect(finished.path).toBe(flowPath(root, "alpha"));
    expect(markers(parseFlow(finished.flowFile).steps)).toEqual(["tool:a1"]);
    expect(finished.steps).toBe(1);

    // Only alpha's key was cleared.
    expect(await getRecordingSession(root, "alpha")).toBeUndefined();
    expect((await getRecordingSession(root, "beta"))?.filePath).toBe(flowPath(root, "beta"));

    // beta keeps recording into its own file.
    await addEcho(root, "beta", "b2");
    await addStep(root, "beta", "b3");
    const finishedB = await finish(root, "beta");
    expect(markers(parseFlow(finishedB.flowFile).steps)).toEqual(["echo:b1", "echo:b2", "tool:b3"]);
    expect(await readMarkers(root, "beta")).toEqual(["echo:b1", "echo:b2", "tool:b3"]);
    // alpha was never reopened by beta's appends.
    expect(await readMarkers(root, "alpha")).toEqual(["tool:a1"]);
  });
});

// ── One name, two project roots ──────────────────────────────────────

describe("the same flow name under two project roots", () => {
  it("records each project's steps into that project's file only", async () => {
    const rootA = await makeRoot("root-a");
    const rootB = await makeRoot("root-b");

    await start(rootA, "checkout", "Cart has one item");
    await start(rootB, "checkout", "Cart is empty");

    await addStep(rootA, "checkout", "a1");
    await addStep(rootB, "checkout", "b1");
    await addEcho(rootA, "checkout", "a2");
    await addStep(rootB, "checkout", "b2");

    expect(await readMarkers(rootA, "checkout")).toEqual(["tool:a1", "echo:a2"]);
    expect(await readMarkers(rootB, "checkout")).toEqual(["tool:b1", "tool:b2"]);

    // Sessions carry their own project root and prerequisite, not the other's.
    expect((await getRecordingSession(rootA, "checkout"))?.projectRoot).toBe(rootA);
    expect((await getRecordingSession(rootB, "checkout"))?.projectRoot).toBe(rootB);

    const finishedA = await finish(rootA, "checkout");
    expect(finishedA.path).toBe(flowPath(rootA, "checkout"));
    expect(finishedA.executionPrerequisite).toBe("Cart has one item");

    // B is untouched by A finishing, and still resolves to B's file.
    const finishedB = await finish(rootB, "checkout");
    expect(finishedB.path).toBe(flowPath(rootB, "checkout"));
    expect(finishedB.executionPrerequisite).toBe("Cart is empty");
    expect(markers(parseFlow(finishedB.flowFile).steps)).toEqual(["tool:b1", "tool:b2"]);
  });
});

// ── Two keys the filesystem considers one file ───────────────────────

/**
 * The isolation above is stated per KEY, and the key is `path.join` string
 * math while the write resolves through the filesystem. Everything here is a
 * pair of distinct, correctly spelled keys that land on ONE real file — via a
 * symlink, or via a case-insensitive volume. Nothing may treat those as
 * independent: the second start must read as the restart it actually is
 * (discarding the first take, counted), and the first recording's next append
 * must fail loudly rather than land in a take that is no longer its own.
 */
describe("two recording keys that resolve to one file", () => {
  /** Skipped on a case-sensitive volume, where the two names ARE two files. */
  async function fsFoldsCase(dir: string): Promise<boolean> {
    const probe = path.join(dir, "ArgentCaseProbe");
    await fs.writeFile(probe, "", "utf8");
    try {
      await fs.stat(path.join(dir, "argentcaseprobe"));
      return true;
    } catch {
      return false;
    } finally {
      await fs.rm(probe, { force: true });
    }
  }

  it("treats a second project's symlink to the same flow file as a restart", async () => {
    const vault = await makeRoot("vault");
    const rootA = await makeRoot("symlink-a");
    const rootB = await makeRoot("symlink-b");
    const shared = path.join(vault, "checkout.yaml");
    await fs.writeFile(shared, "steps: []\n", "utf8");
    for (const root of [rootA, rootB]) {
      await fs.mkdir(path.dirname(flowPath(root, "checkout")), { recursive: true });
      await fs.symlink(shared, flowPath(root, "checkout"));
    }

    await start(rootA, "checkout");
    await addEcho(rootA, "checkout", "h1-a");
    await addEcho(rootA, "checkout", "h1-b");
    await addEcho(rootA, "checkout", "h1-c");

    // B addresses the same real file under its own spelling. That is a
    // restart, and it destroys A's three-step take — so it must say so.
    const restarted = await start(rootB, "checkout");
    expect(restarted.restarted).toBe(true);
    expect(restarted.discardedSteps).toBe(3);

    // A's session lost the key; its next append fails instead of landing in
    // B's take.
    const err = await captureFailure(addEcho(rootA, "checkout", "h1-d"));
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_NO_ACTIVE_RECORDING);
    // The guard cannot tell this from the same caller respelling its own root,
    // so it names the take that holds the key and offers both readings rather
    // than asserting the destructive one. Here the destructive one is true.
    expect(formatErrorForAgent(err)).toContain("not registered under that spelling");
    expect(formatErrorForAgent(err)).toContain("truncated yours");

    await addEcho(rootB, "checkout", "h2-a");
    // A's finish reports the same loss, rather than handing back B's take as
    // if it were A's own.
    const finishErr = await captureFailure(finish(rootA, "checkout"));
    expect(getFailureSignal(finishErr)?.error_code).toBe(FAILURE_CODES.FLOW_NO_ACTIVE_RECORDING);

    const finishedB = await finish(rootB, "checkout");
    expect(markers(parseFlow(finishedB.flowFile).steps)).toEqual(["echo:h2-a"]);
    // The link survived the swap: one real file, holding only B's take.
    expect(markers(parseFlow(await fs.readFile(shared, "utf8")).steps)).toEqual(["echo:h2-a"]);
    expect((await fs.lstat(flowPath(rootA, "checkout"))).isSymbolicLink()).toBe(true);
  });

  it("treats a shared symlinked flows DIRECTORY the same way", async () => {
    const vault = await makeRoot("vault-dir");
    const rootA = await makeRoot("symdir-a");
    const rootB = await makeRoot("symdir-b");
    for (const root of [rootA, rootB]) {
      await fs.mkdir(path.join(root, ".argent"), { recursive: true });
      await fs.symlink(vault, path.join(root, ".argent", "flows"));
    }

    await start(rootA, "checkout");
    await addEcho(rootA, "checkout", "a1");
    await addEcho(rootA, "checkout", "a2");

    const restarted = await start(rootB, "checkout");
    expect(restarted.restarted).toBe(true);
    expect(restarted.discardedSteps).toBe(2);

    const err = await captureFailure(addEcho(rootA, "checkout", "a3"));
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_NO_ACTIVE_RECORDING);
  });

  it("treats two case-variant flow names on a case-folding volume as one key", async () => {
    const root = await makeRoot("case-variant");
    await fs.mkdir(path.dirname(flowPath(root, "Login")), { recursive: true });
    if (!(await fsFoldsCase(path.dirname(flowPath(root, "Login"))))) return;

    await start(root, "Login");
    await addEcho(root, "Login", "l1");
    await addEcho(root, "Login", "l2");

    // `login` is a different key by string math, the same file by this volume.
    const restarted = await start(root, "login");
    expect(restarted.restarted).toBe(true);
    expect(restarted.discardedSteps).toBe(2);

    const err = await captureFailure(addEcho(root, "Login", "l3"));
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_NO_ACTIVE_RECORDING);
  });

  it("does not accuse a caller that respelled its own root of destroying a take", async () => {
    // The other half of the guard's ambiguity, and the common one on macOS:
    // `/tmp` is a symlink, so any code path that realpaths a root produces the
    // second spelling. Nothing was truncated, there is no other caller, and the
    // take is live and intact — so the message must say how to resume it rather
    // than sending the agent to re-walk the whole flow on the device.
    const root = await makeRoot("respelled-root");
    const realRoot = await fs.realpath(root);
    if (realRoot === root) return; // no symlinked ancestor on this host

    await start(root, "checkout");
    await addEcho(root, "checkout", "c1");

    const err = await captureFailure(addEcho(realRoot, "checkout", "c2"));
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_NO_ACTIVE_RECORDING);
    // Its own stage, so telemetry can tell an aliased key from a key that was
    // never started — the two share an error code and want different fixes.
    expect(getFailureSignal(err)?.failure_stage).toBe("flow_recording_key_aliased");
    const message = formatErrorForAgent(err);
    expect(message).toContain("re-address it exactly as you passed it to flow-start-recording");
    expect(message).toContain("the take is intact and still recording");
    // The claim that made this a false alarm.
    expect(message).not.toMatch(/truncated this one/);
    expect(message).toContain(root);

    // And the take really is resumable under its registered spelling.
    await addEcho(root, "checkout", "c3");
    expect(await readMarkers(root, "checkout")).toEqual(["echo:c1", "echo:c3"]);
  });

  it("writes THROUGH a dangling vault symlink instead of replacing it", async () => {
    // The shared-vault workflow's normal starting state: the link is created
    // before the first recording, or the vault copy is removed by a branch
    // switch or a `git clean`. `realpath` fails on the whole path there, so the
    // swap used to rename onto the link's own spelling — replacing the symlink
    // with a regular file, never creating the vault target, and permanently
    // detaching the project from the vault while reporting success.
    const vault = await makeRoot("dangling-vault");
    const root = await makeRoot("dangling-proj");
    const target = path.join(vault, "shared.yaml");
    await fs.mkdir(path.dirname(flowPath(root, "shared")), { recursive: true });
    await fs.symlink(target, flowPath(root, "shared"));

    await start(root, "shared");
    await addEcho(root, "shared", "s1");

    expect((await fs.lstat(flowPath(root, "shared"))).isSymbolicLink()).toBe(true);
    expect(markers(parseFlow(await fs.readFile(target, "utf8")).steps)).toEqual(["echo:s1"]);
  });

  it("keys two projects onto one dangling vault target, as one file", async () => {
    // The key follows the same resolution as the write, so two projects linking
    // the same not-yet-created vault file are one recording — matching what the
    // write then produces, rather than two sessions racing onto one output.
    const vault = await makeRoot("dangling-shared-vault");
    const rootA = await makeRoot("dangling-a");
    const rootB = await makeRoot("dangling-b");
    const target = path.join(vault, "checkout.yaml");
    for (const root of [rootA, rootB]) {
      await fs.mkdir(path.dirname(flowPath(root, "checkout")), { recursive: true });
      await fs.symlink(target, flowPath(root, "checkout"));
    }

    await start(rootA, "checkout");
    await addEcho(rootA, "checkout", "a1");

    const restarted = await start(rootB, "checkout");
    expect(restarted.restarted).toBe(true);
    expect(restarted.discardedSteps).toBe(1);
    expect((await fs.lstat(flowPath(rootA, "checkout"))).isSymbolicLink()).toBe(true);
  });

  it("keeps a recording reachable when its vault target is deleted mid-take", async () => {
    // The link is still there and still names the same file, so the recording's
    // identity has not moved — it is only the target that is momentarily
    // absent. Resolving that back to the link's own path made the key move,
    // orphaning the live session behind a generic "no active recording".
    const vault = await makeRoot("deleted-target-vault");
    const root = await makeRoot("deleted-target-proj");
    const target = path.join(vault, "checkout.yaml");
    await fs.mkdir(path.dirname(flowPath(root, "checkout")), { recursive: true });
    await fs.symlink(target, flowPath(root, "checkout"));

    await start(root, "checkout");
    await addEcho(root, "checkout", "c1");
    await fs.rm(target);

    // Still addressable under the spelling it was started with.
    expect((await getRecordingSession(root, "checkout"))?.name).toBe("checkout");

    // The append does fail — its file really is gone — but as the missing file
    // it is, not as a recording that was never started. The distinction is the
    // whole point: the second answer sends the agent to flow-start-recording,
    // which truncates.
    const err = await captureFailure(addEcho(root, "checkout", "c2"));
    expect(getFailureSignal(err)?.error_code).not.toBe(FAILURE_CODES.FLOW_NO_ACTIVE_RECORDING);
    expect((err as Error).message).toMatch(/ENOENT/);

    // And restoring the target resumes the same take.
    await fs.writeFile(target, "steps: []\n", "utf8");
    await addEcho(root, "checkout", "c3");
    const finished = await finish(root, "checkout");
    expect(markers(parseFlow(finished.flowFile).steps)).toEqual(["echo:c3"]);
    expect((await fs.lstat(flowPath(root, "checkout"))).isSymbolicLink()).toBe(true);
    expect(await getRecordingSession(root, "checkout")).toBeUndefined();
  });

  it("keeps two genuinely distinct flows independent", async () => {
    // The control: no symlink, no case variance, so nothing is canonicalized
    // together and the isolation guarantee holds exactly as stated.
    const rootA = await makeRoot("control-a");
    const rootB = await makeRoot("control-b");
    await start(rootA, "checkout");
    await start(rootB, "checkout");
    await addEcho(rootA, "checkout", "a1");
    await addEcho(rootB, "checkout", "b1");
    expect(await readMarkers(rootA, "checkout")).toEqual(["echo:a1"]);
    expect(await readMarkers(rootB, "checkout")).toEqual(["echo:b1"]);
  });
});

// ── Addressing a key that isn't live ─────────────────────────────────

describe("addressing an unknown recording key", () => {
  it("fails with FLOW_NO_ACTIVE_RECORDING and names this project's live recordings", async () => {
    const rootA = await makeRoot("unknown-a");
    const rootB = await makeRoot("unknown-b");
    await start(rootA, "alpha");
    await start(rootB, "beta");

    const err = await captureFailure(addEcho(rootA, "never-started", "x"));

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_NO_ACTIVE_RECORDING);
    const message = (err as Error).message;
    expect(message).toContain('No active recording for flow "never-started"');
    expect(message).toContain(rootA);
    // This project's live keys are named so the agent can self-correct…
    expect(message).toContain('Active recordings: "alpha" (plus 1 in other projects)');
    // …while another caller's flow name and project path stay theirs.
    expect(message).not.toContain('"beta"');
    expect(message).not.toContain(rootB);
  });

  it("fails the same way for the right name under the wrong project_root", async () => {
    const rootA = await makeRoot("wrong-root-a");
    const rootB = await makeRoot("wrong-root-b");
    await start(rootA, "alpha");

    const err = await captureFailure(addStep(rootB, "alpha", "stray"));

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_NO_ACTIVE_RECORDING);
    const message = (err as Error).message;
    expect(message).toContain("Active recordings: none in this project (plus 1 in other projects)");
    expect(message).not.toContain(rootA);

    // The misdirected step was not recorded anywhere.
    expect(await readMarkers(rootA, "alpha")).toEqual([]);
    await expect(fs.stat(flowPath(rootB, "alpha"))).rejects.toThrow();
  });

  it("reports the live recordings as none when nothing is being recorded", async () => {
    const root = await makeRoot("nothing-live");
    const err = await captureFailure(finish(root, "alpha"));
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_NO_ACTIVE_RECORDING);
    // No parenthetical: there is nothing elsewhere to count either.
    expect((err as Error).message).toContain("Active recordings: none in this project.");
  });
});

// ── Concurrent appends to one session ────────────────────────────────

describe("concurrent flow-add-step calls on one recording", () => {
  it("loses no step when several appends are in flight at once", async () => {
    const root = await makeRoot("append-race");
    await start(root, "burst");

    const tags = ["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7"];
    // Fire without awaiting in between: every call is past its live execution
    // and inside the append phase before the first one writes. appendStep is
    // read → await → write, so without the per-file lock these would all
    // read the same file and the last write would drop the others.
    const inflight = tags.map((tag) => addStep(root, "burst", tag));
    await Promise.all(inflight);

    const recorded = await readMarkers(root, "burst");
    expect(recorded).toHaveLength(tags.length);
    expect([...recorded].sort()).toEqual(tags.map((t) => `tool:${t}`).sort());

    // The in-memory copy the session serves to flow-finish-recording agrees.
    expect((await getRecordingSession(root, "burst"))?.flow.steps).toHaveLength(tags.length);
    const finished = await finish(root, "burst");
    expect(finished.steps).toBe(tags.length);
  });

  it("keeps two concurrent bursts on their own files", async () => {
    const root = await makeRoot("append-race-two");
    await start(root, "alpha");
    await start(root, "beta");

    await Promise.all([
      ...["a0", "a1", "a2", "a3"].map((tag) => addStep(root, "alpha", tag)),
      ...["b0", "b1", "b2", "b3"].map((tag) => addStep(root, "beta", tag)),
    ]);

    expect([...(await readMarkers(root, "alpha"))].sort()).toEqual([
      "tool:a0",
      "tool:a1",
      "tool:a2",
      "tool:a3",
    ]);
    expect([...(await readMarkers(root, "beta"))].sort()).toEqual([
      "tool:b0",
      "tool:b1",
      "tool:b2",
      "tool:b3",
    ]);
  });
});

// ── The lock is per flow file, not one global mutex ──────────────────

describe("the flow-file lock", () => {
  it("lets one recording append while another recording's file is locked", async () => {
    const root = await makeRoot("per-file-lock");
    await start(root, "alpha");
    await start(root, "beta");

    // Hold alpha's file lock — this is exactly the state an alpha append is in
    // while it is mid read-modify-write. Whether beta can make progress *during*
    // that window is the property under test: a single global lock passes any
    // assertion about final file contents, and fails this one.
    const order: string[] = [];
    const alphaLock = openGate();
    const alphaHeld = withFlowFileLock(root, "alpha", () => alphaLock.promise);

    // A second append to alpha must queue behind the holder…
    const alphaAppend = addStep(root, "alpha", "a1").then((r) => {
      order.push("alpha-appended");
      return r;
    });
    const betaAppend = addStep(root, "beta", "b1").then((r) => {
      order.push("beta-appended");
      return r;
    });

    // …while beta's append, on a different file, runs to completion inside it.
    expect(await within(betaAppend, "beta-appended")).toBe("beta-appended");
    await settle();
    expect(order).toEqual(["beta-appended"]);
    expect(await readMarkers(root, "beta")).toEqual(["tool:b1"]);
    expect(await readMarkers(root, "alpha")).toEqual([]);

    order.push("alpha-lock-released");
    alphaLock.open();
    await alphaHeld;
    expect(await within(alphaAppend, "alpha-appended")).toBe("alpha-appended");

    // beta finished strictly inside alpha's critical section — real overlap,
    // not a serialization that happened to be fast.
    expect(order).toEqual(["beta-appended", "alpha-lock-released", "alpha-appended"]);
    expect(await readMarkers(root, "alpha")).toEqual(["tool:a1"]);
    expect(await readMarkers(root, "beta")).toEqual(["tool:b1"]);
  });

  it("still excludes a third acquirer after the first one has released", async () => {
    const root = await makeRoot("lock-three-deep");

    // Three acquirers on ONE key, which is where the lock map's self-cleanup
    // has to be careful: the entry may only be dropped by the holder that is
    // still the tail. Deleting it unconditionally looks harmless — every
    // two-party test still passes — but once A finishes while B is holding, the
    // key is gone from the map, so C finds no predecessor to queue behind and
    // runs *concurrently with B*. That is the lost update this lock exists to
    // prevent, so pin three-deep contention explicitly.
    const order: string[] = [];
    const gateA = openGate();
    const gateB = openGate();

    const heldA = withFlowFileLock(root, "alpha", async () => {
      order.push("a-enter");
      await gateA.promise;
      order.push("a-exit");
    });
    const heldB = withFlowFileLock(root, "alpha", async () => {
      order.push("b-enter");
      await gateB.promise;
      order.push("b-exit");
    });

    // A is holding, B is queued. Release A so B takes the lock and A's cleanup
    // runs while B is still inside its critical section.
    gateA.open();
    await heldA;
    await settle();
    expect(order).toEqual(["a-enter", "a-exit", "b-enter"]);

    // C arrives now — after A's cleanup, while B holds.
    const heldC = withFlowFileLock(root, "alpha", async () => {
      order.push("c-enter");
    });
    expect(await within(heldC, "c-done", 200)).toBe("timed-out");
    expect(order).toEqual(["a-enter", "a-exit", "b-enter"]);

    gateB.open();
    await heldB;
    await heldC;
    expect(order).toEqual(["a-enter", "a-exit", "b-enter", "b-exit", "c-enter"]);
  });

  it("drops the lock entry once released, so the map does not grow per flow ever recorded", async () => {
    // The other half of the self-cleanup. The test above pins the CONDITION
    // (only the tail may delete); this pins that the delete happens at all.
    // Nothing else can observe it — a retained entry is functionally identical
    // to a released one for every caller — so without this the whole
    // `void held.then(...)` block can be deleted with the suite still green,
    // and a long-lived server accumulates one permanent entry per flow anyone
    // using that argent install ever recorded.
    const root = await makeRoot("lock-cleanup");
    const before = __flowFileLockCountForTesting();

    for (const name of ["alpha", "beta", "gamma"]) {
      await start(root, name);
      await addEcho(root, name, "one");
      await finish(root, name);
    }
    expect(__flowFileLockCountForTesting()).toBe(before);

    // And while a lock is genuinely held, the entry IS there — so the
    // assertion above is about release, not about the map never being used.
    const gate = openGate();
    const held = withFlowFileLock(root, "alpha", () => gate.promise);
    // `settle` first: the lock is taken on the CANONICAL key, so the entry
    // appears only once that resolution has come back from the filesystem.
    await settle();
    expect(__flowFileLockCountForTesting()).toBe(before + 1);
    gate.open();
    await held;
    await settle();
    expect(__flowFileLockCountForTesting()).toBe(before);
  });
});

// ── What a READER of the flow file can observe ───────────────────────

describe("flow-file writes as seen by a concurrent reader", () => {
  // The lock serializes writers, but no reader of a flow YAML joins it —
  // `flow-execute`'s own load, its `run:` fragment load, flow-read-prerequisite,
  // flow-add-step's sibling-fragment check, and the `argent` CLI reading from
  // another process, where an in-process lock cannot reach at all. A plain
  // `fs.writeFile` opens O_TRUNC, so such a reader could observe the file empty
  // or half-written — and `parseFlow("")` returns `{ steps: [] }` with no error,
  // which `flow-execute` summarizes as a top-level PASS over zero steps. So the
  // writes must be atomic swaps rather than in-place truncations.

  /** The file's identity on disk. A rename replaces it; a truncate does not. */
  async function inode(root: string, name: string): Promise<number> {
    return (await fs.stat(flowPath(root, name))).ino;
  }

  /** Anything the writer left behind next to the flow file. */
  async function strayFiles(root: string, name: string): Promise<string[]> {
    const entries = await fs.readdir(path.dirname(flowPath(root, name)));
    return entries.filter((entry) => entry !== `${name}.yaml`);
  }

  it("replaces the file on append instead of truncating it in place", async () => {
    const root = await makeRoot("append-atomic");
    await start(root, "alpha");
    const before = await inode(root, "alpha");

    await addStep(root, "alpha", "a1");
    const after = await inode(root, "alpha");

    // Different inode == the reader either had the old file open (still whole)
    // or opens the new one (whole). There is no window where the path resolves
    // to a zero-length file.
    expect(after).not.toBe(before);
    expect(await readMarkers(root, "alpha")).toEqual(["tool:a1"]);
  });

  it("replaces the file on start, so a reset is never observable as a partial file", async () => {
    const root = await makeRoot("start-atomic");
    await start(root, "alpha");
    await addStep(root, "alpha", "a1");
    const before = await inode(root, "alpha");

    // A restart truncates to an empty flow — the write most likely to be caught
    // mid-flight, since it is what a concurrent flow-execute would read as a
    // green run over zero steps.
    await start(root, "alpha");
    expect(await inode(root, "alpha")).not.toBe(before);
    expect(await readMarkers(root, "alpha")).toEqual([]);
  });

  it("leaves no scratch file behind in the flows directory", async () => {
    // The swap writes a sibling temp file first. `argent flow list` enumerates
    // this directory and filters on `.yaml`, so a stray `.tmp` never surfaces
    // as a flow — but that agreement only hides a leftover, it does not stop
    // one accumulating per append.
    const root = await makeRoot("no-scratch");
    await start(root, "alpha");
    expect(await strayFiles(root, "alpha")).toEqual([]);

    await addStep(root, "alpha", "a1");
    await addEcho(root, "alpha", "note");
    await addStep(root, "alpha", "a2");

    expect(await strayFiles(root, "alpha")).toEqual([]);
    expect(await readMarkers(root, "alpha")).toEqual(["tool:a1", "echo:note", "tool:a2"]);
  });

  it("renames the scratch file from beside the target, never from a shared temp dir", async () => {
    // "leaves no scratch file behind" (above) only proves the .tmp is gone by
    // the time the call returns — a scratch file built under `os.tmpdir()`
    // instead of the flow's own directory satisfies that identically, since it
    // was never IN the flows directory to begin with. What actually keeps the
    // swap atomic is `fs.rename` staying on ONE filesystem, which only holds
    // because the scratch path is a sibling of the target — so pin THAT
    // property directly, on the arguments the real rename call is made with,
    // rather than on a side effect two different implementations both produce.
    //
    // This does not depend on the test root's filesystem: `flowsDir` here is
    // always a subdirectory of whatever `os.tmpdir()` returns (`makeRoot`
    // mkdtemps under it), never equal to it, so relocating the scratch file to
    // `os.tmpdir()` itself is caught by the directory comparison below on any
    // host, without ever needing two real filesystems to reproduce EXDEV.
    const root = await makeRoot("scratch-sibling");
    vi.mocked(fs.rename).mockClear();

    await start(root, "alpha"); // writeNewFlowFile → writeFlowFile → 1 rename
    await addStep(root, "alpha", "a1"); // appendStep → writeFlowFile → 1 rename
    await addEcho(root, "alpha", "a2"); // appendStep → writeFlowFile → 1 rename

    // Canonical, because the writer swaps onto the flow file's REAL path so a
    // symlinked flow keeps its link (see writeFlowFile). The directory that
    // must hold the scratch file is therefore the resolved one — still a strict
    // subdirectory of the temp root, so the os.tmpdir() relocation this case
    // exists to catch is caught exactly as before.
    const flowsDir = await fs.realpath(path.dirname(flowPath(root, "alpha")));
    const renameCalls = vi.mocked(fs.rename).mock.calls;
    expect(renameCalls).toHaveLength(3);
    for (const [from, to] of renameCalls) {
      // The rename target is always the flow file itself…
      expect(path.dirname(String(to))).toBe(flowsDir);
      // …and the scratch source must sit right next to it. If it didn't, this
      // same rename would cross filesystems in production (project root vs.
      // OS temp dir) and fail with EXDEV instead of swapping atomically.
      expect(path.dirname(String(from))).toBe(flowsDir);
    }
  });

  it("still appends under a flow name long enough to fill the filesystem's limit", async () => {
    // A flow name has no length cap — FLOW_NAME_PATTERN constrains the
    // character set only — so `<name>.yaml` can legitimately reach NAME_MAX
    // (255 on APFS/ext4). A scratch name derived from the flow file's basename
    // would overflow that and fail an append that used to work, so the temp
    // name must be a fixed-length one.
    const root = await makeRoot("long-name");
    const name = "a".repeat(250);
    expect(`${name}.yaml`.length).toBe(255);

    await start(root, name);
    await addStep(root, name, "a1");
    await addEcho(root, name, "note");

    expect(await readMarkers(root, name)).toEqual(["tool:a1", "echo:note"]);
    expect(await strayFiles(root, name)).toEqual([]);
  });

  it("propagates a failed swap and leaves no scratch file behind", async () => {
    // The only coverage the cleanup branch has otherwise is the success path,
    // where the rename itself consumes the temp file — so deleting the whole
    // try/catch passes. Force the rename to fail by planting a NON-EMPTY
    // DIRECTORY where the flow file goes: `mkdir -p` on the parent still
    // succeeds and the temp write still succeeds, so this reaches `fs.rename`
    // and nothing else. (A read-only dir fails earlier, at the temp write.)
    const root = await makeRoot("swap-fails");
    const target = flowPath(root, "alpha");
    await fs.mkdir(path.join(target, "occupied"), { recursive: true });

    await expect(start(root, "alpha")).rejects.toThrow();

    // The failure must not leave a scratch file in the user's committed
    // .argent/flows/ — nothing else ever sweeps it.
    const entries = await fs.readdir(path.dirname(target));
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
    // And it must not register a session for a file that was never written:
    // the next append would otherwise die on an unrelated ENOENT.
    expect(listActiveRecordings()).toEqual([]);
  });

  it("cleans up the scratch file and names the flow when the WRITE half fails", async () => {
    // The "failed swap" case above reaches only `fs.rename`; a read-only dir
    // fails even earlier, at the temp open, before a file exists. Neither
    // exercises the other live trigger the cleanup exists for: the write itself
    // failing (ENOSPC / EIO) with the scratch file ALREADY created. Force
    // exactly that — write the real temp file, then throw — and assert both that
    // the scratch file is swept and that the surfaced error names the flow file
    // rather than the internal `.argent-flow-*.tmp` path (which is gone by then).
    const root = await makeRoot("write-fails");
    const target = flowPath(root, "alpha");
    await fs.mkdir(path.dirname(target), { recursive: true });

    const realWriteFile = fs.writeFile;
    const spy = vi.spyOn(fs, "writeFile").mockImplementationOnce(async (p, data, opts) => {
      await realWriteFile(p as Parameters<typeof realWriteFile>[0], data as string, opts as never);
      const err: NodeJS.ErrnoException = new Error(
        `ENOSPC: no space left on device, write ${String(p)}`
      );
      err.code = "ENOSPC";
      throw err;
    });

    const err = await start(root, "alpha").catch((e: unknown) => e);
    spy.mockRestore();

    expect(err).toBeInstanceOf(Error);
    // Against the string an agent actually READS, not `err.message`:
    // `formatErrorForAgent` appends the cause chain, so asserting on the
    // message alone passed while the rendered text still named the scratch
    // file. The invariant is about what is disclosed, so assert on what is.
    const message = formatErrorForAgent(err);
    expect(message).toContain(target);
    expect(message).not.toMatch(/\.argent-flow-\d+-\d+\.tmp/);
    // The errno itself is worth keeping — only the phantom path is not.
    expect(message).toContain("ENOSPC");
    expect(message).toContain("out of space");
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_FILE_WRITE_FAILED);

    // The half-written scratch file must not survive in the committed flows dir.
    const entries = await fs.readdir(path.dirname(target));
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
    expect(listActiveRecordings()).toEqual([]);
  });

  it("blames the LINK TARGET's directory when a symlinked flow cannot be written", async () => {
    // A 0755 flows dir holding a link into a 0555 vault. The hint used
    // `dirname(filePath)` while the temp file and rename use
    // `dirname(realpath(filePath))`, so it named a directory that already IS
    // writable and never mentioned the vault — the only unwritable thing.
    const vault = await makeRoot("hint-vault");
    const root = await makeRoot("hint-proj");
    const shared = path.join(vault, "f.yaml");
    const link = flowPath(root, "f");
    await fs.writeFile(shared, "steps: []\n", "utf8");
    await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.symlink(shared, link);
    await start(root, "f");
    await fs.chmod(vault, 0o555);
    try {
      const err = await addEcho(root, "f", "note").catch((e: unknown) => e);

      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_FILE_WRITE_FAILED);
      const message = formatErrorForAgent(err);
      // The real directory is named…
      expect(message).toContain(await fs.realpath(vault));
      // …and the reader is told why it is not the one they expected.
      expect(message).toContain("is a symlink");
      expect(message).toMatch(/must be writable/);
    } finally {
      await fs.chmod(vault, 0o755);
    }
  });

  it("classifies a project_root that is a FILE as a flow write failure, not a registry one", async () => {
    // The tool description promises it "fails if the .argent/flows/ directory
    // cannot be created OR the flow file cannot be written". With the mkdir
    // outside the wrapping only the second half kept that promise: this
    // surfaced as a bare ENOTDIR under REGISTRY_TOOL_EXECUTION_FAILED, with no
    // remediation hint, and telemetry blaming the registry for a flow failure.
    const root = await makeRoot("root-is-a-file");
    const notADir = path.join(root, "notadir");
    await fs.writeFile(notADir, "x", "utf8");

    const err = await start(notADir, "alpha").catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_FILE_WRITE_FAILED);
    expect(getFailureSignal(err)?.failure_stage).toBe("flow_dir_create");
    const message = formatErrorForAgent(err);
    expect(message).toContain(path.join(notADir, ".argent", "flows"));
    expect(message).toContain("project_root");
    // The kernel's own errno is worth keeping.
    expect(message).toContain("ENOTDIR");
  });

  it("classifies an unwritable project_root the same way", async () => {
    const root = await makeRoot("root-unwritable");
    const proj = path.join(root, "proj");
    await fs.mkdir(proj);
    await fs.chmod(proj, 0o555);
    try {
      const err = await start(proj, "alpha").catch((e: unknown) => e);
      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_FILE_WRITE_FAILED);
      expect(getFailureSignal(err)?.failure_stage).toBe("flow_dir_create");
      expect(formatErrorForAgent(err)).toMatch(/not writable/);
    } finally {
      await fs.chmod(proj, 0o755);
    }
  });

  it("names only the flow file when a read-only flows dir fails an append", async () => {
    // The review's own repro: chmod 500 the flows dir, then append to a live
    // recording. This fails at the temp OPEN — earlier than either case above —
    // and the errno names a scratch file that has never existed on disk.
    const root = await makeRoot("readonly-dir");
    const target = flowPath(root, "alpha");
    await start(root, "alpha");
    const flowsDir = path.dirname(target);
    await fs.chmod(flowsDir, 0o500);
    try {
      const err = await addEcho(root, "alpha", "note").catch((e: unknown) => e);

      const message = formatErrorForAgent(err);
      expect(message).toContain(target);
      expect(message).not.toMatch(/\.argent-flow-\d+-\d+\.tmp/);
      // Here the directory-permission explanation IS the right one.
      expect(message).toContain("must be writable");
    } finally {
      await fs.chmod(flowsDir, 0o700);
    }
  });

  it("explains the errno it actually got, not directory permissions every time", async () => {
    // "so <dir> must be writable" used to be appended to every failure. An
    // over-long flow name fails in `rename` with ENAMETOOLONG — a writable
    // directory does not help, and sending someone to check permissions on one
    // they will find perfectly writable is a wrong lead, not a vague one.
    const root = await makeRoot("nametoolong");
    const target = flowPath(root, "alpha");
    await fs.mkdir(path.dirname(target), { recursive: true });

    const realRename = fs.rename;
    const spy = vi.spyOn(fs, "rename").mockImplementationOnce(async () => {
      const err: NodeJS.ErrnoException = new Error(
        `ENAMETOOLONG: name too long, rename '${target}'`
      );
      err.code = "ENAMETOOLONG";
      throw err;
    });
    const err = await start(root, "alpha").catch((e: unknown) => e);
    spy.mockRestore();
    void realRename;

    const message = formatErrorForAgent(err);
    expect(message).toContain("ENAMETOOLONG");
    expect(message).toContain("use a shorter name");
    expect(message).not.toContain("must be writable");
  });

  it("never exposes an empty or unparseable file while appends are in flight", async () => {
    // The property the two inode assertions above encode, observed the way a
    // reader actually experiences it: poll the path as fast as the event loop
    // allows across a run of appends, and require every single observation to
    // be a complete, parseable flow. Against an in-place `fs.writeFile` this
    // catches zero-length reads.
    const root = await makeRoot("reader-race");
    await start(root, "alpha");

    let polling = true;
    const observed: number[] = [];
    let torn: string | undefined;
    const reader = (async () => {
      while (polling) {
        try {
          const raw = await fs.readFile(flowPath(root, "alpha"), "utf8");
          observed.push(parseFlow(raw).steps.length);
        } catch (err) {
          // ENOENT is equally a failure here: the path must resolve to a
          // complete file at every instant, never to a gap.
          torn = `${(err as Error).message} — content boundary observed`;
          break;
        }
      }
    })();

    for (let i = 0; i < 40; i++) await addStep(root, "alpha", `a${i}`);
    polling = false;
    await reader;

    expect(torn).toBeUndefined();
    // The reader has to have actually looked, or it proves nothing.
    expect(observed.length).toBeGreaterThan(0);
    // Step counts only ever grow: no observation caught a reset-to-empty file.
    expect(observed).toEqual([...observed].sort((a, b) => a - b));
    expect((await readSteps(root, "alpha")).length).toBe(40);
  });
});

// ── The append path's source of truth ────────────────────────────────

describe("appending to a recording whose file was hand-edited", () => {
  it("re-reads the file, so an edit made mid-recording survives the next append", async () => {
    const root = await makeRoot("append-rereads");
    await start(root, "alpha");
    await addEcho(root, "alpha", "s1");
    await addEcho(root, "alpha", "s2");
    expect(await readMarkers(root, "alpha")).toEqual(["echo:s1", "echo:s2"]);

    // Removing a bad step by editing the .yaml is what both recording tools'
    // descriptions tell the agent to do after the finish, not during. It only
    // survives because the host-mode append re-reads from disk. Serializing the
    // in-memory copy would resurrect the deleted step on the next append.
    await fs.writeFile(
      flowPath(root, "alpha"),
      'executionPrerequisite: ""\nsteps:\n  - echo: s2\n',
      "utf8"
    );

    const third = await addEcho(root, "alpha", "s3");
    expect(await readMarkers(root, "alpha")).toEqual(["echo:s2", "echo:s3"]);
    // The count is the FILE's length, not this session's tally of appends —
    // the only place the two can diverge, and the one surface where the number
    // is not merely informational: it is what `recorded` numbers the author's
    // per-step view with. A session-local counter would say "3." for what is
    // line 2 of their file, and every other stepCount assertion in the suite
    // appends without editing, so appends == file length in all of them.
    expect(third.stepCount).toBe(2);

    // …and the finish reports the file, not the take as it was recorded.
    const finished = await finish(root, "alpha");
    expect(markers(parseFlow(finished.flowFile).steps)).toEqual(["echo:s2", "echo:s3"]);
  });
});

// ── Replaying a flow while recordings are live ───────────────────────

describe("running a flow in a third project while two recordings are live", () => {
  it("rebinds neither recording's file path", async () => {
    const rootA = await makeRoot("exec-a");
    const rootB = await makeRoot("exec-b");
    const rootC = await makeRoot("exec-c");

    await start(rootA, "alpha");
    await start(rootB, "beta");
    await addStep(rootA, "alpha", "a1");
    await addEcho(rootB, "beta", "b1");

    // A saved flow belonging to a third project, replayed mid-recording.
    await writeSavedFlow(rootC, "standalone", {
      executionPrerequisite: "App on the home screen",
      steps: [{ kind: "echo", message: "replayed" }],
    });

    const prereq = await flowReadPrerequisiteTool.execute(
      {},
      { name: "standalone", project_root: rootC }
    );
    expect(prereq.executionPrerequisite).toBe("App on the home screen");

    const runResult = await createRunFlowTool(registry).execute(
      {},
      {
        name: "standalone",
        project_root: rootC,
        device: IOS_DEVICE,
        prerequisiteAcknowledged: true,
      }
    );
    expect(runResult).toHaveProperty("ok", true);

    // Both sessions still point at their own files…
    expect((await getRecordingSession(rootA, "alpha"))?.filePath).toBe(flowPath(rootA, "alpha"));
    expect((await getRecordingSession(rootB, "beta"))?.filePath).toBe(flowPath(rootB, "beta"));

    // …and subsequent steps still land there.
    await addStep(rootA, "alpha", "a2");
    await addEcho(rootB, "beta", "b2");
    expect(await readMarkers(rootA, "alpha")).toEqual(["tool:a1", "tool:a2"]);
    expect(await readMarkers(rootB, "beta")).toEqual(["echo:b1", "echo:b2"]);

    // Nothing was written into the replayed project, and the replayed flow
    // did not pick up either recording's steps.
    await expect(fs.stat(flowPath(rootC, "alpha"))).rejects.toThrow();
    expect(await readMarkers(rootC, "standalone")).toEqual(["echo:replayed"]);
  });
});

// ── Restarting one recording ─────────────────────────────────────────

describe("restarting a recording on one key", () => {
  it("resets only that flow and leaves a concurrent recording untouched", async () => {
    const root = await makeRoot("restart");

    await start(root, "alpha");
    await addStep(root, "alpha", "a1");
    await addStep(root, "alpha", "a2");

    const startedBeta = await start(root, "beta");
    // Starting a DIFFERENT key abandons nothing — nothing to report.
    expect(startedBeta.restarted).toBeUndefined();
    expect(startedBeta.discardedSteps).toBeUndefined();
    await addEcho(root, "beta", "b1");

    const restarted = await start(root, "alpha");
    expect(restarted.restarted).toBe(true);
    expect(restarted.discardedSteps).toBe(2);
    expect(restarted.message).toContain("alpha");
    expect(await readMarkers(root, "alpha")).toEqual([]);

    // beta neither lost its steps nor its session.
    expect(await readMarkers(root, "beta")).toEqual(["echo:b1"]);
    expect((await getRecordingSession(root, "beta"))?.flow.steps).toHaveLength(1);
    await addEcho(root, "beta", "b2");
    expect(await readMarkers(root, "beta")).toEqual(["echo:b1", "echo:b2"]);

    // The restarted take records into the reset file.
    await addStep(root, "alpha", "a3");
    expect(await readMarkers(root, "alpha")).toEqual(["tool:a3"]);
  });

  it("restarts this project's take and leaves the same name elsewhere alone", async () => {
    const rootA = await makeRoot("restart-a");
    const rootB = await makeRoot("restart-b");

    await start(rootA, "alpha");
    await addStep(rootA, "alpha", "a1");
    await start(rootB, "alpha");
    await addStep(rootB, "alpha", "b1");

    // Same name AND same root ⇒ the same key ⇒ this take is restarted…
    const restarted = await start(rootB, "alpha");
    expect(restarted.restarted).toBe(true);
    expect(restarted.discardedSteps).toBe(1);
    expect(await readMarkers(rootB, "alpha")).toEqual([]);

    // …while the same name under the other root — a different key — is not
    // touched: that recording kept its step and its session.
    expect(await readMarkers(rootA, "alpha")).toEqual(["tool:a1"]);
    expect((await getRecordingSession(rootA, "alpha"))?.flow.steps).toHaveLength(1);
  });

  it("counts the steps the FILE held, not the ones this session appended", async () => {
    // A mid-recording hand edit is advised against and not prevented, and in
    // host mode the file is the take: every other host-mode operation re-reads
    // it, and the in-memory copy only catches up on the next append. The
    // restart is the one destructive operation, so counting from memory would
    // report a fraction of what it just wiped.
    const root = await makeRoot("restart-handedit");

    await start(root, "alpha");
    await addEcho(root, "alpha", "a1");

    await fs.writeFile(
      flowPath(root, "alpha"),
      serializeFlow({
        executionPrerequisite: "",
        steps: [
          { kind: "echo", message: "a1" },
          { kind: "echo", message: "by-hand-2" },
          { kind: "echo", message: "by-hand-3" },
          { kind: "echo", message: "by-hand-4" },
        ],
      }),
      "utf8"
    );

    const restarted = await start(root, "alpha");
    expect(restarted.restarted).toBe(true);
    expect(restarted.discardedSteps).toBe(4);
    expect(restarted.message).toContain("(4 steps)");
    expect(await readMarkers(root, "alpha")).toEqual([]);
  });

  it("reports no count at all when the file it discarded could not be parsed", async () => {
    // A hand-edit can also leave YAML `parseFlow` rejects. There is no honest
    // number then — and 0 is the least honest of all, since it is the answer a
    // genuinely empty take gives. `restarted` alone says the take is gone.
    const root = await makeRoot("restart-unparseable");

    await start(root, "alpha");
    await addEcho(root, "alpha", "a1");
    await fs.writeFile(flowPath(root, "alpha"), "steps: [ this: is: not: a: flow\n", "utf8");

    const restarted = await start(root, "alpha");
    expect(restarted.restarted).toBe(true);
    expect(restarted).not.toHaveProperty("discardedSteps");
    expect(restarted.message).not.toMatch(/\d+ steps?\)/);
    expect(restarted.message).toContain("the previous take was discarded");
    // The reset still happened — the unreadable take is gone either way.
    expect(await readMarkers(root, "alpha")).toEqual([]);
  });
});

// ── A restart landing on top of an in-flight append ──────────────────

describe("a restart that lands while a step is still running", () => {
  it("rejects the in-flight step instead of writing it into the new take", async () => {
    const root = await makeRoot("restart-inflight");
    await start(root, "alpha");
    await addStep(root, "alpha", "a1");

    // The step resolves its session, then parks in its LIVE execution.
    const gate = gateNextSubTool();
    const appending = addStep(root, "alpha", "a2");
    await gate.reached;

    // The take that step belongs to is discarded while it is still running.
    const restarted = await start(root, "alpha");
    expect(restarted.restarted).toBe(true);
    expect(restarted.discardedSteps).toBe(1);

    gate.release();
    const err = await captureFailure(appending);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_NO_ACTIVE_RECORDING);
    expect(getFailureSignal(err)?.failure_stage).toBe("flow_session_superseded");
    expect((err as Error).message).toContain("restarted while this step was running");
    expect((err as Error).message).toContain("Nothing was added to the flow file");
    // The recovery advice must not send the agent back to flow-start-recording:
    // it truncates, so on this branch it would wipe the live take that just took
    // the key (and take it back again). A fresh name is the only safe recovery.
    expect((err as Error).message).toContain("fresh name");
    expect((err as Error).message).not.toMatch(/Call flow-start-recording/);
    // This is the branch where a foreign take really does hold the key, so the
    // message says so — the empty-key branches must not (see the finish and
    // eviction cases).
    expect((err as Error).message).toContain("belongs to another take");
    // The step already ran live before the append was rejected, so an agent that
    // simply retries it would repeat the device action.
    expect((err as Error).message).toContain("already ran on the device");

    // The new take is empty — no step from the discarded one leaked into it.
    expect(await readMarkers(root, "alpha")).toEqual([]);
    expect((await getRecordingSession(root, "alpha"))?.flow.steps).toHaveLength(0);

    // …and the restarted recording still works.
    await addStep(root, "alpha", "a3");
    expect(await readMarkers(root, "alpha")).toEqual(["tool:a3"]);
    const finished = await finish(root, "alpha");
    expect(finished.steps).toBe(1);
  });

  it("rejects a superseded step that records NOTHING, rather than counting another take", async () => {
    const root = await makeRoot("supersede-refusal");
    await start(root, "alpha");
    await addStep(root, "alpha", "a1");

    const gate = gateNextSubTool();
    const refusing = addRawStep(root, "alpha", "run-sequence", {
      udid: "ABC",
      steps: [
        { tool: "keyboard", args: { text: "x" } },
        { tool: "keyboard", args: { text: "y" } },
      ],
    });
    await gate.reached;

    const restarted = await start(root, "alpha");
    expect(restarted.restarted).toBe(true);

    gate.release();
    const err = await captureFailure(refusing);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_NO_ACTIVE_RECORDING);
    expect((err as Error).message).toContain("restarted while this step was running");
    expect((err as Error).message).toContain("already ran on the device");
    expect(await readMarkers(root, "alpha")).toEqual([]);
  });

  it("does not warn a superseded refusal that provably executed nothing", async () => {
    const root = await makeRoot("supersede-notice");
    await start(root, "alpha");
    await addStep(root, "alpha", "a1");

    const gate = gateNextSubTool();
    const refusing = addRawStep(root, "alpha", "flow-execute", {
      name: "needs-prereq",
      project_root: root,
      device: "ABC",
    });
    await gate.reached;

    const restarted = await start(root, "alpha");
    expect(restarted.restarted).toBe(true);

    gate.release();
    const err = await captureFailure(refusing);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_NO_ACTIVE_RECORDING);
    expect((err as Error).message).toContain("restarted while this step was running");
    expect((err as Error).message).toContain("Nothing was added to the flow file");
    expect((err as Error).message).not.toContain("already ran on the device");
    expect(await readMarkers(root, "alpha")).toEqual([]);
  });

  it("does not warn a superseded refusal whose sequence never dispatched a step", async () => {
    const root = await makeRoot("supersede-rejected");
    await start(root, "alpha");
    await addStep(root, "alpha", "a1");

    const gate = gateNextSubTool();
    const refusing = addRawStep(root, "alpha", "run-sequence", {
      udid: "ABC",
      steps: [
        { tool: "screenshot", args: {} },
        { tool: "gesture-tap", args: { x: 0.5, y: 0.5 } },
      ],
    });
    await gate.reached;

    const restarted = await start(root, "alpha");
    expect(restarted.restarted).toBe(true);

    gate.release();
    const err = await captureFailure(refusing);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_NO_ACTIVE_RECORDING);
    expect((err as Error).message).toContain("restarted while this step was running");
    expect((err as Error).message).toContain("Nothing was added to the flow file");
    expect((err as Error).message).not.toContain("already ran on the device");
    expect(await readMarkers(root, "alpha")).toEqual([]);
  });

  it("does not warn a superseded GUIDANCE return that it already ran on the device", async () => {
    const root = await makeRoot("supersede-guidance");
    await start(root, "alpha");

    const gate = openGate();
    const held = withFlowFileLock(root, "alpha", () => gate.promise);
    const restarting = start(root, "alpha");
    const guiding = addRawStep(root, "alpha", "flow-add-step", { udid: "ABC" });

    gate.open();
    await held;
    expect((await restarting).restarted).toBe(true);

    const err = await captureFailure(guiding);
    expect(getFailureSignal(err)?.failure_stage).toBe("flow_session_superseded");
    expect((err as Error).message).toContain("Nothing was added to the flow file");
    expect((err as Error).message).not.toContain("already ran on the device");
  });

  it("does not warn a superseded ECHO that it already ran on the device", async () => {
    // The "repeating it repeats that action" caveat is true of a tool step,
    // which executed live before the append was rejected. An echo is a label —
    // it touched no device, so telling its author to weigh a repeat is the same
    // class of false advice the fresh-name wording replaced. Only the tool
    // branch of that ternary is asserted above, so pin the echo branch here.
    const root = await makeRoot("supersede-echo");
    await start(root, "alpha");

    // An echo has no live device step to park in, so the only window in which
    // it can be superseded is the flow-file lock. Hold the lock, then queue the
    // restart AHEAD of the echo: the echo still resolves its session now (the
    // restart's body has not run, so the old session is still registered), but
    // by the time it reaches the front of the queue the restart has replaced it.
    const gate = openGate();
    const held = withFlowFileLock(root, "alpha", () => gate.promise);
    const restarting = start(root, "alpha");
    const echoing = addEcho(root, "alpha", "a label");

    gate.open();
    await held;
    expect((await restarting).restarted).toBe(true);

    const err = await captureFailure(echoing);
    expect(getFailureSignal(err)?.failure_stage).toBe("flow_session_superseded");
    expect((err as Error).message).toContain("Nothing was added to the flow file");
    expect((err as Error).message).toContain("fresh name");
    expect((err as Error).message).not.toContain("already ran on the device");
  });

  it("reads a refusal's step count only once the flow's lock is free", async () => {
    const root = await makeRoot("refusal-lock");
    await start(root, "alpha");
    await addStep(root, "alpha", "a1");

    const lock = openGate();
    const held = withFlowFileLock(root, "alpha", () => lock.promise);

    const order: string[] = [];
    const refusing = addRawStep(root, "alpha", "run-sequence", {
      udid: "ABC",
      steps: [
        { tool: "keyboard", args: { text: "x" } },
        { tool: "keyboard", args: { text: "y" } },
      ],
    }).then((r) => {
      order.push("refusal-returned");
      return r;
    });

    await settle();
    expect(order).toEqual([]);

    const restarting = start(root, "alpha");

    order.push("lock-released");
    lock.open();
    await held;

    const result = await refusing;
    expect(order).toEqual(["lock-released", "refusal-returned"]);
    expect(result.stepCount).toBe(1);
    expect(result.recorded).toBeUndefined();
    expect((await restarting).discardedSteps).toBe(1);
  });

  it("truncates and re-registers only once the flow's lock is free", async () => {
    const root = await makeRoot("restart-lock");
    await start(root, "alpha");
    await addStep(root, "alpha", "a1");
    const firstSession = await getRecordingSession(root, "alpha");

    // Stand in for an append that is mid read-modify-write on alpha's file.
    const order: string[] = [];
    const lock = openGate();
    const held = withFlowFileLock(root, "alpha", () => lock.promise);

    const restarting = start(root, "alpha").then((r) => {
      order.push("restart-returned");
      return r;
    });

    await settle();
    // The restart is a truncate AND a session swap; neither half may happen
    // while another writer holds the file.
    expect(order).toEqual([]);
    expect(await readMarkers(root, "alpha")).toEqual(["tool:a1"]);
    expect(await getRecordingSession(root, "alpha")).toBe(firstSession);

    order.push("lock-released");
    lock.open();
    await held;
    const restarted = await restarting;

    expect(order).toEqual(["lock-released", "restart-returned"]);
    expect(restarted.restarted).toBe(true);
    expect(restarted.discardedSteps).toBe(1);
    expect(await readMarkers(root, "alpha")).toEqual([]);
    expect(await getRecordingSession(root, "alpha")).not.toBe(firstSession);
  });

  it("keeps a step queued behind the restart out of the new take", async () => {
    const root = await makeRoot("restart-queued-append");
    await start(root, "alpha");
    await addStep(root, "alpha", "a1");
    const discarded = await getRecordingSession(root, "alpha");

    // Park a holder on alpha's file lock. Everything issued below queues behind
    // it, so the interleaving is fixed by the lock's arrival order rather than
    // by how long any I/O happens to take.
    const holder = openGate();
    const held = withFlowFileLock(root, "alpha", () => holder.promise);

    // Second in the queue: the restart — truncate the file, swap the session.
    const restarting = start(root, "alpha");
    // Third: a step for the take the restart is discarding. Both calls resolve
    // the same spelled path, so they share one in-flight key resolution and
    // join the lock queue in the order issued (see `keyResolutions`) — this
    // append is bound to the OLD session and enters the lock the instant the
    // restart's critical section ends, which is the window a truncate that is
    // not fused to the session swap leaves open, onto a file already empty.
    const appending = addEcho(root, "alpha", "stray");
    expect(await getRecordingSession(root, "alpha")).toBe(discarded);

    holder.open();
    const [restartResult, appendResult] = await Promise.allSettled([restarting, appending]);
    await held;

    if (restartResult.status === "rejected") throw restartResult.reason;
    expect(restartResult.value.restarted).toBe(true);
    expect(restartResult.value.discardedSteps).toBe(1);

    // The step belongs to a take that no longer exists: it must be reported as
    // rejected, never as recorded.
    expect(appendResult.status).toBe("rejected");
    const failure =
      appendResult.status === "rejected" ? getFailureSignal(appendResult.reason) : undefined;
    expect(failure?.error_code).toBe(FAILURE_CODES.FLOW_NO_ACTIVE_RECORDING);
    expect(failure?.failure_stage).toBe("flow_session_superseded");

    // The invariant: the new take's file is what the new take says it is, and
    // carries nothing from the discarded one.
    const session = await getRecordingSession(root, "alpha");
    expect(session).toBeDefined();
    expect(session).not.toBe(discarded);
    const onDisk = await readMarkers(root, "alpha");
    expect(onDisk).toEqual(markers(session!.flow.steps));
    expect(onDisk).not.toContain("echo:stray");

    // …and the new take records from there as a fresh recording.
    await addStep(root, "alpha", "a2");
    expect(await readMarkers(root, "alpha")).toEqual(["tool:a2"]);
    const finished = await finish(root, "alpha");
    expect(finished.steps).toBe(1);
  });
});

// ── A finish landing on top of an in-flight append ───────────────────

describe("a finish that lands while a step is still running", () => {
  /**
   * The invariant both outcomes share: the whole report is one snapshot of one
   * file state, and the recording is gone afterwards either way.
   */
  async function expectReportMatchesDisk(
    root: string,
    report: Awaited<ReturnType<typeof finish>>
  ): Promise<string[]> {
    const onDisk = await readMarkers(root, "alpha");
    expect(markers(parseFlow(report.flowFile).steps)).toEqual(onDisk);
    expect(report.steps).toBe(onDisk.length);
    // A step with a cross-tree verdict adds a second, indented `warning:` line,
    // so lines and steps are not always 1:1. These fixtures hold no
    // `await-ui-element`, but count the step lines rather than rely on that.
    expect(report.summary.filter((line) => /^\d+\. /.test(line))).toHaveLength(onDisk.length);
    expect(report.path).toBe(flowPath(root, "alpha"));
    expect(report.savedTo).toBe(flowPath(root, "alpha"));
    expect(await getRecordingSession(root, "alpha")).toBeUndefined();
    return onDisk;
  }

  // Both outcomes are pinned, each by the lock rather than by timing. An
  // earlier version varied a microtask count instead and only ever produced the
  // first one: the finish awaits a real `realpath` before joining the lock
  // queue, so no amount of microtask tuning can make it overtake an append
  // already queued — the "append rejected" branch simply never ran.

  it("includes an append that WON the lock in everything it reports", async () => {
    const root = await makeRoot("finish-inflight-append-wins");
    await start(root, "alpha");
    await addStep(root, "alpha", "a1");

    // A parked holder fixes the queue order: append, then finish.
    const holder = openGate();
    const held = withFlowFileLock(root, "alpha", () => holder.promise);
    const appending = addStep(root, "alpha", "a2");
    await settle();
    const finishing = finish(root, "alpha");
    holder.open();

    const [appended, finished] = await Promise.allSettled([appending, finishing]);
    await held;

    if (appended.status === "rejected") throw appended.reason;
    if (finished.status === "rejected") throw finished.reason;
    expect(await expectReportMatchesDisk(root, finished.value)).toEqual(["tool:a1", "tool:a2"]);
  });

  it("reports the file without an append that LOST, and rejects that append", async () => {
    const root = await makeRoot("finish-inflight-finish-wins");
    await start(root, "alpha");
    await addStep(root, "alpha", "a1");

    // Parked in its LIVE phase, before it has taken the lock — a real step can
    // sit here for minutes on a device. The finish runs to completion across it.
    const gate = gateNextSubTool();
    const appending = addStep(root, "alpha", "a2");
    await gate.reached;

    const report = await finish(root, "alpha");
    expect(await expectReportMatchesDisk(root, report)).toEqual(["tool:a1"]);

    gate.release();
    const appended = await captureFailure(appending);
    expect(getFailureSignal(appended)?.error_code).toBe(FAILURE_CODES.FLOW_NO_ACTIVE_RECORDING);
    // The step ran on the device but is in no take, and the file the finish
    // reported is still exactly what is on disk.
    expect(await readMarkers(root, "alpha")).toEqual(["tool:a1"]);
  });

  it("reads the file back and clears the session only once the lock is free", async () => {
    const root = await makeRoot("finish-lock");
    await start(root, "alpha");
    await addStep(root, "alpha", "a1");

    const order: string[] = [];
    const lock = openGate();
    const held = withFlowFileLock(root, "alpha", () => lock.promise);

    const finishing = finish(root, "alpha").then((r) => {
      order.push("finish-returned");
      return r;
    });

    await settle();
    expect(order).toEqual([]);
    // The session is still live: resolve-read-clear is one critical section.
    expect(await getRecordingSession(root, "alpha")).toBeDefined();

    order.push("lock-released");
    lock.open();
    await held;
    const finished = await finishing;

    expect(order).toEqual(["lock-released", "finish-returned"]);
    expect(finished.steps).toBe(1);
    expect(markers(parseFlow(finished.flowFile).steps)).toEqual(["tool:a1"]);
    expect(await getRecordingSession(root, "alpha")).toBeUndefined();
  });

  it("rejects a step whose recording was already finished", async () => {
    const root = await makeRoot("append-after-finish");
    await start(root, "alpha");
    await addStep(root, "alpha", "a1");

    const gate = gateNextSubTool();
    const appending = addStep(root, "alpha", "a2");
    await gate.reached;

    // The finish completes end-to-end before the step comes back.
    const finished = await finish(root, "alpha");
    expect(finished.steps).toBe(1);

    gate.release();
    const err = await captureFailure(appending);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_NO_ACTIVE_RECORDING);
    expect(getFailureSignal(err)?.failure_stage).toBe("flow_session_superseded");
    expect((err as Error).message).toContain("no longer active");
    // The key is EMPTY here — this session's own finish cleared it, and a new
    // take could only have claimed it under the same lock. Blaming a competing
    // agent sends the reader hunting for one that does not exist; the hazard to
    // name is the finished take now sitting on disk.
    expect((err as Error).message).not.toMatch(/belongs to another take/);
    expect((err as Error).message).toMatch(/finished take is on disk/);

    // The finished file is exactly what the finish reported.
    expect(await readMarkers(root, "alpha")).toEqual(["tool:a1"]);
    expect(markers(parseFlow(finished.flowFile).steps)).toEqual(["tool:a1"]);
  });
});

// ── A finish whose file a hand-edit broke ────────────────────────────

describe("a finish on a flow file that no longer parses", () => {
  // Nothing prevents a mid-recording hand edit, so parseFlow can legitimately
  // throw inside flow-finish-recording's critical section. The
  // session must survive that: clearing the key first leaves the agent unable to
  // retry the finish after repairing the file — flow-finish-recording answers
  // "No active recording", and the only tool that re-establishes the key,
  // flow-start-recording, truncates the very take it would be recovering.

  /** `steps` present but not a list — a shape parseFlow rejects outright. */
  const NOT_A_LIST = 'executionPrerequisite: ""\nsteps: oops\n';

  it("keeps the recording live and finishable once the file is repaired", async () => {
    const root = await makeRoot("finish-unparseable");
    await start(root, "alpha");
    await addStep(root, "alpha", "a1");
    await addEcho(root, "alpha", "a2");
    const session = await getRecordingSession(root, "alpha");
    const repaired = await fs.readFile(flowPath(root, "alpha"), "utf8");

    await fs.writeFile(flowPath(root, "alpha"), NOT_A_LIST, "utf8");

    const err = await captureFailure(finish(root, "alpha"));
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_FILE_INVALID);
    expect(getFailureSignal(err)?.failure_stage).toBe("flow_file_parse");

    // The finish reads and clears; it never writes — the botched edit is still
    // on disk byte for byte, so the agent can diff it against what it typed.
    expect(await fs.readFile(flowPath(root, "alpha"), "utf8")).toBe(NOT_A_LIST);

    // The take survived the failure, as the same session object.
    expect(await getRecordingSession(root, "alpha")).toBe(session);
    expect(session?.flow.steps).toHaveLength(2);

    // A retry while the file is still broken fails the same way — the recording
    // is live (the call got past requireRecordingSession), the FILE is at fault.
    const again = await captureFailure(finish(root, "alpha"));
    expect(getFailureSignal(again)?.error_code).toBe(FAILURE_CODES.FLOW_FILE_INVALID);

    // Repair the file the way the agent would, then carry on recording…
    await fs.writeFile(flowPath(root, "alpha"), repaired, "utf8");
    await addEcho(root, "alpha", "a3");
    expect(await readMarkers(root, "alpha")).toEqual(["tool:a1", "echo:a2", "echo:a3"]);

    // …and the retried finish succeeds, reporting the repaired file.
    const finished = await finish(root, "alpha");
    expect(finished.steps).toBe(3);
    expect(finished.summary).toHaveLength(3);
    expect(markers(parseFlow(finished.flowFile).steps)).toEqual(["tool:a1", "echo:a2", "echo:a3"]);
    expect(await getRecordingSession(root, "alpha")).toBeUndefined();
  });

  it("leaves a concurrent recording — and its own key — exactly as they were", async () => {
    const root = await makeRoot("finish-unparseable-step");
    await start(root, "alpha");
    await start(root, "beta");
    await addStep(root, "alpha", "a1");
    await addEcho(root, "beta", "b1");

    // A second botched-edit shape: a step whose directive key is a typo.
    await fs.writeFile(
      flowPath(root, "alpha"),
      'executionPrerequisite: ""\nsteps:\n  - ecko: oops\n',
      "utf8"
    );

    const err = await captureFailure(finish(root, "alpha"));
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_ENTRY_UNRECOGNIZED);

    // Both keys are still live, each bound to its own file.
    expect(
      listActiveRecordings()
        .map((r) => r.name)
        .sort()
    ).toEqual(["alpha", "beta"]);
    expect((await getRecordingSession(root, "alpha"))?.filePath).toBe(flowPath(root, "alpha"));

    // beta neither lost its file nor its ability to finish.
    expect(await readMarkers(root, "beta")).toEqual(["echo:b1"]);
    const finishedBeta = await finish(root, "beta");
    expect(markers(parseFlow(finishedBeta.flowFile).steps)).toEqual(["echo:b1"]);

    // alpha outlived beta's finish too, and finishes on the repaired file.
    expect(await getRecordingSession(root, "alpha")).toBeDefined();
    await fs.writeFile(
      flowPath(root, "alpha"),
      'executionPrerequisite: ""\nsteps:\n  - echo: repaired\n',
      "utf8"
    );
    const finishedAlpha = await finish(root, "alpha");
    expect(markers(parseFlow(finishedAlpha.flowFile).steps)).toEqual(["echo:repaired"]);
    expect(listActiveRecordings()).toEqual([]);
  });
});

// ── The concurrent-recording cap ─────────────────────────────────────

describe("the concurrent-recording cap", () => {
  it("evicts the least recently touched recording and keeps the rest", async () => {
    const root = await makeRoot("evict");
    const names = await fillRecordings(root);
    expect(listActiveRecordings()).toHaveLength(MAX_RECORDINGS);

    // Touch everything EXCEPT one entry in the middle of the table, so the
    // least-recently-used entry and the first-registered one are different
    // keys: `rec-7` is the only one never touched since it was started, while
    // `rec-0` was registered first but has since been used. An insertion-order
    // eviction would drop `rec-0`, so the assertions below separate the two
    // policies rather than passing under either.
    const untouched = names[7];
    for (const name of names.filter((n) => n !== untouched)) await addEcho(root, name, "touch");

    await start(root, "overflow");

    const live = listActiveRecordings()
      .map((r) => r.name)
      .sort();
    expect(live).toHaveLength(MAX_RECORDINGS);
    expect(live).toEqual([...names.filter((n) => n !== untouched), "overflow"].sort());
    expect(await getRecordingSession(root, untouched)).toBeUndefined();
    // The oldest registration survived, because it was still being used.
    expect(await getRecordingSession(root, names[0])).toBeDefined();
    // The survivors are still usable — eviction dropped one, not the table.
    await addEcho(root, names[0], "still-live");
    expect(await readMarkers(root, names[0])).toEqual(["echo:touch", "echo:still-live"]);
  });

  it("re-stamps a recording when its step LANDS, not just when it was resolved", async () => {
    // A step that takes minutes on a device would otherwise leave its own
    // session as the least-recently-used one for that whole time: the resolve
    // stamped it before the step ran, and every quick call elsewhere on the
    // host stamps later. The next `flow-start-recording` anywhere would then
    // evict the recording that had just successfully appended, and the agent's
    // next `flow-add-step` would fail on a take it was actively recording.
    //
    // Both callers touch on resolve via `requireRecordingSession`, so only the
    // stamp inside `appendStepToFlow` separates the two — and every other
    // eviction test drives recency through resolve, so none of them can.
    const root = await makeRoot("touch-on-land");
    const names = await fillRecordings(root);

    // rec-0's step resolves (stamping it) and then parks on the device.
    const gate = gateNextSubTool();
    const appending = addStep(root, "rec-0", "slow");
    await gate.reached;

    // Every other recording is used while that step is still running, so by
    // resolve-time recency rec-0 is now the oldest entry on the table.
    for (const name of names.slice(1)) await addEcho(root, name, "touch");

    // The step lands, which must re-stamp rec-0 as most recently used.
    gate.release();
    await appending;
    expect(await readMarkers(root, "rec-0")).toEqual(["tool:slow"]);

    await start(root, "overflow");

    // The recording that just appended survives; the victim is the one whose
    // last use really is the oldest. Without the stamp on land, rec-0 is the
    // one dropped here.
    expect(await getRecordingSession(root, "rec-0")).toBeDefined();
    expect(await getRecordingSession(root, names[1])).toBeUndefined();
    // And it is still usable, not merely present.
    await addEcho(root, "rec-0", "after");
    expect(await readMarkers(root, "rec-0")).toEqual(["tool:slow", "echo:after"]);
  });

  it("rejects an append whose recording was evicted while the step ran", async () => {
    const root = await makeRoot("evict-inflight");
    const names = await fillRecordings(root);

    // The step resolves rec-0's session (touching it) and parks.
    const gate = gateNextSubTool();
    const appending = addStep(root, "rec-0", "victim");
    await gate.reached;

    // Every other recording is touched afterwards, so rec-0's use is the oldest
    // one on the table; the next start overflows the cap and drops it out from
    // under the running step.
    for (const name of names.slice(1)) await addEcho(root, name, "touch");
    await start(root, "overflow");
    expect(await getRecordingSession(root, "rec-0")).toBeUndefined();

    gate.release();
    const err = await captureFailure(appending);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_NO_ACTIVE_RECORDING);
    expect(getFailureSignal(err)?.failure_stage).toBe("flow_session_superseded");
    expect((err as Error).message).toContain("concurrent-recording cap");
    // Same empty-key branch as a self-finish: no other take holds this key, so
    // the message must not send the agent looking for one — which would also
    // bury the actionable cause named one clause earlier.
    expect((err as Error).message).not.toMatch(/belongs to another take/);
    expect(await readMarkers(root, "rec-0")).toEqual([]);

    // A fresh call on the evicted key fails the ordinary not-live way.
    const late = await captureFailure(addEcho(root, "rec-0", "late"));
    expect(getFailureSignal(late)?.error_code).toBe(FAILURE_CODES.FLOW_NO_ACTIVE_RECORDING);
    expect(getFailureSignal(late)?.failure_stage).toBe("flow_require_recording");
  });

  it("reports a destructive restart even when eviction drops the key mid-restart", async () => {
    // A restart reads the take it is discarding ONCE, at the top of its critical
    // section, and drives BOTH `restarted` and `discardedSteps` off that read.
    // It must not re-derive `restarted` from the map after the truncate:
    // `evictIfOverCapacity` runs under another key's lock and can drop this key
    // in the window between the read and the register, and a `restarted` read
    // there would see the key already gone and report a restart that truncated a
    // real take (its file already reset) as a plain fresh start.
    const root = await makeRoot("restart-evict-race");
    const names = await fillRecordings(root);

    // rec-0 holds a real step and is the least-recently-used entry: record the
    // step first, then touch every other recording, so rec-0's last use is
    // oldest and the next overflow evicts exactly it.
    await addStep(root, "rec-0", "real");
    for (const name of names.slice(1)) await addEcho(root, name, "touch");

    // Park rec-0's restart on its own `countStepsOnDisk` read — after it has
    // captured the live session, before it truncates or re-registers.
    const target = flowPath(root, "rec-0");
    const arrived = openGate();
    const held = openGate();
    let gated = false;
    const realReadFile = fs.readFile;
    const spy = vi.spyOn(fs, "readFile").mockImplementation((async (
      p: unknown,
      ...rest: unknown[]
    ) => {
      if (!gated && String(p) === target) {
        gated = true;
        arrived.open();
        await held.promise;
      }
      return (realReadFile as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
    }) as unknown as typeof fs.readFile);

    const restarting = start(root, "rec-0");
    await arrived.promise;

    // A 33rd recording overflows the cap and evicts the LRU — rec-0's key —
    // while the restart is parked with rec-0's live session already captured.
    await start(root, "overflow");
    expect(await getRecordingSession(root, "rec-0")).toBeUndefined();

    held.open();
    const res = await restarting;
    spy.mockRestore();

    // The take really was destroyed…
    expect(await readMarkers(root, "rec-0")).toEqual([]);
    // …and the result says so, rather than collapsing to a plain fresh start.
    // Reading `restarted` from `startRecordingSession`'s post-eviction return
    // instead leaves `restarted` undefined here, so this separates the two.
    expect(res.restarted).toBe(true);
    expect(res.discardedSteps).toBe(1);
  });
});

// ── Recording a flow-execute step ────────────────────────────────────

describe("recording a flow-execute step while several projects are in play", () => {
  const fragment: FlowFile = {
    executionPrerequisite: "",
    steps: [{ kind: "echo", message: "helper" }],
  };

  it("keeps the raw step when the target is not a sibling of the RECORDING", async () => {
    const recordingRoot = await makeRoot("run-target-recording");
    const executedRoot = await makeRoot("run-target-executed");

    // The fragment exists in the project the nested flow-execute ran in, but
    // NOT next to the flow being recorded — so `run: helper` would be a
    // dangling reference at replay, which resolves siblings of the recording.
    await writeSavedFlow(executedRoot, "helper", fragment);

    await start(recordingRoot, "wrapper");
    const res = await addRawStep(recordingRoot, "wrapper", "flow-execute", {
      name: "helper",
      project_root: executedRoot,
      udid: IOS_DEVICE,
    });

    expect(res.message).toContain('could not resolve "helper" as a sibling fragment');
    expect(res.message).toContain("kept the raw flow-execute step");
    expect(await readSteps(recordingRoot, "wrapper")).toEqual([
      { kind: "tool", name: "flow-execute", args: { name: "helper", project_root: executedRoot } },
    ]);
  });

  it("keeps the raw step when the executed project has no file to compare against", async () => {
    const recordingRoot = await makeRoot("run-target-sibling");
    const executedRoot = await makeRoot("run-target-elsewhere");

    // Mirror image: the fragment is a sibling of the flow being recorded and is
    // absent from the executed project. Being a sibling is necessary for `run:`
    // but not sufficient — the recorded directive must replay the file that
    // just RAN, and nothing verifiable ran from the executed project's flows
    // dir, so the two cannot be shown to be one file. The raw step, which
    // replays via name + project_root, is then the only honest record.
    await writeSavedFlow(recordingRoot, "helper", fragment);
    await fs.mkdir(path.join(executedRoot, ".argent", "flows"), { recursive: true });

    await start(recordingRoot, "wrapper");
    const res = await addRawStep(recordingRoot, "wrapper", "flow-execute", {
      name: "helper",
      project_root: executedRoot,
      udid: IOS_DEVICE,
    });

    expect(res.message).toContain("could not verify which file the live flow-execute ran");
    expect(await readSteps(recordingRoot, "wrapper")).toEqual([
      { kind: "tool", name: "flow-execute", args: { name: "helper", project_root: executedRoot } },
    ]);
  });

  it("keeps the raw step when a same-named fragment exists in BOTH projects", async () => {
    const recordingRoot = await makeRoot("run-target-both");
    const executedRoot = await makeRoot("run-target-both-other");

    // The ambiguous case concurrent recording makes routine: a generic fragment
    // name that exists in two projects. `run: helper` resolves against the
    // recording, so replay would run a DIFFERENT file than the one that just
    // ran — same name, different flow, both green and nothing said. The
    // recorder refuses the substitution and keeps the raw call, which names
    // both files and reproduces exactly what ran.
    await writeSavedFlow(recordingRoot, "helper", fragment);
    await writeSavedFlow(executedRoot, "helper", {
      executionPrerequisite: "",
      steps: [{ kind: "echo", message: "the other project's helper" }],
    });

    await start(recordingRoot, "wrapper");
    const res = await addRawStep(recordingRoot, "wrapper", "flow-execute", {
      name: "helper",
      project_root: executedRoot,
      udid: IOS_DEVICE,
    });

    expect(res.message).toContain("not the file the live flow-execute ran");
    expect(res.message).toContain(executedRoot);
    expect(await readSteps(recordingRoot, "wrapper")).toEqual([
      { kind: "tool", name: "flow-execute", args: { name: "helper", project_root: executedRoot } },
    ]);

    // Same project on both sides is the unambiguous case: the file that ran and
    // the sibling that would replay are one file, so it composes and stays quiet.
    await start(recordingRoot, "quiet");
    const same = await addRawStep(recordingRoot, "quiet", "flow-execute", {
      name: "helper",
      project_root: recordingRoot,
      udid: IOS_DEVICE,
    });
    expect(same.message).toBe('Step added to "quiet" flow');
    expect(await readSteps(recordingRoot, "quiet")).toEqual([{ kind: "run", flow: "helper.yaml" }]);
  });
});

// ── Summarizing a hand-edited file that the parser cannot fully constrain ──

describe("finishing a recording whose YAML was hand-edited into an unrenderable step", () => {
  it("summarizes a cyclic tool-args anchor instead of throwing", async () => {
    const root = await makeRoot("cyclic-args");
    await start(root, "alpha");
    await addStep(root, "alpha", "a1");

    // A hand edit can land mid-recording, and `args:` is the one step body the
    // parser does not constrain. A cyclic YAML anchor reaches the summarizer as
    // a cyclic object, which JSON.stringify throws on.
    await fs.writeFile(
      flowPath(root, "alpha"),
      'executionPrerequisite: ""\nsteps:\n  - tool: keyboard\n    args: &a\n      self: *a\n',
      "utf8"
    );

    const finished = await finish(root, "alpha");
    expect(finished.steps).toBe(1);
    expect(finished.summary).toEqual(["1. tool: keyboard [cyclic args]"]);
    // The recording is properly closed, not left dangling by a thrown summary.
    expect(await getRecordingSession(root, "alpha")).toBeUndefined();
  });
});
