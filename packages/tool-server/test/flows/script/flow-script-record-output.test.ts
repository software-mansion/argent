import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FAILURE_CODES, getFailureSignal, type Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../../src/tools/describe/contract";

// A recorded gesture-tap reads its selector off the tree the runner replays
// against. Only the tap case below sets a tree; every other call leaves it
// unread.
let currentTree: (() => DescribeTreeData) | undefined;
vi.mock("../../../src/tools/flows/flow-tree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/tools/flows/flow-tree")>();
  return {
    ...actual,
    fetchFlowTree: vi.fn(async (): Promise<DescribeTreeData> => {
      if (!currentTree) throw new Error("this test set no tree");
      return currentTree();
    }),
  };
});

import { flowStartRecordingTool } from "../../../src/tools/flows/flow-start-recording";
import { flowInsertEchoTool } from "../../../src/tools/flows/flow-insert-echo";
import { flowAddScriptTool } from "../../../src/tools/flows/flow-add-script";
import { flowFinishRecordingTool } from "../../../src/tools/flows/flow-finish-recording";
import { createFlowAddStepTool } from "../../../src/tools/flows/flow-add-step";
import { createRunFlowTool, type FlowRunResult } from "../../../src/tools/flows/flow-run";
import {
  __resetRecordingsForTesting,
  getRecordingSession,
  parseFlow,
  type FlowStep,
  type RecordingSession,
} from "../../../src/tools/flows/flow-utils";
import { resolveHostBash } from "../../helpers/host-bash";
import { scopeTempHome } from "../../helpers/temp-home";

vi.setConfig({ testTimeout: 30_000 });

scopeTempHome("argent-flow-record-output-home-");

const DEVICE = "00000000-0000-0000-0000-0000000000AB";

let root: string;

async function write(relative: string, contents: string): Promise<string> {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents, "utf8");
  return file;
}

function flowPath(name: string): string {
  return path.join(root, ".argent", "flows", `${name}.yaml`);
}

async function onDisk(name: string): Promise<string> {
  return fs.readFile(flowPath(name), "utf8");
}

async function steps(name: string): Promise<FlowStep[]> {
  return parseFlow(await onDisk(name)).steps;
}

async function start(name: string): Promise<void> {
  await flowStartRecordingTool.execute({}, { name, project_root: root });
}

function addScript(name: string, scriptPath: string, env?: Record<string, string>) {
  return flowAddScriptTool.execute(
    {},
    { name, project_root: root, path: scriptPath, ...(env ? { env } : {}) }
  );
}

async function session(name: string): Promise<RecordingSession> {
  const live = await getRecordingSession(root, name);
  if (!live) throw new Error(`no live recording "${name}"`);
  return live;
}

function markPath(mark: string): string {
  return path.join(root, `${mark}.mark`);
}

/** A path inside a bash double-quoted string: forward slashes only. */
function shellPath(file: string): string {
  return file.replace(/\\/g, "/");
}

function readMark(mark: string): string | undefined {
  try {
    return fsSync.readFileSync(markPath(mark), "utf8");
  } catch {
    return undefined;
  }
}

/** `.mjs` source that writes `expression` to a marker file. */
function writesMark(mark: string, expression: string): string {
  return (
    `import { writeFileSync } from "node:fs";\n` +
    `writeFileSync(${JSON.stringify(markPath(mark))}, ${expression});\n`
  );
}

/**
 * `.mjs` source that polls until `condition` holds. Bounded, so a handshake
 * that never completes fails the script with a reason instead of hanging.
 */
function waitsUntil(condition: string, what: string): string {
  return (
    `{\n` +
    `  const deadline = Date.now() + 15000;\n` +
    `  while (!(${condition})) {\n` +
    `    if (Date.now() > deadline) throw new Error(${JSON.stringify(`timed out waiting for ${what}`)});\n` +
    `    await new Promise((r) => setTimeout(r, 10));\n` +
    `  }\n` +
    `}\n`
  );
}

async function rejection(call: Promise<unknown>): Promise<Error> {
  try {
    await call;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
  throw new Error("expected the call to fail");
}

function mockRegistry(handle?: (id: string, params: unknown) => unknown) {
  const invokeTool = vi.fn(async (id: string, params?: unknown) => {
    if (id === "list-devices") return { devices: [] };
    return handle ? handle(id, params) : { ok: true };
  });
  const registry = {
    invokeTool,
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    resolveService: vi.fn(async () => ({
      isConnected: () => true,
      listConnectedBundleIds: () => [],
    })),
  } as unknown as Registry;
  return { registry, invokeTool };
}

async function runFlow(name: string): Promise<FlowRunResult> {
  const { registry } = mockRegistry();
  const result = await createRunFlowTool(registry).execute({}, {
    project_root: root,
    name,
  } as never);
  if (!("steps" in result)) throw new Error(`expected a run result, got: ${result.notice}`);
  return result;
}

let noBash: string | undefined;

beforeAll(async () => {
  const found = await resolveHostBash();
  if (!("path" in found)) noBash = found.problem;
});

function skipWithoutBash(ctx: { skip: (note?: string) => void }): void {
  if (noBash) ctx.skip(`this host has no bash to run a .sh step with: ${noBash}`);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "flow-script-record-output-"));
  __resetRecordingsForTesting();
  currentTree = undefined;
});

