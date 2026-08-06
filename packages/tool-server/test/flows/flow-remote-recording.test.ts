import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry, ToolContext } from "@argent/registry";
import {
  ArtifactStore,
  CLIENT_FILE_MARKER,
  FAILURE_CODES,
  getFailureSignal,
} from "@argent/registry";

import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import { flowInsertEchoTool } from "../../src/tools/flows/flow-insert-echo";
import {
  flowFinishRecordingTool,
  summarizeStep,
} from "../../src/tools/flows/flow-finish-recording";
import { createFlowAddStepTool } from "../../src/tools/flows/flow-add-step";
import { createRunFlowTool, resolveFlowSource } from "../../src/tools/flows/flow-run";
import { flowReadPrerequisiteTool } from "../../src/tools/flows/flow-read-prerequisite";
import { __resetRecordingsForTesting, parseFlow } from "../../src/tools/flows/flow-utils";

/**
 * Remote-mode flow behavior: the agent's project_root does NOT exist on this
 * host (the boundary probe says presentOnHost: false), so recording stays in
 * memory and every mutating tool returns a client-write directive instead of
 * touching this host's disk.
 */

// A path that exists on the (simulated) client but not on this "server".
const CLIENT_ROOT = path.join(os.tmpdir(), "definitely-not-on-this-host", "agent-project");
const CLIENT_FLOW_PATH = path.join(CLIENT_ROOT, ".argent", "flows", "remote-flow.yaml");

// A SECOND client project — a different agent recording a flow of the same
// name. Same host, same flow name, different project root.
const OTHER_CLIENT_ROOT = path.join(os.tmpdir(), "definitely-not-on-this-host", "other-project");
const OTHER_CLIENT_FLOW_PATH = path.join(OTHER_CLIENT_ROOT, ".argent", "flows", "remote-flow.yaml");

function remoteCtx(root: string = CLIENT_ROOT): ToolContext {
  return {
    artifacts: new ArtifactStore(),
    fileInputs: {
      project_root: { clientPath: root, presentOnHost: false, viaUpload: false },
    },
  };
}

/** The ctx the boundary produces after materializing the client's uploaded flow YAML. */
function uploadCtx(): ToolContext {
  return {
    artifacts: new ArtifactStore(),
    fileInputs: {
      flow_file: { clientPath: CLIENT_FLOW_PATH, presentOnHost: false, viaUpload: true },
    },
  };
}

function createMockRegistry(tools: Record<string, { result: unknown }> = {}) {
  return {
    invokeTool: vi.fn(async (id: string) => {
      const entry = tools[id];
      if (!entry) throw new Error(`Tool "${id}" not found`);
      return entry.result;
    }),
    getTool: vi.fn(() => undefined),
  } as unknown as Registry;
}

beforeEach(() => {
  __resetRecordingsForTesting();
});

afterEach(async () => {
  __resetRecordingsForTesting();
  await fs.rm(CLIENT_ROOT, { recursive: true, force: true });
  await fs.rm(OTHER_CLIENT_ROOT, { recursive: true, force: true });
});

