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
import { createRunFlowTool, resolveFlowFilePath } from "../../src/tools/flows/flow-run";
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