afterEach(async () => {
  __resetRecordingsForTesting();
  await fs.rm(root, { recursive: true, force: true });
});

describe("flow-add-script hands each script the recording's document", () => {
  it("gives a .mjs the document as `output` and merges what each script returns", async () => {
    await write("scripts/first.mjs", `output.user = { id: "u_1", name: "Ada" };`);
    await write(
      "scripts/second.mjs",
      writesMark("second", "JSON.stringify(output)") + `output.order = { id: "o_1" };`
    );
    await start("mjs");
    expect((await session("mjs")).output).toEqual({});
    expect((await session("mjs")).outputRevision).toBe(0);

    const first = await addScript("mjs", "../../scripts/first.mjs");
    const second = await addScript("mjs", "../../scripts/second.mjs");

    expect([first.status, second.status]).toEqual(["pass", "pass"]);
    expect(JSON.parse(readMark("second")!)).toEqual({ user: { id: "u_1", name: "Ada" } });
    const live = await session("mjs");
    expect(live.output).toEqual({ user: { id: "u_1", name: "Ada" }, order: { id: "o_1" } });
    expect(live.outputRevision).toBe(2);
    expect(await steps("mjs")).toEqual([
      { kind: "script", path: "../../scripts/first.mjs" },
      { kind: "script", path: "../../scripts/second.mjs" },
    ]);
  });

  it("gives a .sh the document in $ARGENT_OUTPUT, and keeps the keys a .mjs set before it", async (ctx) => {
    skipWithoutBash(ctx);
    await write("scripts/user.mjs", `output.user = { id: "u_1" };`);
    await write(
      "scripts/order.sh",
      `set -euo pipefail\n` +
        `cat "$ARGENT_OUTPUT" > "${shellPath(markPath("sh-saw"))}"\n` +
        `printf '{"order":{"id":"o_1"}}' > "$ARGENT_OUTPUT"\n`
    );
    await start("mjs-then-sh");

    await addScript("mjs-then-sh", "../../scripts/user.mjs");
    const sh = await addScript("mjs-then-sh", "../../scripts/order.sh");

    expect(sh.status).toBe("pass");
    expect(JSON.parse(readMark("sh-saw")!)).toEqual({ user: { id: "u_1" } });
    // The result carries the script's own document; the recording holds the merge.
    expect(sh.outputJson).toBe('{"order":{"id":"o_1"}}');
    const live = await session("mjs-then-sh");
    expect(live.output).toEqual({ user: { id: "u_1" }, order: { id: "o_1" } });
    expect(live.outputRevision).toBe(2);
  });

  it("keeps the keys a .sh wrote when a .mjs after it replaces the whole object", async (ctx) => {
    skipWithoutBash(ctx);
    await write(
      "scripts/order.sh",
      `set -euo pipefail\n` +
        `cat "$ARGENT_OUTPUT" > "${shellPath(markPath("sh-saw"))}"\n` +
        `printf '{"order":{"id":"o_1"}}' > "$ARGENT_OUTPUT"\n`
    );
    await write(
      "scripts/user.mjs",
      writesMark("mjs-saw", "JSON.stringify(output)") +
        `globalThis.output = { user: { id: "u_1" } };`
    );
    await start("sh-then-mjs");

    await addScript("sh-then-mjs", "../../scripts/order.sh");
    const mjs = await addScript("sh-then-mjs", "../../scripts/user.mjs");

    expect(mjs.status).toBe("pass");
    expect(JSON.parse(readMark("sh-saw")!)).toEqual({});
    expect(JSON.parse(readMark("mjs-saw")!)).toEqual({ order: { id: "o_1" } });
    expect(mjs.outputJson).toBe('{"user":{"id":"u_1"}}');
    const live = await session("sh-then-mjs");
    expect(live.output).toEqual({ order: { id: "o_1" }, user: { id: "u_1" } });
    expect(live.outputRevision).toBe(2);
  });
});

