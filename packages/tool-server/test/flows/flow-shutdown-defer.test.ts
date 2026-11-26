import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Registry } from "@argent/registry";
import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import { flowAddScriptTool } from "../../src/tools/flows/flow-add-script";
import { createFlowAddStepTool } from "../../src/tools/flows/flow-add-step";
import { flowFinishRecordingTool } from "../../src/tools/flows/flow-finish-recording";
import { __resetRecordingsForTesting, parseFlow } from "../../src/tools/flows/flow-utils";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";

/**
 * A fragment recorded as a `run:` step in `steps:` keeps its `shutdown:` for
 * later, as a replay does: the recording runs it before its first shutdown
 * call, or at the finish. The fragment here "logs in" by writing a state file
 * and "logs out" in its shutdown; the recorder runs the real e2e-execute.
 */

vi.setConfig({ testTimeout: 30_000 });

let root: string;
let state: string;
let log: string;
const e2e = (file: string) => path.join(root, ".argent", "e2e", file);

function registry(): Registry {
  const r = new Registry();
  r.registerTool(createRunFlowTool(r) as never);
  r.registerTool(createFlowAddStepTool(r) as never);
  r.registerTool(flowAddScriptTool as never);
  r.registerTool(flowFinishRecordingTool as never);
  return r;
}

async function script(name: string, body: string): Promise<void> {
  await fs.writeFile(
    path.join(root, "scripts", name),
    `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";\n` +
      `const STATE = ${JSON.stringify(state)};\nconst LOG = ${JSON.stringify(log)};\n${body}\n`
  );
}

/** A fragment that logs in, and logs out in its shutdown. */
async function loginFragment(name: string): Promise<void> {
  await script(`${name}-in.mjs`, `writeFileSync(STATE, "in"); output.user = "u1";`);
  await script(
    `${name}-out.mjs`,
    `appendFileSync(LOG, ${JSON.stringify(name)} + " saw " + (output.after ?? "-") + "\\n");\n` +
      `writeFileSync(STATE, "out"); output.loggedOut = ${JSON.stringify(name)};`
  );
  await fs.writeFile(
    e2e(`${name}.yaml`),
    `steps:\n  - script: { path: ../../scripts/${name}-in.mjs }\n` +
      `shutdown:\n  - script: { path: ../../scripts/${name}-out.mjs }\n`
  );
}

const readState = () => fs.readFile(state, "utf8");
const readLog = () => fs.readFile(log, "utf8").catch(() => "");

function recorder(r: Registry, signal?: AbortSignal) {
  const opts = signal ? { signal } : undefined;
  return {
    run: (flow: string) =>
      r.invokeTool<{ message: string }>(
        "e2e-add-step",
        {
          name: "t",
          project_root: root,
          command: "e2e-execute",
          args: JSON.stringify({ name: flow, project_root: root }),
        },
        opts
      ),
    script: (file: string, shutdown?: boolean) =>
      r.invokeTool<{
        status: string;
        reason?: string;
        message: string;
        fragmentShutdown?: unknown;
      }>(
        "e2e-add-script",
        {
          name: "t",
          project_root: root,
          path: `../../scripts/${file}`,
          ...(shutdown ? { shutdown } : {}),
        },
        opts
      ),
    finish: () =>
      r.invokeTool<{ message: string; fragmentShutdown?: { ok: boolean; steps: object[] } }>(
        "e2e-finish-recording",
        { name: "t", project_root: root },
        opts
      ),
  };
}

beforeEach(async () => {
  __resetRecordingsForTesting();
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "flow-shutdown-defer-")));
  state = path.join(root, "state");
  log = path.join(root, "log");
  await fs.mkdir(e2e(""), { recursive: true });
  await fs.mkdir(path.join(root, "scripts"), { recursive: true });
  await loginFragment("login");
  await script(
    "need-in.mjs",
    `if (readFileSync(STATE, "utf8") !== "in") throw new Error("logged out");\noutput.after = "yes";`
  );
  await script(
    "need-out.mjs",
    `if (readFileSync(STATE, "utf8") !== "out") throw new Error("still logged in");\n` +
      `if (output.loggedOut !== "login") throw new Error("no fragment output");`
  );
  await flowStartRecordingTool.execute({}, { name: "t", project_root: root });
});
afterEach(async () => {
  __resetRecordingsForTesting();
  await fs.rm(root, { recursive: true, force: true });
});