describe("flow recording with a remote client (probe miss)", () => {
  it("start-recording returns a directive and writes nothing on this host", async () => {
    const result = await flowStartRecordingTool.execute(
      {},
      { name: "remote-flow", project_root: CLIENT_ROOT, executionPrerequisite: "Home" },
      remoteCtx()
    );

    expect(result.savedTo).toMatchObject({
      [CLIENT_FILE_MARKER]: true,
      path: CLIENT_FLOW_PATH,
    });
    const directive = result.savedTo as { content: string };
    expect(parseFlow(directive.content).executionPrerequisite).toBe("Home");
    // The agent's directory layout must not be recreated on the server host.
    await expect(fs.stat(CLIENT_ROOT)).rejects.toThrow();
  });

  it("add-step / add-echo accumulate in memory and return updated directives", async () => {
    const registry = createMockRegistry({ tap: { result: { tapped: true } } });
    const addStep = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute(
      {},
      { name: "remote-flow", project_root: CLIENT_ROOT, executionPrerequisite: "Home" },
      remoteCtx()
    );

    await flowInsertEchoTool.execute(
      {},
      { name: "remote-flow", project_root: CLIENT_ROOT, message: "label" }
    );
    const stepResult = await addStep.execute(
      {},
      { name: "remote-flow", project_root: CLIENT_ROOT, command: "tap", args: '{"x":0.5}' }
    );

    const directive = stepResult.savedTo as { path: string; content: string };
    expect(directive.path).toBe(CLIENT_FLOW_PATH);
    expect(parseFlow(directive.content).steps).toEqual([
      { kind: "echo", message: "label" },
      { kind: "tool", name: "tap", args: { x: 0.5 } },
    ]);
    await expect(fs.stat(CLIENT_ROOT)).rejects.toThrow();
  });

  it("does not bake a device id into a remotely recorded flow-execute step (issue #607)", async () => {
    // A remote recording ALWAYS keeps the raw `tool: flow-execute` step —
    // `run:` composition is host-resolved, so captureRunTarget bails before it
    // can rewrite. That makes this path the main real-world producer of a flow
    // with a record-time device id baked in, which then pinned every replay.
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const addStep = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute(
      {},
      { name: "remote-flow", project_root: CLIENT_ROOT, executionPrerequisite: "Home" },
      remoteCtx()
    );

    const stepResult = await addStep.execute(
      {},
      {
        name: "remote-flow",
        project_root: CLIENT_ROOT,
        command: "flow-execute",
        args: JSON.stringify({ name: "sub", project_root: CLIENT_ROOT, device: "RECORD-TIME-ID" }),
      },
      remoteCtx()
    );

    const directive = stepResult.savedTo as { content: string };
    expect(parseFlow(directive.content).steps).toEqual([
      { kind: "tool", name: "flow-execute", args: { name: "sub", project_root: CLIENT_ROOT } },
    ]);
  });

  it("add-step rejects a flow-execute flow_path — a client sibling is unreadable here", async () => {
    const registry = createMockRegistry({ "flow-execute": { result: { ok: true, steps: [] } } });
    const addStep = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute(
      {},
      { name: "remote-flow", project_root: CLIENT_ROOT, executionPrerequisite: "Home" },
      remoteCtx()
    );

    await expect(
      addStep.execute(
        {},
        {
          name: "remote-flow",
          project_root: CLIENT_ROOT,
          command: "flow-execute",
          args: JSON.stringify({
            flow_path: path.join(CLIENT_ROOT, ".argent", "flows", "login.yaml"),
            project_root: CLIENT_ROOT,
          }),
        }
      )
    ).rejects.toThrow(/not persisted on this host/i);

    expect(registry.invokeTool).not.toHaveBeenCalled();
  });

  it("finish-recording summarizes the in-memory flow and clears the session", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "remote-flow", project_root: CLIENT_ROOT, executionPrerequisite: "Home" },
      remoteCtx()
    );
    await flowInsertEchoTool.execute(
      {},
      { name: "remote-flow", project_root: CLIENT_ROOT, message: "only step" }
    );

    const result = await flowFinishRecordingTool.execute(
      {},
      { name: "remote-flow", project_root: CLIENT_ROOT }
    );

    expect(result.steps).toBe(1);
    expect(result.summary).toEqual(["1. echo: only step"]);
    expect(result.path).toBe(CLIENT_FLOW_PATH);

    // Assert the directive's CONTENT, not just its shape. `steps`, `summary`
    // and `path` all derive from the in-memory flow, so they agree with each
    // other no matter what `savedTo` carries — and in client mode `savedTo` is
    // the only thing that lands the artifact (`path` names a file that does not
    // exist on this host). A directive built with an empty body would satisfy
    // every other assertion here while the client wrote a flow with no steps,
    // which replays as a top-level PASS over nothing.
    const savedTo = result.savedTo as { [CLIENT_FILE_MARKER]: true; path: string; content: string };
    expect(savedTo[CLIENT_FILE_MARKER]).toBe(true);
    expect(savedTo.path).toBe(CLIENT_FLOW_PATH);
    expect(parseFlow(savedTo.content).steps).toEqual([{ kind: "echo", message: "only step" }]);
    // The finished YAML the caller is shown and the one the client writes must
    // be the same bytes.
    expect(savedTo.content).toBe(result.flowFile);

    await expect(
      flowFinishRecordingTool.execute({}, { name: "remote-flow", project_root: CLIENT_ROOT })
    ).rejects.toThrow("No active recording");
  });

  it("reports a running stepCount in client mode, without returning the YAML per step", async () => {
    // The host-mode add-echo/add-step tests count stepCount off the re-read
    // file; this pins the OTHER branch of appendStepToFlow — client mode counts
    // off the in-memory flow and must report the same running total, still
    // without echoing the growing YAML (the write travels via savedTo).
    await flowStartRecordingTool.execute(
      {},
      { name: "remote-flow", project_root: CLIENT_ROOT, executionPrerequisite: "Home" },
      remoteCtx()
    );
    const first = await flowInsertEchoTool.execute(
      {},
      { name: "remote-flow", project_root: CLIENT_ROOT, message: "one" }
    );
    const second = await flowInsertEchoTool.execute(
      {},
      { name: "remote-flow", project_root: CLIENT_ROOT, message: "two" }
    );

    expect(first.stepCount).toBe(1);
    expect(second.stepCount).toBe(2);
    expect(first).not.toHaveProperty("flowFile");
    expect(second).not.toHaveProperty("flowFile");
  });

  it("returns a `recorded` line in client mode that matches the YAML the client writes", async () => {
    // `recorded` was only ever covered on the host branch. Client mode counts
    // and serializes off a different branch of appendStepToFlow (the in-memory
    // flow, not a re-read file), so the line and the count could drift from the
    // bytes the client is told to write without anything noticing. The
    // directive carries those bytes, so it is the assertion surface here — this
    // host has no file to read back.
    const registry = createMockRegistry({
      "restart-app": { result: { restarted: true } },
      "tap": { result: { tapped: true } },
    });
    const addStep = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute(
      {},
      { name: "remote-flow", project_root: CLIENT_ROOT },
      remoteCtx()
    );
    const launched = await addStep.execute(
      {},
      {
        name: "remote-flow",
        project_root: CLIENT_ROOT,
        command: "restart-app",
        args: '{"udid":"ABC","bundleId":"com.acme.app"}',
      },
      remoteCtx()
    );
    const tapped = await addStep.execute(
      {},
      {
        name: "remote-flow",
        project_root: CLIENT_ROOT,
        command: "tap",
        args: '{"x":0.5,"y":0.3}',
      },
      remoteCtx()
    );

    expect(launched.recorded).toBe("1. launch: com.acme.app");
    expect(tapped.recorded).toBe('2. tool: tap {"x":0.5,"y":0.3}');
    expect(tapped.stepCount).toBe(2);

    // Every `recorded` line, replayed against the file the client actually
    // gets, is the same rendering finish-recording would produce.
    const directive = tapped.savedTo as { path: string; content: string };
    expect(directive.path).toBe(CLIENT_FLOW_PATH);
    expect(parseFlow(directive.content).steps.map((s, i) => summarizeStep(s, i + 1))).toEqual([
      launched.recorded,
      tapped.recorded,
    ]);
  });

  it("a rejected append leaves the session usable instead of poisoning it", async () => {
    // In client mode the in-memory flow is the ONLY copy, so a step the append
    // refuses must not stay in it — every later append, and the finish itself,
    // would re-hit the same error with no way to recover. Both gates are
    // exercised: serializeFlow (an unrepresentable step) and validateFlow (a
    // cross-field violation).
    const registry = createMockRegistry({
      "gesture-tap": { result: { tapped: true } },
      "restart-app": { result: { restarted: true } },
    });
    const addStep = createFlowAddStepTool(registry);
    const device = "00000000-0000-0000-0000-0000000000ab";

    await flowStartRecordingTool.execute(
      {},
      { name: "remote-flow", project_root: CLIENT_ROOT, executionPrerequisite: "Home" },
      remoteCtx()
    );
    await flowInsertEchoTool.execute(
      {},
      { name: "remote-flow", project_root: CLIENT_ROOT, message: "before" }
    );

    // serializeFlow rejects: a tap carrying pixel coordinates, not the
    // normalized 0–1 fractions a YAML gesture target can represent. (Selector
    // capture can't reach a device here, so the coordinates are kept as-is.)
    await expect(
      addStep.execute(
        {},
        {
          name: "remote-flow",
          project_root: CLIENT_ROOT,
          command: "gesture-tap",
          args: JSON.stringify({ udid: device, x: 250, y: 400 }),
        }
      )
    ).rejects.toThrow("not pixels");

    // validateFlow rejects: a `restart-app` is recorded as a `launch`, and this
    // recording declared an executionPrerequisite — a flow that begins by
    // launching controls its own start state and must not declare one.
    await expect(
      addStep.execute(
        {},
        {
          name: "remote-flow",
          project_root: CLIENT_ROOT,
          command: "restart-app",
          args: JSON.stringify({ udid: device, bundleId: "com.example.app" }),
        }
      )
    ).rejects.toThrow("must not declare executionPrerequisite");

    // The session survived both rejections: the next append succeeds, and its
    // directive carries only the accepted steps — neither rejected step is in
    // the flow, and neither error is replayed.
    const after = await flowInsertEchoTool.execute(
      {},
      { name: "remote-flow", project_root: CLIENT_ROOT, message: "after" }
    );
    const directive = after.savedTo as { path: string; content: string };
    expect(directive.path).toBe(CLIENT_FLOW_PATH);
    expect(parseFlow(directive.content).steps).toEqual([
      { kind: "echo", message: "before" },
      { kind: "echo", message: "after" },
    ]);
    expect(parseFlow(directive.content).executionPrerequisite).toBe("Home");

    // And the recording still finishes — the whole point of rolling back.
    const finished = await flowFinishRecordingTool.execute(
      {},
      { name: "remote-flow", project_root: CLIENT_ROOT }
    );
    expect(finished.steps).toBe(2);
    expect(finished.summary).toEqual(["1. echo: before", "2. echo: after"]);
    expect(finished.savedTo).toMatchObject({
      [CLIENT_FILE_MARKER]: true,
      path: CLIENT_FLOW_PATH,
    });
    await expect(fs.stat(CLIENT_ROOT)).rejects.toThrow();
  });

  it("keeps same-named recordings under different client roots isolated", async () => {
    const registry = createMockRegistry({ tap: { result: { tapped: true } } });
    const addStep = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute(
      {},
      { name: "remote-flow", project_root: CLIENT_ROOT, executionPrerequisite: "Home" },
      remoteCtx()
    );
    await flowStartRecordingTool.execute(
      {},
      { name: "remote-flow", project_root: OTHER_CLIENT_ROOT, executionPrerequisite: "Settings" },
      remoteCtx(OTHER_CLIENT_ROOT)
    );

    await flowInsertEchoTool.execute(
      {},
      { name: "remote-flow", project_root: CLIENT_ROOT, message: "first client" }
    );
    const otherStep = await addStep.execute(
      {},
      { name: "remote-flow", project_root: OTHER_CLIENT_ROOT, command: "tap", args: '{"x":0.5}' }
    );

    // Each directive names its OWN client's file and carries only that
    // recording's steps — the second agent's tap never joins the first's flow.
    const otherDirective = otherStep.savedTo as { path: string; content: string };
    expect(otherDirective.path).toBe(OTHER_CLIENT_FLOW_PATH);
    expect(parseFlow(otherDirective.content).steps).toEqual([
      { kind: "tool", name: "tap", args: { x: 0.5 } },
    ]);
    expect(parseFlow(otherDirective.content).executionPrerequisite).toBe("Settings");

    // Finishing one leaves the other live, with its own path and steps.
    const first = await flowFinishRecordingTool.execute(
      {},
      { name: "remote-flow", project_root: CLIENT_ROOT }
    );
    expect(first.path).toBe(CLIENT_FLOW_PATH);
    expect(first.summary).toEqual(["1. echo: first client"]);
    expect(first.savedTo).toMatchObject({
      [CLIENT_FILE_MARKER]: true,
      path: CLIENT_FLOW_PATH,
    });

    const other = await flowFinishRecordingTool.execute(
      {},
      { name: "remote-flow", project_root: OTHER_CLIENT_ROOT }
    );
    expect(other.path).toBe(OTHER_CLIENT_FLOW_PATH);
    expect(other.summary).toEqual(['1. tool: tap {"x":0.5}']);
    expect(other.savedTo).toMatchObject({
      [CLIENT_FILE_MARKER]: true,
      path: OTHER_CLIENT_FLOW_PATH,
    });

    // Neither client's directory layout was recreated on this host.
    await expect(fs.stat(CLIENT_ROOT)).rejects.toThrow();
    await expect(fs.stat(OTHER_CLIENT_ROOT)).rejects.toThrow();
  });
});