describe("a recorded env reference", () => {
  it("hands a later script the token an earlier one wrote, records the reference, and reads the replay's own token", async (ctx) => {
    skipWithoutBash(ctx);
    // The counter makes every login's token different, so the replay's token
    // cannot equal the recording's by accident.
    await write(
      "scripts/login.sh",
      `set -euo pipefail\n` +
        `counter="${shellPath(path.join(root, "login-count"))}"\n` +
        `n=$(( $(cat "$counter" 2>/dev/null || echo 0) + 1 ))\n` +
        `printf '%s' "$n" > "$counter"\n` +
        `token="tok-$n-$$-$RANDOM"\n` +
        `printf '%s' "$token" > "${shellPath(markPath("login"))}"\n` +
        `printf '{"auth":{"token":"%s"}}' "$token" > "$ARGENT_OUTPUT"\n`
    );
    await write(
      "scripts/create-order.sh",
      `set -euo pipefail\n` + `printf '%s' "$TOKEN" > "${shellPath(markPath("order"))}"\n`
    );
    await start("checkout");

    const login = await addScript("checkout", "../../scripts/login.sh");
    const recordedToken = readMark("login")!;
    expect(login.status).toBe("pass");
    expect(recordedToken).toMatch(/^tok-1-/);

    const order = await addScript("checkout", "../../scripts/create-order.sh", {
      TOKEN: "{{output:auth.token}}",
    });

    expect(order.status).toBe("pass");
    expect(order.message).toBe('Added script step to "checkout" flow.');
    expect(readMark("order")).toBe(recordedToken);

    const expectedSteps = [
      { kind: "script", path: "../../scripts/login.sh" },
      {
        kind: "script",
        path: "../../scripts/create-order.sh",
        env: { TOKEN: "{{output:auth.token}}" },
      },
    ];
    const file = await onDisk("checkout");
    expect(parseFlow(file).steps).toEqual(expectedSteps);
    expect(file).toContain('TOKEN: "{{output:auth.token}}"');
    expect(file).not.toContain(recordedToken);

    const finished = await flowFinishRecordingTool.execute({}, {
      name: "checkout",
      project_root: root,
    } as never);
    expect(finished.flowFile).toBe(file);
    expect(parseFlow(finished.flowFile).steps).toEqual(expectedSteps);

    const replay = await runFlow("checkout");

    expect(replay.ok).toBe(true);
    const replayToken = readMark("login")!;
    expect(replayToken).toMatch(/^tok-2-/);
    expect(replayToken).not.toBe(recordedToken);
    expect(readMark("order")).toBe(replayToken);
  });

  it("stops the call before the script starts when it does not resolve", async () => {
    await write("scripts/seed.mjs", `output.user = { id: "u_1" };`);
    await write("scripts/create-order.mjs", writesMark("order", '"ran"') + `output.order = 1;`);
    await start("unresolved");
    await addScript("unresolved", "../../scripts/seed.mjs");
    const before = await onDisk("unresolved");

    const err = await rejection(
      addScript("unresolved", "../../scripts/create-order.mjs", {
        TOKEN: "{{output:auth.token}}",
      })
    );

    expect(err.name).toBe("InvalidToolInputError");
    expect(err.message).toBe(
      "This call's `env` cannot be used, so the script did not run and nothing was recorded: " +
        "`script.env.TOKEN`: {{output:auth.token}} did not resolve: `output` has no `auth` " +
        "(its keys: user)"
    );
    expect(getFailureSignal(err)).toMatchObject({
      error_code: FAILURE_CODES.TOOL_INPUT_INVALID,
      failure_stage: "flow_add_script_env",
    });
    expect(readMark("order")).toBeUndefined();
    expect(await onDisk("unresolved")).toBe(before);
    const live = await session("unresolved");
    expect(live.output).toEqual({ user: { id: "u_1" } });
    expect(live.outputRevision).toBe(1);
  });
});

