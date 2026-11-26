import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CLIENT_FILE_MARKER, type Registry } from "@argent/registry";
import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import { flowAddScriptTool } from "../../src/tools/flows/flow-add-script";
import { flowInsertEchoTool } from "../../src/tools/flows/flow-insert-echo";
import { createFlowAddStepTool } from "../../src/tools/flows/flow-add-step";
import { flowFinishRecordingTool } from "../../src/tools/flows/flow-finish-recording";
import {
  __resetRecordingsForTesting,
  parseFlow,
  serializeFlow,
} from "../../src/tools/flows/flow-utils";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";

/** The recorders' `shutdown` param: the step goes to `shutdown:` and still runs now. */

vi.setConfig({ testTimeout: 30_000 });

let root: string;
const e2e = (file: string) => path.join(root, ".argent", "e2e", file);
const onDisk = async () => parseFlow(await fs.readFile(e2e("t.yaml"), "utf8"));

function mockRegistry(result: unknown = { ok: true }) {
  const invokeTool = vi.fn(async () => result);
  return {
    registry: { invokeTool, getTool: vi.fn(() => ({})) } as unknown as Registry,
    invokeTool,
  };
}

const echo = (message: string, shutdown?: boolean) =>
  flowInsertEchoTool.execute(
    {},
    { name: "t", project_root: root, message, ...(shutdown ? { shutdown } : {}) }
  );

beforeEach(async () => {
  __resetRecordingsForTesting();
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "flow-shutdown-rec-")));
});
afterEach(async () => {
  __resetRecordingsForTesting();
  await fs.rm(root, { recursive: true, force: true });
});

