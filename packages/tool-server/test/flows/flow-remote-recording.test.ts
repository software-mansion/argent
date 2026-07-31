import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry, ToolContext } from "@argent/registry";
import { ArtifactStore, CLIENT_FILE_MARKER } from "@argent/registry";

import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import { flowInsertEchoTool } from "../../src/tools/flows/flow-insert-echo";
import { flowFinishRecordingTool } from "../../src/tools/flows/flow-finish-recording";
import { createFlowAddStepTool } from "../../src/tools/flows/flow-add-step";
import {
  createRunFlowTool,
  resolveFlowFilePath,
  resolveFlowSource,
} from "../../src/tools/flows/flow-run";
import { flowReadPrerequisiteTool } from "../../src/tools/flows/flow-read-prerequisite";
import {
  clearActiveFlow,
  clearActiveProjectRoot,
  parseFlow,
} from "../../src/tools/flows/flow-utils";

/**
 * Remote-mode flow behavior: the agent's project_root does NOT exist on this
 * host (the boundary probe says presentOnHost: false), so recording stays in
 * memory and every mutating tool returns a client-write directive instead of
 * touching this host's disk.
 */

// A path that exists on the (simulated) client but not on this "server".
const CLIENT_ROOT = path.join(os.tmpdir(), "definitely-not-on-this-host", "agent-project");
const CLIENT_FLOW_PATH = path.join(CLIENT_ROOT, ".argent", "flows", "remote-flow.yaml");