describe("two calls on one recording at the same time", () => {
  /**
   * Script A waits until B has started — so B read the document before A
   * merged — and B waits until A's step is in the file, so B appends second.
   * Handshakes rather than sleeps: the order holds on a loaded machine.
   */
  async function race(name: string, keyA: string, keyB: string) {
    const bStarted = markPath(`${name}-b-started`);
    await write(
      `scripts/${name}-a.mjs`,
      `import { existsSync } from "node:fs";\n` +
        waitsUntil(`existsSync(${JSON.stringify(bStarted)})`, "B to start") +
        `await new Promise((r) => setTimeout(r, 150));\n` +
        `output[${JSON.stringify(keyA)}] = "from-a";\n`
    );
    await write(
      `scripts/${name}-b.mjs`,
      `import { readFileSync, writeFileSync } from "node:fs";\n` +
        `writeFileSync(${JSON.stringify(bStarted)}, "x");\n` +
        waitsUntil(
          `readFileSync(${JSON.stringify(flowPath(name))}, "utf8").includes("${name}-a.mjs")`,
          "A's step in the file"
        ) +
        `output[${JSON.stringify(keyB)}] = "from-b";\n`
    );
    await start(name);
    const [a, b] = await Promise.all([
      addScript(name, `../../scripts/${name}-a.mjs`),
      addScript(name, `../../scripts/${name}-b.mjs`),
    ]);
    return { a, b };
  }

  it("warns the call that appends second, and the document follows the file's order", async () => {
    const { a, b } = await race("race", "a", "b");

    expect([a.status, b.status]).toEqual(["pass", "pass"]);
    expect(a.message).toBe('Added script step to "race" flow.');
    expect(b.message).toBe(
      `Added script step to "race" flow, but another call merged its script's output into this ` +
        `recording while the script was running, so the script ran with an older output document ` +
        `than the one its step receives at replay. The step IS in the file — calling this again ` +
        `would append a SECOND one and run the script's side effect twice. Remove it first if you ` +
        `want it recorded under the newer output document.`
    );
    expect([a.stepCount, b.stepCount]).toEqual([1, 2]);
    // B was handed the document from before A merged, and returns only its key.
    expect(b.outputJson).toBe('{"b":"from-b"}');
    expect(await steps("race")).toEqual([
      { kind: "script", path: "../../scripts/race-a.mjs" },
      { kind: "script", path: "../../scripts/race-b.mjs" },
    ]);
    const live = await session("race");
    expect(live.output).toEqual({ a: "from-a", b: "from-b" });
    expect(live.outputRevision).toBe(2);
  });

  it("ends with the value of the step last in the file when both write one key", async () => {
    const { a, b } = await race("samekey", "code", "code");

    expect([a.status, b.status]).toEqual(["pass", "pass"]);
    expect(b.message).toContain("another call merged its script's output into this recording");
    expect(await steps("samekey")).toEqual([
      { kind: "script", path: "../../scripts/samekey-a.mjs" },
      { kind: "script", path: "../../scripts/samekey-b.mjs" },
    ]);
    const live = await session("samekey");
    expect(live.output).toEqual({ code: "from-b" });
    expect(live.outputRevision).toBe(2);
  });

  /**
   * Records `output.code = "111"`, then runs a flow-add-script that writes
   * `"222"` alongside a keyboard flow-add-step. The script waits until the
   * keyboard call has been dispatched — after its references resolved — and the
   * mocked keyboard returns only once the script call has finished.
   */
  async function stepDuringMerge(name: string, args: string) {
    const dispatched = markPath(`${name}-dispatched`);
    await write(`scripts/${name}-first.mjs`, `output.code = "111";`);
    await write(
      `scripts/${name}-slow.mjs`,
      `import { existsSync } from "node:fs";\n` +
        waitsUntil(`existsSync(${JSON.stringify(dispatched)})`, "the keyboard call") +
        `output.code = "222";\n`
    );
    await start(name);
    await addScript(name, `../../scripts/${name}-first.mjs`);

    // Started first; it cannot finish before the keyboard call is dispatched.
    const scriptCall = addScript(name, `../../scripts/${name}-slow.mjs`);
    const { registry, invokeTool } = mockRegistry(async (id) => {
      if (id !== "keyboard") return { ok: true };
      await fs.writeFile(dispatched, "x");
      await scriptCall;
      return { typed: true };
    });
    const stepCall = createFlowAddStepTool(registry).execute(
      {},
      { name, project_root: root, command: "keyboard", args }
    );
    const [script, step] = await Promise.all([scriptCall, stepCall]);
    return { script, step, invokeTool };
  }

  it("warns a flow-add-step whose references resolved before a script merged", async () => {
    const { script, step, invokeTool } = await stepDuringMerge(
      "typing",
      '{"text":"{{output:code}}"}'
    );

    expect(script.status).toBe("pass");
    expect(script.message).toBe('Added script step to "typing" flow.');
    expect(invokeTool).toHaveBeenCalledWith("keyboard", { text: "111" });
    expect(step.message).toBe(
      `Step added to "typing" flow — another call merged a script's output into this recording ` +
        `while this call was running, so its references resolved against an older output ` +
        `document than the one the step reads at replay. The step IS in the file — calling this ` +
        `again would append a second one`
    );
    expect(await steps("typing")).toEqual([
      { kind: "script", path: "../../scripts/typing-first.mjs" },
      { kind: "script", path: "../../scripts/typing-slow.mjs" },
      { kind: "tool", name: "keyboard", args: { text: "{{output:code}}" } },
    ]);
    const live = await session("typing");
    expect(live.output).toEqual({ code: "222" });
    expect(live.outputRevision).toBe(2);
  });

  it("does not warn a flow-add-step with no reference in the same situation", async () => {
    const { step, invokeTool } = await stepDuringMerge("plain", '{"text":"hi"}');

    expect(invokeTool).toHaveBeenCalledWith("keyboard", { text: "hi" });
    expect(step.message).toBe('Step added to "plain" flow');
    expect((await session("plain")).outputRevision).toBe(2);
  });
});