describe("recording into shutdown:", () => {
  it("appends each kind to shutdown:, counts that list, and the finish lists it", async () => {
    await fs.mkdir(path.join(root, "scripts"), { recursive: true });
    await fs.writeFile(
      path.join(root, "scripts", "down.mjs"),
      "globalThis.output = { cleaned: true };\n"
    );
    await flowStartRecordingTool.execute({}, { name: "t", project_root: root });
    await echo("main");
    const down = await echo("cleaning up", true);
    expect(down).toMatchObject({ stepCount: 1, message: expect.stringMatching(/^Shutdown echo/) });

    const script = await flowAddScriptTool.execute(
      {},
      { name: "t", project_root: root, path: "../../scripts/down.mjs", shutdown: true }
    );
    expect(script).toMatchObject({
      status: "pass",
      stepCount: 2,
      recorded: "shutdown 2. script: ../../scripts/down.mjs",
    });

    const { registry, invokeTool } = mockRegistry();
    const tool = await createFlowAddStepTool(registry).execute(
      {},
      {
        name: "t",
        project_root: root,
        command: "stop-metro",
        args: '{"port":8081}',
        shutdown: true,
      }
    );
    // It ran now, as any recorded step does.
    expect(invokeTool.mock.calls[0]?.slice(0, 2)).toEqual(["stop-metro", { port: 8081 }]);
    expect(tool).toMatchObject({ stepCount: 3, recorded: expect.stringMatching(/^shutdown 3\. /) });
    await echo("after", false);

    expect(await onDisk()).toEqual({
      executionPrerequisite: "",
      steps: [
        { kind: "echo", message: "main" },
        { kind: "echo", message: "after" },
      ],
      shutdown: [
        { kind: "echo", message: "cleaning up" },
        { kind: "script", path: "../../scripts/down.mjs" },
        { kind: "tool", name: "stop-metro", args: { port: 8081 } },
      ],
    });

    const finished = await flowFinishRecordingTool.execute({}, { name: "t", project_root: root });
    expect(finished.message).toContain("(2 steps, 3 shutdown steps)");
    expect(finished.steps).toBe(2);
    expect(finished.shutdownSteps).toBe(3);
    expect(finished.summary.slice(2)).toEqual([
      "shutdown 1. echo: cleaning up",
      "shutdown 2. script: ../../scripts/down.mjs",
      expect.stringMatching(/^shutdown 3\. tool: stop-metro/),
    ]);
  });

  it("counts the shutdown steps a restart discards", async () => {
    await flowStartRecordingTool.execute({}, { name: "t", project_root: root });
    await echo("main");
    await echo("down", true);

    const restarted = await flowStartRecordingTool.execute({}, { name: "t", project_root: root });

    expect(restarted).toMatchObject({ discardedSteps: 2 });
  });

  it("carries shutdown: in a linked recording's file directive", async () => {
    await flowStartRecordingTool.execute({}, { name: "t", project_root: root }, {
      linked: true,
    } as never);
    const out = await flowInsertEchoTool.execute(
      {},
      { name: "t", project_root: root, message: "down", shutdown: true },
      { linked: true } as never
    );

    const directive = out.savedTo as { [CLIENT_FILE_MARKER]: true; content: string };
    expect(parseFlow(directive.content).shutdown).toEqual([{ kind: "echo", message: "down" }]);
    expect(out.stepCount).toBe(1);
  });

  it("says when a fragment recorded as run: already ran its shutdown", async () => {
    await fs.mkdir(e2e(""), { recursive: true });
    await fs.writeFile(
      e2e("frag.yaml"),
      "steps:\n  - echo: frag\nshutdown:\n  - echo: frag down\n",
      "utf8"
    );
    const { registry } = mockRegistry({
      ok: true,
      steps: [
        { kind: "echo", status: "pass" },
        { kind: "echo", status: "pass", shutdown: true },
      ],
    });
    await flowStartRecordingTool.execute({}, { name: "t", project_root: root });

    const out = (await createFlowAddStepTool(registry).execute(
      {},
      {
        name: "t",
        project_root: root,
        command: "e2e-execute",
        args: JSON.stringify({ name: "frag", project_root: root }),
      }
    )) as { message: string };

    expect((await onDisk()).steps).toEqual([{ kind: "run", flow: "frag.yaml" }]);
    expect(out.message).toMatch(
      /frag\.yaml ran its shutdown: steps at the end of this call; a replay runs them at the end/
    );
  });

  it("keeps what a shutdown script returns out of the later steps, as a replay does", async () => {
    await fs.mkdir(path.join(root, "scripts"), { recursive: true });
    await fs.writeFile(
      path.join(root, "scripts", "down.mjs"),
      'globalThis.output = { ...output, token: "from-shutdown" };\n'
    );
    await fs.writeFile(
      path.join(root, "scripts", "main.mjs"),
      'if (output.token) throw new Error("saw " + output.token);\nglobalThis.output = { ...output, main: 1 };\n'
    );
    await fs.writeFile(
      path.join(root, "scripts", "down2.mjs"),
      'if (output.token !== "from-shutdown") throw new Error("lost token");\n'
    );
    const add = (file: string, shutdown?: boolean) =>
      flowAddScriptTool.execute(
        {},
        {
          name: "t",
          project_root: root,
          path: `../../scripts/${file}`,
          ...(shutdown ? { shutdown } : {}),
        }
      );
    await flowStartRecordingTool.execute({}, { name: "t", project_root: root });

    expect((await add("down.mjs", true)).status).toBe("pass");
    expect((await add("main.mjs")).status).toBe("pass");
    // A later shutdown step still sees what the earlier one returned.
    expect((await add("down2.mjs", true)).status).toBe("pass");
  });

  it("does not claim a different order for a run: recorded into shutdown:", async () => {
    await fs.mkdir(e2e(""), { recursive: true });
    await fs.writeFile(e2e("frag.yaml"), "steps:\n  - echo: frag\nshutdown:\n  - echo: down\n");
    const { registry } = mockRegistry({
      ok: true,
      steps: [{ kind: "echo", status: "pass", shutdown: true }],
    });
    await flowStartRecordingTool.execute({}, { name: "t", project_root: root });

    const out = (await createFlowAddStepTool(registry).execute(
      {},
      {
        name: "t",
        project_root: root,
        command: "e2e-execute",
        args: JSON.stringify({ name: "frag", project_root: root }),
        shutdown: true,
      }
    )) as { message: string };

    expect((await onDisk()).shutdown).toEqual([{ kind: "run", flow: "frag.yaml" }]);
    expect(out.message).not.toContain("ran its shutdown");
  });

  it("counts the shutdown list when e2e-add-step records nothing", async () => {
    await flowStartRecordingTool.execute({}, { name: "t", project_root: root });
    await echo("a");
    await echo("b");
    await echo("down", true);
    const { registry } = mockRegistry();

    const out = await createFlowAddStepTool(registry).execute(
      {},
      { name: "t", project_root: root, command: "e2e-add-echo", shutdown: true }
    );

    expect(out.message).toContain("no step was recorded");
    expect(out.stepCount).toBe(1);
  });

  it("keeps a recorded run: fragment's shutdown output away from the later steps", async () => {
    // The nested run shares the recording's document; its shutdown writes
    // what only the recording's shutdown steps may see.
    const { registry } = mockRegistry();
    (registry.invokeTool as ReturnType<typeof vi.fn>).mockImplementation(
      async (
        _id: string,
        _args: unknown,
        opts?: { flowOutput?: { doc: object; shutdownDoc?: object } }
      ) => {
        opts!.flowOutput!.doc = { user: "u1" };
        opts!.flowOutput!.shutdownDoc = { user: "u1", cleaned: "yes" };
        return { ok: true, steps: [] };
      }
    );
    await fs.mkdir(e2e(""), { recursive: true });
    await fs.writeFile(e2e("frag.yaml"), "steps:\n  - echo: frag\n");
    await fs.mkdir(path.join(root, "scripts"), { recursive: true });
    await fs.writeFile(
      path.join(root, "scripts", "check.mjs"),
      'if (output.user !== "u1") throw new Error("no user");\nif (output.cleaned !== process.env.WANT) throw new Error("cleaned=" + output.cleaned);\n'
    );
    await flowStartRecordingTool.execute({}, { name: "t", project_root: root });
    await createFlowAddStepTool(registry).execute(
      {},
      {
        name: "t",
        project_root: root,
        command: "e2e-execute",
        args: JSON.stringify({ name: "frag", project_root: root }),
      }
    );
    const check = (want: string | undefined, shutdown?: boolean) =>
      flowAddScriptTool.execute(
        {},
        {
          name: "t",
          project_root: root,
          path: "../../scripts/check.mjs",
          env: want === undefined ? {} : { WANT: want },
          ...(shutdown ? { shutdown } : {}),
        }
      );

    expect((await check(undefined)).status).toBe("pass");
    expect((await check("yes", true)).status).toBe("pass");
  });

  it("leaves a shared document as the steps left it, and the rest in shutdownDoc", async () => {
    await fs.mkdir(path.join(root, "scripts"), { recursive: true });
    await fs.writeFile(path.join(root, "scripts", "up.mjs"), "output.user = 'u1';\n");
    await fs.writeFile(path.join(root, "scripts", "down.mjs"), "output.cleaned = true;\n");
    await fs.mkdir(e2e(""), { recursive: true });
    await fs.writeFile(
      e2e("t.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "script", path: "../../scripts/up.mjs" }],
        shutdown: [{ kind: "script", path: "../../scripts/down.mjs" }],
      })
    );
    const { registry } = mockRegistry();
    const shared: { doc: Record<string, unknown>; shutdownDoc?: Record<string, unknown> } = {
      doc: {},
    };

    const result = await createRunFlowTool(registry).execute(
      {},
      { name: "t", project_root: root },
      { flowOutput: shared } as never
    );

    expect((result as FlowRunResult).steps.map((s) => s.reason ?? s.status)).toEqual([
      "pass",
      "pass",
    ]);
    expect(shared.doc).toEqual({ user: "u1" });
    expect(shared.shutdownDoc).toEqual({ user: "u1", cleaned: true });
  });

  it("repeats a failed wait recorded into shutdown: under its shutdown line at finish", async () => {
    const { registry } = mockRegistry({
      success: false,
      elapsed: 1500,
      note: "no element matched",
    });
    await flowStartRecordingTool.execute({}, { name: "t", project_root: root });
    await echo("main");

    await createFlowAddStepTool(registry).execute(
      {},
      {
        name: "t",
        project_root: root,
        command: "await-ui-element",
        args: JSON.stringify({ udid: "u", condition: "visible", selector: { text: "Bye" } }),
        shutdown: true,
      }
    );
    const finished = await flowFinishRecordingTool.execute({}, { name: "t", project_root: root });

    const at = finished.summary.findIndex((line) => line.startsWith("shutdown 1."));
    expect(finished.summary[at + 1]).toMatch(
      /^ {3}warning: recorded, but the wait itself never held/
    );
    expect(finished.message).toContain("1 step recorded a wait that did not pass");
  });
});