describe("flow replay with a boundary-resolved flow_file", () => {
  it("flow-execute reads the resolved path instead of deriving from project_root", async () => {
    // Simulates the server-side temp file the boundary materialized from the
    // client's upload.
    const uploaded = path.join(os.tmpdir(), `uploaded-flow-${Date.now()}.yaml`);
    await fs.writeFile(
      uploaded,
      ["executionPrerequisite: ''", "steps:", "  - echo: from upload", ""].join("\n")
    );
    try {
      const runFlow = createRunFlowTool(createMockRegistry());
      const result = await runFlow.execute(
        {},
        {
          name: "remote-flow",
          project_root: CLIENT_ROOT,
          flow_file: uploaded,
          device: "00000000-0000-0000-0000-0000000000ab",
        },
        uploadCtx()
      );
      expect(result).toMatchObject({
        flow: "remote-flow",
        steps: [{ kind: "echo", status: "pass", message: "from upload" }],
      });
    } finally {
      await fs.rm(uploaded, { force: true });
    }
  });

  it("flow-read-prerequisite reads the resolved path", async () => {
    const uploaded = path.join(os.tmpdir(), `uploaded-prereq-${Date.now()}.yaml`);
    await fs.writeFile(
      uploaded,
      ["executionPrerequisite: 'Device unlocked'", "steps: []", ""].join("\n")
    );
    try {
      const result = await flowReadPrerequisiteTool.execute(
        {},
        { name: "remote-flow", project_root: CLIENT_ROOT, flow_file: uploaded },
        uploadCtx()
      );
      expect(result.executionPrerequisite).toBe("Device unlocked");
    } finally {
      await fs.rm(uploaded, { force: true });
    }
  });
});