describe("a script handed the whole document while another call merged into it", () => {
  const DRIFT =
    "another call merged its script's output into this recording while the script was running";

  let noJq: string | undefined;

  beforeAll(() => {
    try {
      execFileSync("jq", ["--version"], { stdio: "ignore" });
    } catch (err) {
      noJq = err instanceof Error ? err.message : String(err);
    }
  });

  interface Overlap {
    /** `.mjs` body of the step recorded before the two calls. */
    seed: string;
    /** `.mjs` body `fast` runs once `slow` has started. */
    fast: string;
    /** Body `slow` runs once `fast`'s step is in the file. */
    slow: string;
    slowIs?: "mjs" | "sh";
  }

  /**
   * Records `seed`, then runs two calls at once. `slow` is handed the seeded
   * document and waits until `fast`'s step is in the file; `fast` waits until
   * `slow` has started. The file reads seed, fast, slow — the order a replay
   * runs them in. At replay `fast` finds the marker this recording left, so
   * neither script waits there.
   */
  async function overlap(name: string, { seed, fast, slow, slowIs = "mjs" }: Overlap) {
    const slowStarted = markPath(`${name}-slow-started`);
    const slowSaw = markPath(`${name}-slow-saw`);
    const fastScript = `${name}-fast.mjs`;
    await write(`scripts/${name}-seed.mjs`, seed);
    await write(
      `scripts/${fastScript}`,
      `import { existsSync } from "node:fs";\n` +
        waitsUntil(`existsSync(${JSON.stringify(slowStarted)})`, "slow to start") +
        fast
    );
    await write(
      `scripts/${name}-slow.${slowIs}`,
      slowIs === "mjs"
        ? `import { readFileSync, writeFileSync } from "node:fs";\n` +
            `writeFileSync(${JSON.stringify(slowSaw)}, JSON.stringify(output));\n` +
            `writeFileSync(${JSON.stringify(slowStarted)}, "x");\n` +
            waitsUntil(
              `readFileSync(${JSON.stringify(flowPath(name))}, "utf8").includes(${JSON.stringify(fastScript)})`,
              "fast's step in the file"
            ) +
            slow
        : `set -euo pipefail\n` +
            `cat "$ARGENT_OUTPUT" > "${shellPath(slowSaw)}"\n` +
            `printf x > "${shellPath(slowStarted)}"\n` +
            `deadline=$((SECONDS + 15))\n` +
            `until grep -qF "${fastScript}" "${shellPath(flowPath(name))}"; do\n` +
            `  if (( SECONDS > deadline )); then echo "timed out waiting for fast's step in the file" >&2; exit 1; fi\n` +
            `  sleep 0.01\n` +
            `done\n` +
            slow
    );
    await start(name);
    await addScript(name, `../../scripts/${name}-seed.mjs`);
    const [fastCall, slowCall] = await Promise.all([
      addScript(name, `../../scripts/${fastScript}`),
      addScript(name, `../../scripts/${name}-slow.${slowIs}`),
    ]);
    expect([fastCall.status, slowCall.status]).toEqual(["pass", "pass"]);
    expect(fastCall.message).toBe(`Added script step to "${name}" flow.`);
    expect(slowCall.message).toContain(DRIFT);
    expect(await steps(name)).toEqual([
      { kind: "script", path: `../../scripts/${name}-seed.mjs` },
      { kind: "script", path: `../../scripts/${fastScript}` },
      { kind: "script", path: `../../scripts/${name}-slow.${slowIs}` },
    ]);
    return { slow: slowCall, handed: JSON.parse(readMark(`${name}-slow-saw`)!) as unknown };
  }

  async function echoThenFinish(name: string, message: string) {
    const echo = await flowInsertEchoTool.execute({}, { name, project_root: root, message });
    expect(echo.message).toBe(`Echo added to "${name}" flow`);
    await flowFinishRecordingTool.execute({}, { name, project_root: root } as never);
  }

  function echoed(result: FlowRunResult): (string | undefined)[] {
    return result.steps.filter((step) => step.kind === "echo").map((step) => step.message);
  }

  it("does not restore the key another call merged, so the recording reads what the replay reads", async () => {
    const { slow, handed } = await overlap("stale", {
      seed: `output.a = 1;`,
      fast: `output.a = 2;\n`,
      slow: `output.b = 5;\n`,
    });

    expect(handed).toEqual({ a: 1 });
    // The script hands back the `a` it was handed, older than the recording's.
    expect(slow.outputJson).toBe('{"a":1,"b":5}');
    const live = await session("stale");
    expect(live.output).toEqual({ a: 2, b: 5 });
    expect(live.outputRevision).toBe(3);

    const recording = mockRegistry(() => ({ typed: true }));
    await createFlowAddStepTool(recording.registry).execute(
      {},
      { name: "stale", project_root: root, command: "keyboard", args: '{"text":"a={{output:a}}"}' }
    );
    expect(recording.invokeTool).toHaveBeenCalledWith("keyboard", { text: "a=2" });
    await echoThenFinish("stale", "a={{output:a}}");

    const replaying = mockRegistry(() => ({ typed: true }));
    const replay = await createRunFlowTool(replaying.registry).execute({}, {
      project_root: root,
      name: "stale",
      device: DEVICE,
    } as never);
    if (!("steps" in replay)) throw new Error(`expected a run result, got: ${replay.notice}`);

    expect(replay.ok).toBe(true);
    expect(replaying.invokeTool).toHaveBeenCalledWith(
      "keyboard",
      expect.objectContaining({ text: "a=2" })
    );
    expect(echoed(replay)).toEqual(["a=2"]);
  });

  it("keeps the late script's own change to a key the other call merged", async () => {
    const { slow, handed } = await overlap("rewrite", {
      seed: `output.a = 1;`,
      fast: `output.a = 2;\n`,
      slow: `output.a = 9;\noutput.b = 5;\n`,
    });

    expect(handed).toEqual({ a: 1 });
    expect(slow.outputJson).toBe('{"a":9,"b":5}');
    const live = await session("rewrite");
    expect(live.output).toEqual({ a: 9, b: 5 });
    expect(live.outputRevision).toBe(3);

    await echoThenFinish("rewrite", "a={{output:a}}");
    const replay = await runFlow("rewrite");
    expect(replay.ok).toBe(true);
    expect(echoed(replay)).toEqual(["a=9"]);
  });

  /**
   * `slow` hands back the `cfg` it was handed with its keys in another order
   * and its values unchanged, while `fast` merged a newer `cfg.a`.
   */
  async function reorderedByLateScript(name: string, slowIs: "mjs" | "sh", slowWrites: string) {
    const { slow, handed } = await overlap(name, {
      seed: `output.cfg = { b: 1, a: 2 };`,
      fast: `output.cfg = { b: 1, a: 3 };\n`,
      slow: slowWrites,
      slowIs,
    });

    expect(handed).toEqual({ cfg: { b: 1, a: 2 } });
    // Byte for byte, so the keys really did come back in another order.
    expect(slow.outputJson).toBe('{"cfg":{"a":2,"b":1},"orderId":5}');
    const live = await session(name);
    expect(live.output).toEqual({ cfg: { b: 1, a: 3 }, orderId: 5 });
    expect(live.outputRevision).toBe(3);

    await echoThenFinish(name, "a={{output:cfg.a}}");
    const replay = await runFlow(name);
    expect(replay.ok).toBe(true);
    expect(echoed(replay)).toEqual(["a=3"]);
  }

  it("does not count a .mjs reordering a nested object's keys as a change to it", async () => {
    await reorderedByLateScript(
      "reorder",
      "mjs",
      `output.cfg = { a: output.cfg.a, b: output.cfg.b };\noutput.orderId = 5;\n`
    );
  });

  it("does not count a .sh rewriting the document with jq -S as a change to a nested object", async (ctx) => {
    skipWithoutBash(ctx);
    if (noJq) ctx.skip(`this host has no jq to sort the document's keys with: ${noJq}`);
    await reorderedByLateScript(
      "reorder-sh",
      "sh",
      `sorted=$(jq -S '. + {orderId: 5}' "$ARGENT_OUTPUT")\n` +
        `printf '%s' "$sorted" > "$ARGENT_OUTPUT"\n`
    );
  });

  it("merges the whole returned document when nothing merged while the script ran", async () => {
    await write("scripts/first.mjs", `output.a = 1;\noutput.user = { id: "u_1" };`);
    await write("scripts/second.mjs", `output.c = 3;`);
    await start("sequential");

    const first = await addScript("sequential", "../../scripts/first.mjs");
    const second = await addScript("sequential", "../../scripts/second.mjs");

    expect(second.message).toBe('Added script step to "sequential" flow.');
    // Handed back whole: the keys it left alone and the one it added.
    expect(second.outputJson).toBe('{"a":1,"user":{"id":"u_1"},"c":3}');
    const live = await session("sequential");
    expect(live.output).toStrictEqual({
      ...JSON.parse(first.outputJson!),
      ...JSON.parse(second.outputJson!),
    });
    expect(live.outputRevision).toBe(2);
  });
});