describe("a fragment recorded as run: in steps:", () => {
  it("keeps its shutdown until the first shutdown call", async () => {
    const rec = recorder(registry());

    expect((await rec.run("login")).message).not.toContain("ran its shutdown");
    expect(await readState()).toBe("in");
    // The next recorded step sees the logged-in state.
    expect((await rec.script("need-in.mjs")).status).toBe("pass");

    const down = await rec.script("need-out.mjs", true);
    expect(down.reason ?? down.status).toBe("pass");
    // The fragment's shutdown ran first, against the steps' latest output.
    expect(await readLog()).toBe("login saw yes\n");
    expect(down.message).toContain("first ran the shutdown: of the fragments");
    expect(down.fragmentShutdown).toMatchObject({
      ok: true,
      steps: [{ kind: "script", status: "pass", shutdown: true, e2eTest: "login" }],
    });
    // Nothing left for the finish.
    expect((await rec.finish()).fragmentShutdown).toBeUndefined();
    expect(await readLog()).toBe("login saw yes\n");

    // Replayed on headless Chrome in the PR's E2E: a `run:` step needs a device.
    expect(parseFlow(await fs.readFile(e2e("t.yaml"), "utf8"))).toMatchObject({
      steps: [{ kind: "run", flow: "login.yaml" }, { kind: "script" }],
      shutdown: [{ kind: "script" }],
    });
  });

  it("runs it at the finish when no shutdown call came, newest fragment first", async () => {
    await loginFragment("second");
    const rec = recorder(registry());
    await rec.run("login");
    await rec.run("second");
    expect(await readLog()).toBe("");

    const finished = await rec.finish();

    expect(await readLog()).toBe("second saw -\nlogin saw -\n");
    expect(await readState()).toBe("out");
    expect(finished.message).toContain("first ran the shutdown: of the fragments");
    expect(finished.fragmentShutdown?.ok).toBe(true);
    expect(finished.fragmentShutdown?.steps.map((s) => (s as { e2eTest: string }).e2eTest)).toEqual(
      ["second", "login"]
    );
  });

  it("reports a failed fragment shutdown and still runs the others", async () => {
    await script("bad-out.mjs", `throw new Error("cannot log out");`);
    await fs.writeFile(
      e2e("bad.yaml"),
      "steps:\n  - echo: bad\nshutdown:\n  - script: { path: ../../scripts/bad-out.mjs }\n"
    );
    const rec = recorder(registry());
    await rec.run("login");
    await rec.run("bad");

    const finished = await rec.finish();

    expect(await readLog()).toBe("login saw -\n");
    expect(finished.fragmentShutdown?.ok).toBe(false);
    expect(finished.message).toContain("1 of 2 steps failed; see fragmentShutdown");
  });

  it("skips it when the call that runs it is cancelled", async () => {
    await recorder(registry()).run("login");
    const cancelled = new AbortController();
    cancelled.abort();

    const finished = await recorder(registry(), cancelled.signal).finish();

    expect(await readState()).toBe("in");
    expect(finished.fragmentShutdown?.steps).toMatchObject([
      { status: "skip", reason: "run aborted", shutdown: true },
    ]);
  });

  it("keeps nothing for later from a cancelled run, which skips its shutdown", async () => {
    const shared: { doc: object; deferShutdown: boolean; deferredShutdown?: unknown } = {
      doc: {},
      deferShutdown: true,
    };
    const cancelled = new AbortController();
    cancelled.abort();

    const result = await registry().invokeTool<FlowRunResult>(
      "e2e-execute",
      { name: "login", project_root: root },
      { signal: cancelled.signal, flowOutput: shared } as never
    );

    expect(shared.deferredShutdown).toBeUndefined();
    expect(result.steps.at(-1)).toMatchObject({ status: "skip", shutdown: true });
  });

  it("runs it at once when the run: step is not recorded", async () => {
    const r = registry();
    // A hand edit the next append cannot parse.
    await fs.writeFile(e2e("t.yaml"), "steps: [\n");

    await expect(recorder(r).run("login")).rejects.toThrow();

    expect(await readState()).toBe("out");
    expect(await readLog()).toBe("login saw -\n");
  });
});