function remoteCtx(): ToolContext {
  return {
    artifacts: new ArtifactStore(),
    fileInputs: {
      project_root: { clientPath: CLIENT_ROOT, presentOnHost: false, viaUpload: false },
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
  clearActiveFlow();
});

afterEach(async () => {
  clearActiveFlow();
  clearActiveProjectRoot();
  await fs.rm(CLIENT_ROOT, { recursive: true, force: true });
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

    await flowInsertEchoTool.execute({}, { message: "label" });
    const stepResult = await addStep.execute({}, { command: "tap", args: '{"x":0.5}' });

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
        command: "flow-execute",
        args: JSON.stringify({ name: "sub", project_root: CLIENT_ROOT, device: "RECORD-TIME-ID" }),
      }
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
    await flowInsertEchoTool.execute({}, { message: "only step" });

    const result = await flowFinishRecordingTool.execute({}, {});

    expect(result.steps).toBe(1);
    expect(result.summary).toEqual(["1. echo: only step"]);
    expect(result.path).toBe(CLIENT_FLOW_PATH);
    expect(result.savedTo).toMatchObject({ [CLIENT_FILE_MARKER]: true });

    await expect(flowFinishRecordingTool.execute({}, {})).rejects.toThrow("No active flow");
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

  it("rejects boundary metadata for a different co-located path", () => {
    const flowPath = path.join(os.tmpdir(), "selected.yaml");
    expect(() =>
      resolveFlowSource({ project_root: CLIENT_ROOT, flow_path: flowPath }, undefined, {
        clientPath: path.join(os.tmpdir(), "different.yaml"),
        presentOnHost: true,
        viaUpload: false,
        statVerified: true,
      })
    ).toThrow("flow_path file-input boundary");
  });

  it("rejects a relative flow_path without blaming the boundary it cleared", () => {
    // The spelling `argent flow list` prints, in a fully legitimate wrapper:
    // the boundary resolved this path in place and matched the client stat, so
    // the only thing wrong with it is its shape.
    const flowPath = path.join(".argent", "flows", "relflow.yaml");
    const resolve = () =>
      resolveFlowSource({ project_root: CLIENT_ROOT, flow_path: flowPath }, undefined, {
        clientPath: flowPath,
        presentOnHost: true,
        viaUpload: false,
        statVerified: true,
      });
    expect(resolve).toThrow("flow paths must be absolute");
    expect(resolve).not.toThrow("file-input boundary");
  });

  it('rejects a flow_path carrying ".." segments', () => {
    // A fully legitimate wrapper — the host stat succeeds through the kernel,
    // which resolves any symlinked directory component before the "..". What
    // the gate has to stop is the lexical half: dirname keeps the raw string,
    // so run: siblings and __baselines__ would come from another directory.
    const flowPath = [os.tmpdir(), "link", "..", "selected.yaml"].join(path.sep);
    expect(() =>
      resolveFlowSource({ project_root: CLIENT_ROOT, flow_path: flowPath }, undefined, {
        clientPath: flowPath,
        presentOnHost: true,
        viaUpload: false,
        statVerified: true,
      })
    ).toThrow('must not contain ".." segments');
  });

  it.each([
    ["a bare basename", [os.tmpdir(), ".yaml"]],
    ["a bare basename under a directory", [os.tmpdir(), "nested", ".yaml"]],
    ["an uppercased bare basename", [os.tmpdir(), ".YAML"]],
  ])("names the missing stem, not the extension, for %s", (_shape, segments) => {
    // path.extname calls these extensionless dotfiles, so the extension arm
    // would claim ".yaml" is missing from a path that ends in it. The CLI
    // names the empty stem for the same three shapes; so must this path.
    const flowPath = path.join(...segments);
    const resolve = () =>
      resolveFlowSource({ project_root: CLIENT_ROOT, flow_path: flowPath }, undefined, {
        clientPath: flowPath,
        presentOnHost: true,
        viaUpload: false,
        statVerified: true,
      });
    expect(resolve).toThrow('Invalid flow name ""');
    expect(resolve).not.toThrow(/must use the (lowercase )?\.yaml extension/);
  });

  it("still blames the extension when a non-empty stem carries the wrong case", () => {
    // The companion to the case above: extname is non-empty here, so this input
    // must keep reaching the lowercase-extension arm.
    const flowPath = path.join(os.tmpdir(), "Checkout.YAML");
    expect(() =>
      resolveFlowSource({ project_root: CLIENT_ROOT, flow_path: flowPath }, undefined, {
        clientPath: flowPath,
        presentOnHost: true,
        viaUpload: false,
        statVerified: true,
      })
    ).toThrow('flow files must use the lowercase .yaml extension, not ".YAML"');
  });

  it("rejects presence-only metadata without the client-stat match (statVerified)", () => {
    // The shape a forged stat-less wrapper produces: the server's own stat
    // succeeded, but nothing tied the caller to the file's client-side stat.
    const flowPath = path.join(os.tmpdir(), "forged.yaml");
    expect(() =>
      resolveFlowSource({ project_root: CLIENT_ROOT, flow_path: flowPath }, undefined, {
        clientPath: flowPath,
        presentOnHost: true,
        viaUpload: false,
      })
    ).toThrow("flow_path file-input boundary");
  });

  it("rejects an uploaded flow_path because its sibling filesystem is unavailable", () => {
    const uploaded = path.join(os.tmpdir(), "argent-file-input-abc", "materialized.yaml");
    expect(() =>
      resolveFlowSource({ project_root: CLIENT_ROOT, flow_path: uploaded }, undefined, {
        clientPath: path.join(CLIENT_ROOT, "flows", "caller-visible.yaml"),
        presentOnHost: false,
        viaUpload: true,
      })
    ).toThrow("explicit flow paths require a co-located client and tool server");
  });

  it("rejects direct callers that provide both flow sources", () => {
    expect(() =>
      resolveFlowSource(
        { name: "saved", project_root: CLIENT_ROOT, flow_path: "/tmp/explicit.yaml" },
        undefined,
        { clientPath: "/tmp/explicit.yaml", presentOnHost: true, viaUpload: false }
      )
    ).toThrow("exactly one flow source");
  });

  it("rejects direct callers that provide neither flow source", () => {
    expect(() => resolveFlowSource({ project_root: CLIENT_ROOT })).toThrow(
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

  it("accepts the exact ${project_root}/.argent/flows/${name}.yaml path", () => {
    expect(resolveFlowFilePath(params(CLIENT_FLOW_PATH))).toBe(CLIENT_FLOW_PATH);
  });

  it("accepts a boundary-materialized upload wherever the server put it", () => {
    const uploaded = path.join(os.tmpdir(), "argent-file-input-abc", "remote-flow.yaml");
    expect(
      resolveFlowFilePath(params(uploaded), {
        clientPath: CLIENT_FLOW_PATH,
        presentOnHost: false,
        viaUpload: true,
      })
    ).toBe(uploaded);
  });

  it("rejects a relative flow_file", () => {
    expect(() => resolveFlowFilePath(params(".argent/flows/remote-flow.yaml"))).toThrow(
      "Invalid flow_file"
    );
  });

  it('rejects ".." traversal even when it resolves back to the flows dir', () => {
    // Raw concatenation — path.join would collapse the ".." before the check.
    const sneaky = `${CLIENT_ROOT}/.argent/flows/../flows/remote-flow.yaml`;
    expect(() => resolveFlowFilePath(params(sneaky))).toThrow("Invalid flow_file");
  });

  it("rejects an absolute path outside the project's flows dir", () => {
    expect(() => resolveFlowFilePath(params("/etc/anything.yaml"))).toThrow("Invalid flow_file");
    // A different flow's file under the right dir is not this flow's path either.
    expect(() =>
      resolveFlowFilePath(params(path.join(CLIENT_ROOT, ".argent", "flows", "other.yaml")))
    ).toThrow("Invalid flow_file");
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