describe("a passing script whose step is not recorded", () => {
  it("leaves the recording's document as it was when the append throws", async () => {
    await write("scripts/seed.mjs", `output.user = { id: "u_1" };`);
    await write(
      "scripts/edit.mjs",
      `import * as fs from "node:fs";\n` +
        `fs.writeFileSync(${JSON.stringify(flowPath("refused"))}, ` +
        `'steps:\\n  - echo: "created {{output:user.id ||}}"\\n');\n` +
        `output.extra = "never merged";`
    );
    await write(
      "scripts/vanish.mjs",
      `import * as fs from "node:fs";\n` +
        `fs.unlinkSync(${JSON.stringify(flowPath("vanished"))});\n` +
        `output.extra = "never merged";`
    );

    // The re-parse refuses the file the script hand-edited.
    await start("refused");
    await addScript("refused", "../../scripts/seed.mjs");
    const refused = await rejection(addScript("refused", "../../scripts/edit.mjs"));

    expect(refused.message).toContain("passed, but the step was not recorded");
    expect(refused.message).toContain("holds a malformed output reference");
    const afterRefusal = await session("refused");
    expect(afterRefusal.output).toEqual({ user: { id: "u_1" } });
    expect(afterRefusal.outputRevision).toBe(1);

    // The file is gone, so the append cannot read it.
    await start("vanished");
    await addScript("vanished", "../../scripts/seed.mjs");
    const vanished = await rejection(addScript("vanished", "../../scripts/vanish.mjs"));

    expect(vanished.message).toContain("passed, but the step was not recorded");
    expect(vanished.message).toContain("Check the script's changes before you retry");
    const afterVanish = await session("vanished");
    expect(afterVanish.output).toEqual({ user: { id: "u_1" } });
    expect(afterVanish.outputRevision).toBe(1);
  });

  it("refuses a merge past 1 MiB, appends nothing, and keeps the document", async () => {
    const half = 600 * 1024;
    await write("scripts/big-a.mjs", `output.a = "y".repeat(${half});`);
    // Each document alone is inside the limit; only the merge is not. Replacing
    // the object drops `a` from what this script returns, not from the merge.
    await write("scripts/big-b.mjs", `globalThis.output = { b: "z".repeat(${half}) };`);
    await start("oversized");
    const first = await addScript("oversized", "../../scripts/big-a.mjs");
    expect(first.status).toBe("pass");

    const err = await rejection(addScript("oversized", "../../scripts/big-b.mjs"));

    expect(err.message).toBe(
      `Script "../../scripts/big-b.mjs" passed, but the step was not recorded. Check the ` +
        `script's changes before you retry. After this step the flow output is 1.2 MiB encoded; ` +
        `the limit is 1.0 MiB. A script cannot remove a key, so set one the flow no longer reads ` +
        `to null.`
    );
    expect(getFailureSignal(err)).toMatchObject({
      error_code: FAILURE_CODES.FLOW_FILE_WRITE_FAILED,
      failure_stage: "flow_add_script_output",
    });
    expect(await steps("oversized")).toEqual([{ kind: "script", path: "../../scripts/big-a.mjs" }]);
    const live = await session("oversized");
    expect(Object.keys(live.output)).toEqual(["a"]);
    expect((live.output.a as string).length).toBe(half);
    expect(live.outputRevision).toBe(1);
  });
});