describe("flow replay with an explicit boundary-resolved flow_path", () => {
  it("advertises exactly one of name and flow_path as the flow source", () => {
    const runFlow = createRunFlowTool(createMockRegistry());

    expect(runFlow.inputSchema).toMatchObject({
      type: "object",
      properties: {
        name: { type: "string" },
        flow_path: { type: "string" },
      },
      oneOf: [{ required: ["name"] }, { required: ["flow_path"] }],
    });
  });

  it("states the absolute-path requirement in the flow_path description", () => {
    const runFlow = createRunFlowTool(createMockRegistry());

    // An agent reading only the schema is the caller that gets this wrong —
    // `argent flow list` hands it a relative path — so the requirement has to
    // be legible before the call, the way project_root's description states it.
    expect(runFlow.inputSchema).toMatchObject({
      properties: { flow_path: { description: expect.stringMatching(/absolute/i) } },
    });
  });

  it("documents both flow sources in the project_root description", () => {
    const runFlow = createRunFlowTool(createMockRegistry());

    // On the flow_path branch the flow, its run: siblings, and baselines all
    // resolve beside the YAML — project_root locates nothing there — so the
    // description must not promise `.argent/flows/<name>.yaml` lives under it
    // (`name` is exactly what that branch forbids).
    expect(runFlow.inputSchema).toMatchObject({
      properties: {
        project_root: {
          description: expect.stringMatching(/with flow_path.*beside the YAML/i),
        },
      },
    });
  });

  it("accepts a co-located path verified by the boundary and derives its logical name", async () => {
    const flowPath = path.join(os.tmpdir(), `external-flow-${Date.now()}.yaml`);
    await fs.writeFile(
      flowPath,
      ["executionPrerequisite: ''", "steps:", "  - echo: from explicit path", ""].join("\n")
    );
    try {
      const runFlow = createRunFlowTool(createMockRegistry());
      const result = await runFlow.execute(
        {},
        {
          project_root: CLIENT_ROOT,
          flow_path: flowPath,
          device: "00000000-0000-0000-0000-0000000000ab",
        },
        {
          artifacts: new ArtifactStore(),
          fileInputs: {
            flow_path: {
              clientPath: flowPath,
              presentOnHost: true,
              viaUpload: false,
              statVerified: true,
            },
          },
        }
      );

      expect(result).toMatchObject({
        flow: path.basename(flowPath, ".yaml"),
        steps: [{ kind: "echo", status: "pass", message: "from explicit path" }],
      });
    } finally {
      await fs.rm(flowPath, { force: true });
    }
  });

  it("rejects a raw unwrapped flow_path even when the file exists", async () => {
    const flowPath = path.join(os.tmpdir(), `raw-flow-${Date.now()}.yaml`);
    await fs.writeFile(flowPath, ["executionPrerequisite: ''", "steps: []", ""].join("\n"));
    try {
      const runFlow = createRunFlowTool(createMockRegistry());
      await expect(
        runFlow.execute(
          {},
          {
            project_root: CLIENT_ROOT,
            flow_path: flowPath,
            device: "00000000-0000-0000-0000-0000000000ab",
          }
        )
      ).rejects.toThrow("flow_path file-input boundary");
    } finally {
      await fs.rm(flowPath, { force: true });
    }
  });

  it("rejects boundary metadata for a different co-located path", async () => {
    const flowPath = path.join(os.tmpdir(), "selected.yaml");
    await expect(
      resolveFlowSource({ project_root: CLIENT_ROOT, flow_path: flowPath }, undefined, {
        clientPath: path.join(os.tmpdir(), "different.yaml"),
        presentOnHost: true,
        viaUpload: false,
        statVerified: true,
      })
    ).rejects.toThrow("flow_path file-input boundary");
  });

  it("rejects a relative flow_path without blaming the boundary it cleared", async () => {
    // The spelling `argent flow list` prints, in a fully legitimate wrapper:
    // the boundary resolved this path in place and matched the client stat, so
    // the only thing wrong with it is its shape.
    const flowPath = path.join(".argent", "flows", "relflow.yaml");
    const err = await resolveFlowSource(
      { project_root: CLIENT_ROOT, flow_path: flowPath },
      undefined,
      { clientPath: flowPath, presentOnHost: true, viaUpload: false, statVerified: true }
    ).then(
      () => null,
      (e: unknown) => e as Error
    );
    expect(err?.message).toContain("flow paths must be absolute");
    expect(err?.message).not.toContain("file-input boundary");
  });

  it('rejects a flow_path carrying ".." segments', async () => {
    // A fully legitimate wrapper — the host stat succeeds through the kernel,
    // which resolves any symlinked directory component before the "..". What
    // the gate has to stop is the lexical half: dirname keeps the raw string,
    // so run: siblings and __baselines__ would come from another directory.
    const flowPath = [os.tmpdir(), "link", "..", "selected.yaml"].join(path.sep);
    await expect(
      resolveFlowSource({ project_root: CLIENT_ROOT, flow_path: flowPath }, undefined, {
        clientPath: flowPath,
        presentOnHost: true,
        viaUpload: false,
        statVerified: true,
      })
    ).rejects.toThrow('must not contain ".." segments');
  });

  it.each([
    ["a bare basename", [os.tmpdir(), ".yaml"]],
    ["a bare basename under a directory", [os.tmpdir(), "nested", ".yaml"]],
    ["an uppercased bare basename", [os.tmpdir(), ".YAML"]],
  ])("names the missing stem, not the extension, for %s", async (_shape, segments) => {
    // path.extname calls these extensionless dotfiles, so the extension arm
    // would claim ".yaml" is missing from a path that ends in it. The CLI
    // names the empty stem for the same three shapes; so must this path.
    const flowPath = path.join(...segments);
    const err = await resolveFlowSource(
      { project_root: CLIENT_ROOT, flow_path: flowPath },
      undefined,
      { clientPath: flowPath, presentOnHost: true, viaUpload: false, statVerified: true }
    ).then(
      () => null,
      (e: unknown) => e as Error
    );
    expect(err?.message).toContain('Invalid flow name ""');
    expect(err?.message).not.toMatch(/must use the (lowercase )?\.yaml extension/);
  });

  it("still blames the extension when a non-empty stem carries the wrong case", async () => {
    // The companion to the case above: extname is non-empty here, so this input
    // must keep reaching the lowercase-extension arm.
    const flowPath = path.join(os.tmpdir(), "Checkout.YAML");
    await expect(
      resolveFlowSource({ project_root: CLIENT_ROOT, flow_path: flowPath }, undefined, {
        clientPath: flowPath,
        presentOnHost: true,
        viaUpload: false,
        statVerified: true,
      })
    ).rejects.toThrow('flow files must use the lowercase .yaml extension, not ".YAML"');
  });

  it("rejects a mis-cased basename the filesystem's stat vouched for, naming the on-disk spelling", async () => {
    // The boundary metadata here is exactly what a case-insensitive host
    // produces for the mis-cased spelling — its stat finds uppercase.yaml for
    // UpperCase.yaml, so statVerified holds. The gate must compare against the
    // readdir listing instead, which returns stored bytes on every platform,
    // making this deterministic on case-sensitive filesystems too: nothing
    // named "UpperCase" exists in either world.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-path-casing-"));
    try {
      await fs.writeFile(path.join(dir, "uppercase.yaml"), "steps: []\n", "utf8");
      const flowPath = path.join(dir, "UpperCase.yaml");
      const err = await resolveFlowSource(
        { project_root: CLIENT_ROOT, flow_path: flowPath },
        undefined,
        { clientPath: flowPath, presentOnHost: true, viaUpload: false, statVerified: true }
      ).then(
        () => null,
        (e: unknown) => e as Error
      );
      // The refusal must name the phantom spelling, the real directory entry,
      // and the stake (the flow name keys the report and __baselines__/), then
      // hand back the runnable on-disk spelling.
      expect(err?.message).toContain(
        'matched "UpperCase.yaml" case-insensitively to "uppercase.yaml"'
      );
      expect(err?.message).toContain("__baselines__");
      expect(err?.message).toContain('Pass flow_path with the on-disk basename "uppercase.yaml"');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("suggests a rename when the on-disk sibling's own extension case is unrunnable", async () => {
    // The other recovery fork: checkout.YAML is what the name really is, but
    // passing it as flow_path would trip the lowercase-extension arm — so the
    // message must ask for a rename, not point at a spelling this same ladder
    // refuses.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-path-casing-"));
    try {
      await fs.writeFile(path.join(dir, "checkout.YAML"), "steps: []\n", "utf8");
      const flowPath = path.join(dir, "checkout.yaml");
      const err = await resolveFlowSource(
        { project_root: CLIENT_ROOT, flow_path: flowPath },
        undefined,
        { clientPath: flowPath, presentOnHost: true, viaUpload: false, statVerified: true }
      ).then(
        () => null,
        (e: unknown) => e as Error
      );
      expect(err?.message).toContain(
        'matched "checkout.yaml" case-insensitively to "checkout.YAML"'
      );
      expect(err?.message).toContain(
        'Rename "checkout.YAML" to "checkout.yaml" to run it — flow files must be lowercase .yaml.'
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts the exact on-disk spelling, mixed case included, and derives its stem", async () => {
    // Byte-for-byte is the contract — not lowercasing: a flow really named
    // MixedCase.yaml runs under exactly that name.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-path-casing-"));
    try {
      const flowPath = path.join(dir, "MixedCase.yaml");
      await fs.writeFile(flowPath, "steps: []\n", "utf8");
      await expect(
        resolveFlowSource({ project_root: CLIENT_ROOT, flow_path: flowPath }, undefined, {
          clientPath: flowPath,
          presentOnHost: true,
          viaUpload: false,
          statVerified: true,
        })
      ).resolves.toEqual({ filePath: flowPath, flowName: "MixedCase", viaUpload: false });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("skips the casing check when the parent directory's listing is unavailable", async () => {
    // An execute-only parent directory lets stat through while refusing the
    // listing — the boundary evidence may be vouching for a genuinely
    // exact-named file, so an unreadable (here: nonexistent) parent must not
    // itself reject. Resolution succeeds and the later file read is what
    // reports absence.
    const flowPath = path.join(
      os.tmpdir(),
      "flow-path-casing-no-such-parent",
      "flows",
      "present.yaml"
    );
    await expect(
      resolveFlowSource({ project_root: CLIENT_ROOT, flow_path: flowPath }, undefined, {
        clientPath: flowPath,
        presentOnHost: true,
        viaUpload: false,
        statVerified: true,
      })
    ).resolves.toEqual({ filePath: flowPath, flowName: "present", viaUpload: false });
  });

  it("rejects presence-only metadata without the client-stat match (statVerified)", async () => {
    // The shape a forged stat-less wrapper produces: the server's own stat
    // succeeded, but nothing tied the caller to the file's client-side stat.
    const flowPath = path.join(os.tmpdir(), "forged.yaml");
    await expect(
      resolveFlowSource({ project_root: CLIENT_ROOT, flow_path: flowPath }, undefined, {
        clientPath: flowPath,
        presentOnHost: true,
        viaUpload: false,
      })
    ).rejects.toThrow("flow_path file-input boundary");
  });

  it("rejects an uploaded flow_path because its sibling filesystem is unavailable", async () => {
    const uploaded = path.join(os.tmpdir(), "argent-file-input-abc", "materialized.yaml");
    await expect(
      resolveFlowSource({ project_root: CLIENT_ROOT, flow_path: uploaded }, undefined, {
        clientPath: path.join(CLIENT_ROOT, "flows", "caller-visible.yaml"),
        presentOnHost: false,
        viaUpload: true,
      })
    ).rejects.toThrow("explicit flow paths require a co-located client and tool server");
  });

  it("rejects direct callers that provide both flow sources", async () => {
    await expect(
      resolveFlowSource(
        { name: "saved", project_root: CLIENT_ROOT, flow_path: "/tmp/explicit.yaml" },
        undefined,
        { clientPath: "/tmp/explicit.yaml", presentOnHost: true, viaUpload: false }
      )
    ).rejects.toThrow("exactly one flow source");
  });

  it("rejects direct callers that provide neither flow source", async () => {
    await expect(resolveFlowSource({ project_root: CLIENT_ROOT })).rejects.toThrow(
      "exactly one flow source"
    );
  });
});

describe("flow_file containment", () => {
  const params = (flow_file: string) => ({
    name: "remote-flow",
    project_root: CLIENT_ROOT,
    flow_file,
  });

  it("accepts the exact ${project_root}/.argent/flows/${name}.yaml path", async () => {
    expect((await resolveFlowSource(params(CLIENT_FLOW_PATH))).filePath).toBe(CLIENT_FLOW_PATH);
  });

  it("accepts a boundary-materialized upload wherever the server put it", async () => {
    const uploaded = path.join(os.tmpdir(), "argent-file-input-abc", "remote-flow.yaml");
    expect(
      (
        await resolveFlowSource(params(uploaded), {
          clientPath: CLIENT_FLOW_PATH,
          presentOnHost: false,
          viaUpload: true,
        })
      ).filePath
    ).toBe(uploaded);
  });

  it("exempts an upload, and ONLY an upload, from containment", async () => {
    // The exemption keys on `viaUpload`, not on the mere presence of a file
    // input — but nothing pinned that discrimination: every containment case
    // above passes `fileInput: undefined`, and the one case that supplies one
    // uses `viaUpload: true`. So relaxing the guard to
    //
    //   if (fileInput?.viaUpload)   ->   if (fileInput)
    //
    // left the whole suite green while opening the containment bypass to the
    // COMMON shape: `resolveOne` returns `viaUpload: false` for any wire path
    // that already exists on the host, i.e. every same-machine `flow-execute`
    // carrying a `flow_file`.
    const hostPath = { clientPath: CLIENT_FLOW_PATH, presentOnHost: true, viaUpload: false };

    await expect(resolveFlowSource(params("/etc/anything.yaml"), hostPath)).rejects.toThrow(
      "Invalid flow_file"
    );
    // The same input with the upload flag set is the trusted case, and must
    // still pass — otherwise this test would also hold for a guard that simply
    // ignored `fileInput` altogether.
    expect(
      (await resolveFlowSource(params("/etc/anything.yaml"), { ...hostPath, viaUpload: true }))
        .filePath
    ).toBe("/etc/anything.yaml");
  });

  it("rejects a relative flow_file", async () => {
    await expect(resolveFlowSource(params(".argent/flows/remote-flow.yaml"))).rejects.toThrow(
      "Invalid flow_file"
    );
  });

  it('rejects ".." traversal even when it resolves back to the flows dir', async () => {
    // Raw concatenation — path.join would collapse the ".." before the check.
    const sneaky = `${CLIENT_ROOT}/.argent/flows/../flows/remote-flow.yaml`;
    await expect(resolveFlowSource(params(sneaky))).rejects.toThrow("Invalid flow_file");
  });

  it("rejects an absolute path outside the project's flows dir", async () => {
    await expect(resolveFlowSource(params("/etc/anything.yaml"))).rejects.toThrow(
      "Invalid flow_file"
    );
    // A different flow's file under the right dir is not this flow's path either.
    await expect(
      resolveFlowSource(params(path.join(CLIENT_ROOT, ".argent", "flows", "other.yaml")))
    ).rejects.toThrow("Invalid flow_file");
  });

  it("flow-execute refuses an out-of-project flow_file without reading it", async () => {
    const runFlow = createRunFlowTool(createMockRegistry());
    await expect(
      runFlow.execute(
        {},
        {
          name: "remote-flow",
          project_root: CLIENT_ROOT,
          flow_file: "/etc/anything.yaml",
          device: "00000000-0000-0000-0000-0000000000ab",
        }
      )
    ).rejects.toThrow("Invalid flow_file");
  });
});

/**
 * The concurrency contract, exercised in CLIENT mode. The two mechanisms cross
 * here: the session key is a path that does not exist on this host, and the
 * authoritative flow content is the in-memory copy rather than the file. The
 * host-mode suite (flow-concurrent-recording.test.ts) cannot reach either.
 */
describe("concurrent recordings against a remote client", () => {
  it("keeps genuinely overlapping remote appends complete and ordered", async () => {
    // The overlap has to come from flow-add-step's LIVE sub-tool call, which is
    // the only await in the client-mode path: once past it, push → validate →
    // serialize runs synchronously, so echoes alone can never interleave and
    // would prove nothing. Each sub-tool call parks until all of them have
    // arrived, so every append is in flight simultaneously before any completes.
    const arrived: (() => void)[] = [];
    const allArrived = new Promise<void>((resolve) => {
      arrived.push(resolve);
    });
    let seen = 0;
    const registry = {
      invokeTool: vi.fn(async () => {
        if (++seen === 6) arrived[0]();
        await allArrived;
        return { tapped: true };
      }),
      getTool: vi.fn(() => undefined),
    } as unknown as Registry;
    const addStep = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute(
      {},
      { name: "remote-flow", project_root: CLIENT_ROOT },
      remoteCtx()
    );

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        addStep.execute(
          {},
          { name: "remote-flow", project_root: CLIENT_ROOT, command: "tap", args: `{"x":0.${i}}` }
        )
      )
    );

    // The last directive to be produced carries the full flow. Every one of the
    // six steps must be in it exactly once — in client mode the in-memory copy
    // is the ONLY copy, so a lost update is unrecoverable.
    const contents = results.map((r) => {
      const directive = r.savedTo as { [CLIENT_FILE_MARKER]: true; content: string };
      expect(directive[CLIENT_FILE_MARKER]).toBe(true);
      return parseFlow(directive.content).steps;
    });
    const fullest = contents.reduce((a, b) => (b.length > a.length ? b : a));
    expect(fullest).toHaveLength(6);
    const xs = fullest.map((s) => (s.kind === "tool" ? String(s.args.x) : "?"));
    expect(new Set(xs).size).toBe(6);
    // Each append saw a strictly larger flow than the one before it.
    expect(contents.map((c) => c.length).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("starts the remote take over on a restart, discarding the previous one and writing nothing to this host", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "remote-flow", project_root: CLIENT_ROOT },
      remoteCtx()
    );
    await flowInsertEchoTool.execute(
      {},
      { name: "remote-flow", project_root: CLIENT_ROOT, message: "first take" }
    );

    // A second agent takes the same key on the same client project.
    const restarted = await flowStartRecordingTool.execute(
      {},
      { name: "remote-flow", project_root: CLIENT_ROOT },
      remoteCtx()
    );
    expect(restarted).toMatchObject({ restarted: true, discardedSteps: 1 });
    // The reset is the client's to perform, so the message must not assert it
    // as done here — nothing on this host was touched.
    expect((restarted as { message: string }).message).toContain("once your client applies");

    // The new take is empty and usable; the discarded take's content is gone.
    const after = await flowInsertEchoTool.execute(
      {},
      { name: "remote-flow", project_root: CLIENT_ROOT, message: "second take" }
    );
    const directive = after.savedTo as { content: string };
    const flow = parseFlow(directive.content);
    expect(flow.steps).toHaveLength(1);
    expect(flow.steps[0]).toMatchObject({ kind: "echo", message: "second take" });

    // Still nothing on this host: the client's root was never created here.
    await expect(fs.stat(CLIENT_ROOT)).rejects.toThrow();
  });

  it("rejects a remote append that was already in flight when the restart landed", async () => {
    // The case above restarts BETWEEN calls, so the next append re-resolves the
    // key and legitimately gets the new session — the supersede guard is never
    // reached. Reaching it needs an append that resolved its session before the
    // restart and lands after, and in client mode the live sub-tool call is the
    // only await that can hold one open across it: past that point the client
    // path (push → validate → serialize) runs to completion synchronously.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrive!: () => void;
    const reached = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const registry = {
      invokeTool: vi.fn(async () => {
        arrive();
        await held;
        return { tapped: true };
      }),
      getTool: vi.fn(() => undefined),
    } as unknown as Registry;
    const addStep = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute(
      {},
      { name: "remote-flow", project_root: CLIENT_ROOT },
      remoteCtx()
    );

    const inFlight = addStep.execute(
      {},
      { name: "remote-flow", project_root: CLIENT_ROOT, command: "tap", args: '{"x":0.5}' }
    );
    await reached; // parked in the live step, session already resolved

    const restarted = await flowStartRecordingTool.execute(
      {},
      { name: "remote-flow", project_root: CLIENT_ROOT },
      remoteCtx()
    );
    expect(restarted).toMatchObject({ restarted: true });

    release();
    let caught: unknown;
    try {
      await inFlight;
      throw new Error("expected the superseded append to fail");
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toMatch(/no longer active/);
    expect(getFailureSignal(caught)?.error_code).toBe(FAILURE_CODES.FLOW_NO_ACTIVE_RECORDING);

    // The step ran on the device but never entered the new take, and the client
    // is told so — in client mode the in-memory copy is the only copy, so a
    // superseded step landing in it would be unrecoverable.
    const after = await flowInsertEchoTool.execute(
      {},
      { name: "remote-flow", project_root: CLIENT_ROOT, message: "second take" }
    );
    const flow = parseFlow((after.savedTo as { content: string }).content);
    expect(flow.steps).toHaveLength(1);
    expect(flow.steps[0]).toMatchObject({ kind: "echo", message: "second take" });

    await expect(fs.stat(CLIENT_ROOT)).rejects.toThrow();
  });
});