describe("flow-add-echo against the recording's document", () => {
  it("appends a misspelled path with a warning, a correct one plainly, and refuses a malformed one", async () => {
    await write("scripts/seed.mjs", `output.user = { id: "u_1" };`);
    await start("echoes");
    await addScript("echoes", "../../scripts/seed.mjs");

    const misspelled = await flowInsertEchoTool.execute(
      {},
      { name: "echoes", project_root: root, message: "Created {{output:usr.id}}" }
    );
    expect(misspelled.stepCount).toBe(2);
    expect(misspelled.message).toBe(
      `Echo added to "echoes" flow — but its message does not resolve against the recording's ` +
        "output document: `echo`: {{output:usr.id}} did not resolve: `output` has no `usr` " +
        "(its keys: user). At replay the echo errors and stops the run unless a script writes " +
        "that path first"
    );

    const correct = await flowInsertEchoTool.execute(
      {},
      { name: "echoes", project_root: root, message: "Created {{output:user.id}}" }
    );
    expect(correct.stepCount).toBe(3);
    expect(correct.message).toBe('Echo added to "echoes" flow');

    const malformed = await rejection(
      flowInsertEchoTool.execute(
        {},
        { name: "echoes", project_root: root, message: "Created {{output:user.id ||}}" }
      )
    );
    expect(malformed.message).toContain(
      "The echo was not recorded: its own `message` failed validation."
    );
    expect(malformed.message).toContain("`echo` holds a malformed output reference");

    expect(await steps("echoes")).toEqual([
      { kind: "script", path: "../../scripts/seed.mjs" },
      { kind: "echo", message: "Created {{output:usr.id}}" },
      { kind: "echo", message: "Created {{output:user.id}}" },
    ]);
  });
});

describe("flow-add-step against the recording's document", () => {
  it("runs the tool with resolved args, records the reference, and refuses one that does not resolve before the tool runs", async () => {
    await write("scripts/seed.mjs", `output.code = "4711";`);
    await start("args");
    await addScript("args", "../../scripts/seed.mjs");
    const { registry, invokeTool } = mockRegistry();
    const tool = createFlowAddStepTool(registry);

    const added = await tool.execute(
      {},
      {
        name: "args",
        project_root: root,
        command: "keyboard",
        args: '{"text":"Code {{output:code}}"}',
      }
    );

    expect(invokeTool).toHaveBeenCalledWith("keyboard", { text: "Code 4711" });
    expect(added.message).toBe('Step added to "args" flow');
    expect((await steps("args"))[1]).toEqual({
      kind: "tool",
      name: "keyboard",
      args: { text: "Code {{output:code}}" },
    });
    expect(await onDisk("args")).not.toContain("4711");

    const err = await rejection(
      tool.execute(
        {},
        {
          name: "args",
          project_root: root,
          command: "keyboard",
          args: '{"text":"{{output:missing}}"}',
        }
      )
    );

    expect(err.message).toBe(
      "The `keyboard` call was not made and nothing was recorded: `args.text`: " +
        "{{output:missing}} did not resolve: `output` has no `missing` (its keys: code)"
    );
    expect(getFailureSignal(err)).toMatchObject({
      error_code: FAILURE_CODES.TOOL_INPUT_INVALID,
      failure_stage: "flow_add_step_output_reference",
    });
    expect(invokeTool.mock.calls.filter(([id]) => id === "keyboard")).toHaveLength(1);
    expect(await steps("args")).toHaveLength(2);
  });

  it("records a restart-app whose bundle id is a reference as a tool step, and a literal one as a launch", async () => {
    await write("scripts/seed.mjs", `output.app = "com.acme.notes";`);
    await start("relaunch");
    await addScript("relaunch", "../../scripts/seed.mjs");
    const { registry, invokeTool } = mockRegistry(() => ({ restarted: true }));
    const tool = createFlowAddStepTool(registry);

    const fromOutput = await tool.execute(
      {},
      {
        name: "relaunch",
        project_root: root,
        command: "restart-app",
        args: JSON.stringify({ udid: "ABC", bundleId: "{{output:app}}" }),
      }
    );
    expect(invokeTool).toHaveBeenLastCalledWith("restart-app", {
      udid: "ABC",
      bundleId: "com.acme.notes",
    });

    const literal = await tool.execute(
      {},
      {
        name: "relaunch",
        project_root: root,
        command: "restart-app",
        args: JSON.stringify({ udid: "ABC", bundleId: "com.acme.notes" }),
      }
    );

    expect(fromOutput.recorded).toBe('2. tool: restart-app {"bundleId":"{{output:app}}"}');
    expect(literal.recorded).toBe("3. launch: com.acme.notes");
    expect(await steps("relaunch")).toEqual([
      { kind: "script", path: "../../scripts/seed.mjs" },
      { kind: "tool", name: "restart-app", args: { bundleId: "{{output:app}}" } },
      { kind: "launch", app: "com.acme.notes" },
    ]);
  });

  it("warns that a flow-execute recorded as run: ran its scripts and references with an empty document", async () => {
    await write(
      ".argent/flows/seeded.yaml",
      "steps:\n  - script: { path: ../../scripts/seed.mjs }\n"
    );
    await write(".argent/flows/greets.yaml", 'steps:\n  - echo: "Hello {{output:user.name}}"\n');
    await write(".argent/flows/plain.yaml", "steps:\n  - echo: hi\n");
    await start("composed");
    const { registry } = mockRegistry(() => ({ ok: true, steps: [] }));
    const tool = createFlowAddStepTool(registry);
    const record = (fragment: string) =>
      tool.execute(
        {},
        {
          name: "composed",
          project_root: root,
          command: "flow-execute",
          args: JSON.stringify({ name: fragment, project_root: root }),
        }
      );
    const warning = (fragment: string) =>
      `the live flow-execute ran ${fragment}.yaml as a run of its own, which started with an ` +
      `empty output document, and argent kept none of the output its scripts wrote; at replay ` +
      `the run: step shares this flow's output document, so its scripts and references can see ` +
      `different values than they did now`;

    const seeded = await record("seeded");
    const greets = await record("greets");
    const plain = await record("plain");

    expect(seeded.message).toBe(`Step added to "composed" flow — ${warning("seeded")}`);
    expect(greets.message).toBe(`Step added to "composed" flow — ${warning("greets")}`);
    expect(plain.message).toBe('Step added to "composed" flow');
    expect(await steps("composed")).toEqual([
      { kind: "run", flow: "seeded.yaml" },
      { kind: "run", flow: "greets.yaml" },
      { kind: "run", flow: "plain.yaml" },
    ]);
  });
});

describe("a recorded step that fails validation after its call ran", () => {
  function screen(children: DescribeNode[]): DescribeNode {
    return { role: "AXGroup", frame: { x: 0, y: 0, width: 1, height: 1 }, children };
  }

  it("says the gesture-tap ran when the selector read off the screen is a malformed reference", async () => {
    currentTree = () => ({
      source: "native-devtools",
      tree: screen([
        {
          role: "AXButton",
          label: "{{output:user.id ||}}",
          frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 },
          children: [],
        },
      ]),
    });
    await start("tapped");
    const { registry, invokeTool } = mockRegistry(() => ({ tapped: true }));

    const err = await rejection(
      createFlowAddStepTool(registry).execute(
        {},
        {
          name: "tapped",
          project_root: root,
          command: "gesture-tap",
          args: JSON.stringify({ udid: DEVICE, x: 0.5, y: 0.5 }),
        }
      )
    );

    expect(invokeTool).toHaveBeenCalledWith("gesture-tap", { udid: DEVICE, x: 0.5, y: 0.5 });
    expect(err.message).toContain(
      "The `gesture-tap` call ran, but its step failed validation and was not recorded. Check " +
        "the call's changes before you retry."
    );
    expect(err.message).toContain("holds a malformed output reference");
    expect(getFailureSignal(err)).toMatchObject({
      error_code: FAILURE_CODES.FLOW_ENTRY_UNRECOGNIZED,
      failure_stage: "flow_output_reference",
    });
    expect(await steps("tapped")).toEqual([]);
  });
});

describe("what a recorded script's document carries", () => {
  it("appends the large-integer warning to flow-add-script's message, once", async (ctx) => {
    skipWithoutBash(ctx);
    await write(
      "scripts/order.sh",
      `printf '{"order":{"id":12345678901234567891}}' > "$ARGENT_OUTPUT"\n`
    );
    await write("scripts/tag.mjs", `output.tag = "t";`);
    await start("bigint");

    const order = await addScript("bigint", "../../scripts/order.sh");
    // Handed the rounded value and handing it back unchanged is not a new warning.
    const tag = await addScript("bigint", "../../scripts/tag.mjs");

    expect(order.status).toBe("pass");
    expect(order.message).toBe(
      'Added script step to "bigint" flow. Warning: output.order.id is 12345678901234567000, ' +
        "past the largest integer a JSON number holds exactly (9007199254740991), so it may " +
        "have been rounded; write an identifier as a string."
    );
    expect(tag.message).toBe('Added script step to "bigint" flow.');
    expect((await session("bigint")).output).toEqual({
      order: { id: Number("12345678901234567891") },
      tag: "t",
    });
  });

  it("drops a .mjs member set to undefined, and does not remove a key an earlier script set", async () => {
    await write("scripts/set-promo.mjs", `output.promo = "SUMMER";`);
    await write("scripts/no-promo.mjs", `output.kept = "yes";\noutput.promo = undefined;`);

    await start("fresh");
    const fresh = await addScript("fresh", "../../scripts/no-promo.mjs");
    expect(fresh.status).toBe("pass");
    expect(fresh.outputJson).toBe('{"kept":"yes"}');
    const freshSession = await session("fresh");
    expect(freshSession.output).toEqual({ kept: "yes" });
    expect(Object.hasOwn(freshSession.output, "promo")).toBe(false);

    // A script cannot remove a key: `undefined` is simply not written.
    await start("earlier");
    await addScript("earlier", "../../scripts/set-promo.mjs");
    const cleared = await addScript("earlier", "../../scripts/no-promo.mjs");
    expect(cleared.status).toBe("pass");
    expect((await session("earlier")).output).toEqual({ promo: "SUMMER", kept: "yes" });
  });
});
