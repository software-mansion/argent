import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import supertest from "supertest";
import * as fs from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { PNG } from "pngjs";
import { ArtifactStore, type Registry, type ToolContext } from "@argent/registry";
import { createHttpApp, type HttpAppHandle } from "../src/http";
import { createFlowAddStepTool } from "../src/tools/flows/flow-add-step";
import { createRunFlowTool, type FlowRunResult } from "../src/tools/flows/flow-run";
import { flowReadPrerequisiteTool } from "../src/tools/flows/flow-read-prerequisite";
import { flowStartRecordingTool } from "../src/tools/flows/flow-start-recording";
import { parseFlow, serializeFlow } from "../src/tools/flows/flow-utils";
import { redirectTmpdir } from "./helpers/tmpdir-env";

vi.mock("../src/utils/update-checker", () => ({
  getUpdateState: vi.fn(() => ({ updateInstallable: false, currentVersion: "1.0.0" })),
  isUpdateNoteSuppressed: vi.fn(() => true),
  suppressUpdateNote: vi.fn(),
}));

// The step registry serves no describe tree, so a snapshot's settle would poll to its deadline.
vi.mock("../src/tools/flows/flow-actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/tools/flows/flow-actions")>()),
  settleTree: vi.fn(async () => ({})),
}));

const DEVICE = "00000000-0000-0000-0000-0000000000ab";

/** A step tool that declares `image` as a file input; `label` is a plain string. */
const READ_FILE_TOOL = {
  id: "read-file",
  inputSchema: { type: "object", properties: { image: {}, label: {} } },
  fileInputs: [{ target: "image", path: "${image}", kind: "file" }],
};

/**
 * The registry flow-execute dispatches its steps through — never the flow
 * source. A `tool: flow-execute` step runs the real tool over it, so a nested
 * run gets the device bound into its args as a registry would.
 */
function stepRegistry(): Registry {
  const registry = {
    invokeTool: vi.fn(async (id: string, args: { image?: string }, opts?: object) => {
      if (id === "list-devices") return { devices: [] };
      if (id === "screenshot") return { image: { hostPath: path.join(tmpDir, "capture.png") } };
      if (id === "read-file") return { read: await fs.readFile(args.image!, "base64") };
      if (id === "flow-execute") {
        return nested.execute({}, args as never, { artifacts: new ArtifactStore(), ...opts });
      }
      return { ok: true };
    }),
    getTool: vi.fn((id: string) =>
      id === READ_FILE_TOOL.id ? READ_FILE_TOOL : id === "flow-execute" ? nested : undefined
    ),
    resolveService: vi.fn(async () => ({
      isConnected: () => true,
      listConnectedBundleIds: () => [],
    })),
  } as unknown as Registry;
  const nested = {
    ...createRunFlowTool(registry),
    inputSchema: { type: "object", properties: { device: {} } },
  };
  return registry;
}

/**
 * A registry exposing the REAL flow-execute and flow-read-prerequisite tools,
 * so a POST exercises the whole chain a forged wrapper must traverse: HTTP
 * file-input resolution → resolveFlowSource's boundary gate → step dispatch /
 * prerequisite read. Both tools are here because they share the pre-flight
 * contract: the file this suite proves flow-execute runs must be the one
 * flow-read-prerequisite answers about.
 */
function httpRegistry(steps: Registry): Registry {
  const tools: Record<
    string,
    | ReturnType<typeof createRunFlowTool | typeof createFlowAddStepTool>
    | typeof flowReadPrerequisiteTool
    | typeof flowStartRecordingTool
  > = {
    "flow-execute": createRunFlowTool(steps),
    "flow-read-prerequisite": flowReadPrerequisiteTool,
    "flow-start-recording": flowStartRecordingTool,
    "flow-add-step": createFlowAddStepTool(steps),
  };
  return {
    // GET /tools lists the step tools too, as one real registry does.
    getSnapshot: vi.fn(() => ({
      services: new Map(),
      namespaces: [],
      tools: [...Object.keys(tools), READ_FILE_TOOL.id],
    })),
    getTool: vi.fn((id: string) => tools[id] ?? steps.getTool(id)),
    invokeTool: vi.fn(async (id: string, args: unknown, opts?: Partial<ToolContext>) => {
      const tool = tools[id];
      if (!tool) throw new Error(`unexpected tool "${id}"`);
      return tool.execute({}, args as never, {
        artifacts: new ArtifactStore(),
        ...opts,
      });
    }),
  } as unknown as Registry;
}

let tmpDir: string;
let projectRoot: string;
let flowPath: string;
let steps: Registry;
let handle: HttpAppHandle;
let originalToken: string | undefined;

beforeEach(async () => {
  originalToken = process.env.ARGENT_AUTH_TOKEN;
  delete process.env.ARGENT_AUTH_TOKEN; // dev mode — auth is covered elsewhere
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "http-flow-path-test-"));
  // The YAML sits outside the declared project root — the reach a forged
  // wrapper would gain over the name/flow_file branch's containment.
  projectRoot = path.join(tmpDir, "project");
  await fs.mkdir(projectRoot);
  flowPath = path.join(tmpDir, "out-of-project.yaml");
  await fs.writeFile(
    flowPath,
    serializeFlow({
      executionPrerequisite: "",
      steps: [
        { kind: "echo", message: "over the boundary" },
        { kind: "tool", name: "tap", args: { x: 0.5, y: 0.5 } },
      ],
    }),
    "utf8"
  );
  steps = stepRegistry();
  handle = createHttpApp(httpRegistry(steps));
});

afterEach(async () => {
  handle?.dispose();
  await fs.rm(tmpDir, { recursive: true, force: true });
  if (originalToken === undefined) delete process.env.ARGENT_AUTH_TOKEN;
  else process.env.ARGENT_AUTH_TOKEN = originalToken;
});

describe("flow-execute flow_path over HTTP", () => {
  it("rejects a hand-crafted stat-less wrapper without executing the YAML", async () => {
    const res = await supertest(handle.app)
      .post("/tools/flow-execute")
      .send({
        project_root: projectRoot,
        device: DEVICE,
        flow_path: { __argentFileInput: true, path: flowPath },
      });

    // The server's own stat succeeds (presentOnHost), but no client stat was
    // matched — the gate must refuse before any step dispatches.
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/flow_path file-input boundary/);
    expect(steps.invokeTool).not.toHaveBeenCalled();
  });

  it("rejects a size-only wrapper without executing the YAML", async () => {
    const st = await fs.stat(flowPath);
    const res = await supertest(handle.app)
      .post("/tools/flow-execute")
      .send({
        project_root: projectRoot,
        device: DEVICE,
        flow_path: { __argentFileInput: true, path: flowPath, size: st.size },
      });

    // The size is the real file's, so the wrapper resolves in place — but a
    // size is knowable without ever having statted the file, so half the
    // client stat must not clear the boundary the stat-less wrapper cannot.
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/flow_path file-input boundary/);
    expect(steps.invokeTool).not.toHaveBeenCalled();
  });

  it("rejects an mtime-only wrapper without executing the YAML", async () => {
    const st = await fs.stat(flowPath);
    const res = await supertest(handle.app)
      .post("/tools/flow-execute")
      .send({
        project_root: projectRoot,
        device: DEVICE,
        flow_path: { __argentFileInput: true, path: flowPath, mtimeMs: st.mtimeMs },
      });

    // The mirror-image half: a matching mtime with no size on the wire is
    // still not the both-fields evidence statVerified stands for.
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/flow_path file-input boundary/);
    expect(steps.invokeTool).not.toHaveBeenCalled();
  });

  it("rejects a relative flow_path without blaming the boundary it cleared", async () => {
    // The spelling `argent flow list` prints. Running the server from the
    // flow's own directory is what makes this wrapper legitimate: it stats the
    // relative path against this process's cwd, finds the file, and matches the
    // client-recorded stat — presentOnHost and statVerified both hold, so the
    // rejection must name the path's shape rather than the boundary.
    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const relPath = path.basename(flowPath);
      const st = await fs.stat(relPath);
      const res = await supertest(handle.app)
        .post("/tools/flow-execute")
        .send({
          project_root: projectRoot,
          device: DEVICE,
          flow_path: { __argentFileInput: true, path: relPath, size: st.size, mtimeMs: st.mtimeMs },
        });

      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/must be absolute/);
      expect(res.body.error).not.toMatch(/file-input boundary/);
      expect(steps.invokeTool).not.toHaveBeenCalled();
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("still validates project_root on the flow_path branch", async () => {
    // `getFlowPath` validates the root, but only the `name` branch reaches it.
    // Deleting `setActiveProjectRoot` — which ran unconditionally, ahead of
    // both branches — left this branch with no check at all, so a relative or
    // ".."-bearing root sailed through. Nothing reads project_root here today,
    // which is exactly why the guardrail has to be pinned rather than assumed.
    const st = await fs.stat(flowPath);
    const wrapper = {
      __argentFileInput: true,
      path: flowPath,
      size: st.size,
      mtimeMs: st.mtimeMs,
    };

    for (const [root, expected] of [
      ["relative/root", /project_root must be an absolute path/],
      [`${projectRoot}/../elsewhere`, /must not contain "\.\." segments/],
    ] as const) {
      const res = await supertest(handle.app)
        .post("/tools/flow-execute")
        .send({ project_root: root, device: DEVICE, flow_path: wrapper });

      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(expected);
      expect(res.body.error_code).toBe("FLOW_PROJECT_ROOT_INVALID");
      expect(steps.invokeTool).not.toHaveBeenCalled();
    }
  });

  it('rejects a ".." flow_path whose kernel and lexical resolutions disagree', async () => {
    // <tmp>/link -> <tmp>/deep/inner, so the kernel reads <tmp>/deep/flow.yaml
    // while path.dirname keeps "<tmp>/link/.." and path.join collapses it to
    // <tmp> — the run: sibling and __baselines__ would come from the wrong
    // directory. Both siblings exist so the two resolutions are distinguishable.
    await fs.mkdir(path.join(tmpDir, "deep", "inner"), { recursive: true });
    await fs.symlink(path.join(tmpDir, "deep", "inner"), path.join(tmpDir, "link"));
    await fs.writeFile(
      path.join(tmpDir, "deep", "flow.yaml"),
      serializeFlow({ executionPrerequisite: "", steps: [{ kind: "run", flow: "sib" }] }),
      "utf8"
    );
    for (const [dir, marker] of [
      [path.join(tmpDir, "deep"), "true sibling"],
      [tmpDir, "lexical sibling"],
    ]) {
      await fs.writeFile(
        path.join(dir, "sib.yaml"),
        serializeFlow({ executionPrerequisite: "", steps: [{ kind: "echo", message: marker }] }),
        "utf8"
      );
    }

    // The wrapper is legitimate: this stat goes through the kernel, so size and
    // mtime are the real file's and the boundary gate is satisfied.
    const viaSymlink = [tmpDir, "link", "..", "flow.yaml"].join(path.sep);
    const st = await fs.stat(viaSymlink);
    const res = await supertest(handle.app)
      .post("/tools/flow-execute")
      .send({
        project_root: projectRoot,
        device: DEVICE,
        flow_path: {
          __argentFileInput: true,
          path: viaSymlink,
          size: st.size,
          mtimeMs: st.mtimeMs,
        },
      });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/must not contain "\.\." segments/);
    expect(steps.invokeTool).not.toHaveBeenCalled();
  });

  it("diagnoses name + flow_path with the exactly-one rule when the saved flow does not exist", async () => {
    // The old-client wire for the dual-source misuse: pre-skipWhenSet clients
    // interpolate ${project_root}/.argent/flows/${name}.yaml whenever name is
    // set — even alongside flow_path — and since "checkout" is not saved, the
    // flow_file wrapper is path-only. Without the skip, the boundary 422s on
    // that missing file before zod's exactly-one rule can run, telling the
    // agent to re-create a flow it never asked for.
    const st = await fs.stat(flowPath);
    const res = await supertest(handle.app)
      .post("/tools/flow-execute")
      .send({
        name: "checkout",
        project_root: projectRoot,
        device: DEVICE,
        flow_path: { __argentFileInput: true, path: flowPath, size: st.size, mtimeMs: st.mtimeMs },
        flow_file: {
          __argentFileInput: true,
          path: path.join(projectRoot, ".argent", "flows", "checkout.yaml"),
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Pass exactly one flow source: name or flow_path\./);
    expect(res.body.error).not.toMatch(/was not found on the tool-server host/);
    expect(steps.invokeTool).not.toHaveBeenCalled();
  });

  it("diagnoses name + flow_path with the exactly-one rule when the saved flow exists", async () => {
    // Same misuse, but the unused saved flow resolves cleanly — the diagnosis
    // must be identical to the nonexistent-name case above.
    const savedPath = path.join(projectRoot, ".argent", "flows", "good.yaml");
    await fs.mkdir(path.dirname(savedPath), { recursive: true });
    await fs.writeFile(
      savedPath,
      serializeFlow({ executionPrerequisite: "", steps: [{ kind: "echo", message: "saved" }] }),
      "utf8"
    );
    const savedSt = await fs.stat(savedPath);
    const st = await fs.stat(flowPath);
    const res = await supertest(handle.app)
      .post("/tools/flow-execute")
      .send({
        name: "good",
        project_root: projectRoot,
        device: DEVICE,
        flow_path: { __argentFileInput: true, path: flowPath, size: st.size, mtimeMs: st.mtimeMs },
        flow_file: {
          __argentFileInput: true,
          path: savedPath,
          size: savedSt.size,
          mtimeMs: savedSt.mtimeMs,
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Pass exactly one flow source: name or flow_path\./);
    expect(steps.invokeTool).not.toHaveBeenCalled();
  });

  it("diagnoses a dual-source call from a skipWhenSet-aware client the same way", async () => {
    // A current client never derives flow_file alongside flow_path, so the
    // wire carries both sources and no flow_file wrapper at all.
    const st = await fs.stat(flowPath);
    const res = await supertest(handle.app)
      .post("/tools/flow-execute")
      .send({
        name: "checkout",
        project_root: projectRoot,
        device: DEVICE,
        flow_path: { __argentFileInput: true, path: flowPath, size: st.size, mtimeMs: st.mtimeMs },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Pass exactly one flow source: name or flow_path\./);
    expect(steps.invokeTool).not.toHaveBeenCalled();
  });

  it("diagnoses name + flow_path with the exactly-one rule when the flow_path file does not resolve", async () => {
    // The reciprocal of the missing-saved-flow case: this time the
    // CALLER-authored source is the one that cannot resolve. The wrapper is
    // path-only — the client cannot stat (let alone inline) a file that never
    // existed. Without the flow_path spec's unwrap the boundary would 422 on
    // it before zod's exactly-one rule runs, telling the agent to re-create a
    // file the call never needed.
    const res = await supertest(handle.app)
      .post("/tools/flow-execute")
      .send({
        name: "checkout",
        project_root: projectRoot,
        device: DEVICE,
        flow_path: { __argentFileInput: true, path: path.join(tmpDir, "nope.yaml") },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Pass exactly one flow source: name or flow_path\./);
    expect(res.body.error).not.toMatch(/was not found on the tool-server host/);
    expect(steps.invokeTool).not.toHaveBeenCalled();
  });

  it("diagnoses an old-client dual-source wire where neither wrapper resolves", async () => {
    // Worst case of the skew: a pre-skipWhenSet client derived flow_file for
    // an unsaved name AND the caller mistyped flow_path, so both wrappers are
    // path-only. Whichever spec ran first used to pick the error; the
    // diagnosis must not consult either file.
    const res = await supertest(handle.app)
      .post("/tools/flow-execute")
      .send({
        name: "checkout",
        project_root: projectRoot,
        device: DEVICE,
        flow_path: { __argentFileInput: true, path: path.join(tmpDir, "nope.yaml") },
        flow_file: {
          __argentFileInput: true,
          path: path.join(projectRoot, ".argent", "flows", "checkout.yaml"),
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Pass exactly one flow source: name or flow_path\./);
    expect(res.body.error).not.toMatch(/was not found on the tool-server host/);
    expect(steps.invokeTool).not.toHaveBeenCalled();
  });

  it("still fails the boundary when a lone flow_path does not resolve", async () => {
    // No name on the wire, so the unwrap must not fire: a flow_path-only call
    // whose file resolves nowhere is a genuine boundary failure, and the 422
    // guidance about the missing file is the right diagnosis.
    const res = await supertest(handle.app)
      .post("/tools/flow-execute")
      .send({
        project_root: projectRoot,
        device: DEVICE,
        flow_path: { __argentFileInput: true, path: path.join(tmpDir, "nope.yaml") },
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/was not found on the tool-server host/);
    expect(steps.invokeTool).not.toHaveBeenCalled();
  });

  it("diagnoses a source-less call with the exactly-one rule at the validation layer", async () => {
    // The other half of exactly-one: no name and no flow_path. Nothing on the
    // wire is a wrapper, so file-input resolution passes through untouched and
    // the schema's superRefine is the only guard left before execute — it must
    // classify the miss as a 400 validation failure, not fall through to
    // resolveFlowSource's in-tool copy and surface as a 500 tool error.
    const res = await supertest(handle.app)
      .post("/tools/flow-execute")
      .send({ project_root: projectRoot, device: DEVICE });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Pass exactly one flow source: name or flow_path\./);
    expect(steps.invokeTool).not.toHaveBeenCalled();
  });

  it("accepts the legitimate wrapper carrying the file's real stat and runs the flow", async () => {
    const st = await fs.stat(flowPath);
    const res = await supertest(handle.app)
      .post("/tools/flow-execute")
      .send({
        project_root: projectRoot,
        device: DEVICE,
        flow_path: {
          __argentFileInput: true,
          path: flowPath,
          size: st.size,
          mtimeMs: st.mtimeMs,
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      flow: "out-of-project",
      steps: [
        { kind: "echo", status: "pass" },
        { kind: "tool", status: "pass", tool: "tap" },
      ],
    });
    const dispatched = (steps.invokeTool as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(dispatched).toContain("tap");
  });

  /** A wrapper for a client file that does not exist on this host, content and all. */
  function uploadedWrapper(clientPath: string, yaml: string): Record<string, unknown> {
    return {
      __argentFileInput: true,
      path: clientPath,
      size: Buffer.byteLength(yaml, "utf8"),
      mtimeMs: 1_790_000_000_000,
      content: Buffer.from(yaml, "utf8").toString("base64"),
    };
  }

  it("runs an uploaded self-contained flow_path", async () => {
    // The whole remote chain: the boundary finds no host file, materializes
    // the content, and resolveFlowSource runs the copy under the client's
    // flow name — the same contract an uploaded `name` run has.
    const yaml = serializeFlow({
      executionPrerequisite: "",
      steps: [
        { kind: "echo", message: "uploaded" },
        { kind: "tool", name: "tap", args: { x: 0.5, y: 0.5 } },
      ],
    });
    const res = await supertest(handle.app)
      .post("/tools/flow-execute")
      .send({
        project_root: projectRoot,
        device: DEVICE,
        flow_path: uploadedWrapper("/client/.argent/flows/remote.yaml", yaml),
      });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      flow: "remote",
      steps: [
        { kind: "echo", status: "pass", message: "uploaded" },
        { kind: "tool", status: "pass", tool: "tap" },
      ],
    });
    const dispatched = (steps.invokeTool as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(dispatched).toContain("tap");
  });

  it("rejects an uploaded flow_path that composes", async () => {
    // The files beside the client's flow stayed on the client, so the run is
    // refused before step 1 with the list of steps that would read them.
    const yaml = serializeFlow({
      executionPrerequisite: "",
      steps: [
        { kind: "echo", message: "before" },
        { kind: "run", flow: "frag.yaml" },
        { kind: "tool", name: "tap", args: { x: 0.5, y: 0.5 } },
      ],
    });
    const res = await supertest(handle.app)
      .post("/tools/flow-execute")
      .send({
        project_root: projectRoot,
        device: DEVICE,
        flow_path: uploadedWrapper("/client/.argent/flows/composed.yaml", yaml),
      });

    expect(res.status).toBe(500);
    expect(res.body.error_code).toBe("FLOW_FILE_INVALID");
    expect(res.body.error).toMatch(/not self-contained/);
    expect(res.body.error).toContain("  - step 2: run: frag.yaml");
    expect(steps.invokeTool).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")(
    "names a Windows client path instead of calling it relative",
    async () => {
      // `C:\...` is absolute on the client that wrote it, so "must be
      // absolute" would send its user hunting for a mistake they did not make.
      const yaml = serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "tool", name: "tap", args: { x: 0.5, y: 0.5 } }],
      });
      const wrapper = uploadedWrapper("C:\\work\\proj\\.argent\\flows\\basic.yaml", yaml);

      for (const [root, quoted] of [
        ["C:\\work\\proj", `project_root "C:\\work\\proj"`],
        [projectRoot, `flow_path "C:\\work\\proj\\.argent\\flows\\basic.yaml"`],
      ] as const) {
        const res = await supertest(handle.app)
          .post("/tools/flow-execute")
          .send({ project_root: root, device: DEVICE, flow_path: wrapper });

        expect(res.status).toBe(500);
        expect(res.body.error).toContain(`${quoted} is a Windows path`);
        expect(res.body.error).not.toMatch(/must be an absolute|must be absolute/);
      }
      expect(steps.invokeTool).not.toHaveBeenCalled();
    }
  );

  /** A flow on this host plus the wrapper a client with a mirrored copy of it sends. */
  async function mirroredUpload(hostYaml: string, clientYaml: string) {
    const hostPath = path.join(projectRoot, ".argent", "flows", "mirrored.yaml");
    await fs.mkdir(path.dirname(hostPath), { recursive: true });
    await fs.writeFile(hostPath, hostYaml, "utf8");
    const st = await fs.stat(hostPath);
    return {
      __argentFileInput: true,
      path: hostPath,
      size: st.size,
      mtimeMs: st.mtimeMs,
      content: Buffer.from(clientYaml, "utf8").toString("base64"),
    };
  }

  it("runs the uploaded content, not a host copy that matches its size and mtime", async () => {
    const flowWith = (message: string) =>
      serializeFlow({ executionPrerequisite: "", steps: [{ kind: "echo", message }] });
    const res = await supertest(handle.app)
      .post("/tools/flow-execute")
      .send({
        project_root: projectRoot,
        device: DEVICE,
        flow_path: await mirroredUpload(flowWith("server"), flowWith("client")),
      });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      flow: "mirrored",
      steps: [{ kind: "echo", status: "pass", message: "client" }],
    });
  });

  it("rejects an uploaded flow that composes even when this host has a mirrored copy of it", async () => {
    // The fragment beside the host copy may be older than the client's, so
    // a matching root file is no reason to run this host's siblings.
    const yaml = serializeFlow({
      executionPrerequisite: "",
      steps: [
        { kind: "run", flow: "frag.yaml" },
        { kind: "tool", name: "tap", args: { x: 0.5, y: 0.5 } },
      ],
    });
    const wire = await mirroredUpload(yaml, yaml);
    await fs.writeFile(
      path.join(path.dirname(wire.path), "frag.yaml"),
      serializeFlow({ executionPrerequisite: "", steps: [{ kind: "echo", message: "stale" }] }),
      "utf8"
    );
    const res = await supertest(handle.app)
      .post("/tools/flow-execute")
      .send({ project_root: projectRoot, device: DEVICE, flow_path: wire });

    expect(res.status).toBe(500);
    expect(res.body.error_code).toBe("FLOW_FILE_INVALID");
    expect(res.body.error).toContain("  - step 1: run: frag.yaml");
    expect(steps.invokeTool).not.toHaveBeenCalled();
  });
});

describe("flow-read-prerequisite flow_path over HTTP", () => {
  it("answers about the boundary-verified flow_path, not the saved flow of the same stem", async () => {
    // Two flows share the stem "gate": the saved copy under the project root
    // and the explicit file flow-execute would run for the same params. The
    // documented pre-flight (read the prerequisite, then run) is only sound if
    // this tool addresses the explicit file — answering with the saved copy's
    // contract would have the agent satisfy the wrong prerequisite.
    const savedPath = path.join(projectRoot, ".argent", "flows", "gate.yaml");
    await fs.mkdir(path.dirname(savedPath), { recursive: true });
    await fs.writeFile(
      savedPath,
      serializeFlow({ executionPrerequisite: "SAVED-COPY: HOME screen", steps: [] }),
      "utf8"
    );
    const sharedPath = path.join(tmpDir, "elsewhere", "gate.yaml");
    await fs.mkdir(path.dirname(sharedPath), { recursive: true });
    await fs.writeFile(
      sharedPath,
      serializeFlow({ executionPrerequisite: "SHARED-COPY: DETAIL screen", steps: [] }),
      "utf8"
    );

    const st = await fs.stat(sharedPath);
    const res = await supertest(handle.app)
      .post("/tools/flow-read-prerequisite")
      .send({
        project_root: projectRoot,
        flow_path: {
          __argentFileInput: true,
          path: sharedPath,
          size: st.size,
          mtimeMs: st.mtimeMs,
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      flow: "gate",
      executionPrerequisite: "SHARED-COPY: DETAIL screen",
    });
  });

  it("rejects a hand-crafted stat-less wrapper without reading the YAML", async () => {
    // The same gate flow-execute's suite pins above: presence on the host is
    // not boundary evidence, and a read must not be softer than the run — a
    // prerequisite handed out here would vouch for a file the run refuses.
    const res = await supertest(handle.app)
      .post("/tools/flow-read-prerequisite")
      .send({
        project_root: projectRoot,
        flow_path: { __argentFileInput: true, path: flowPath },
      });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/flow_path file-input boundary/);
  });

  it("diagnoses name + flow_path with the exactly-one rule when the flow_path file does not resolve", async () => {
    // flow-execute's unwrap case, mirrored: the caller-authored flow_path must
    // reach zod as a plain string so the dual-source misuse is diagnosed by
    // the schema — not by a 422 about a file the call never needed, and not by
    // silently answering for the saved flow.
    const res = await supertest(handle.app)
      .post("/tools/flow-read-prerequisite")
      .send({
        name: "checkout",
        project_root: projectRoot,
        flow_path: { __argentFileInput: true, path: path.join(tmpDir, "nope.yaml") },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Pass exactly one flow source: name or flow_path\./);
    expect(res.body.error).not.toMatch(/was not found on the tool-server host/);
  });

  it("still reads a saved flow by name alone", async () => {
    // name became optional to admit flow_path; a name-only wire (no wrapper at
    // all — the shape a direct HTTP caller sends) must keep resolving to
    // ${project_root}/.argent/flows/${name}.yaml exactly as before.
    const savedPath = path.join(projectRoot, ".argent", "flows", "saved-only.yaml");
    await fs.mkdir(path.dirname(savedPath), { recursive: true });
    await fs.writeFile(
      savedPath,
      serializeFlow({ executionPrerequisite: "App on home screen", steps: [] }),
      "utf8"
    );

    const res = await supertest(handle.app)
      .post("/tools/flow-read-prerequisite")
      .send({ name: "saved-only", project_root: projectRoot });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      flow: "saved-only",
      executionPrerequisite: "App on home screen",
    });
  });

  it("reads an uploaded flow_path, as flow-execute runs one", async () => {
    // Over a link both tools get the same uploaded copy, so the prerequisite an
    // agent reads belongs to the flow that will run.
    const yaml = serializeFlow({ executionPrerequisite: "be logged in", steps: [] });
    const res = await supertest(handle.app)
      .post("/tools/flow-read-prerequisite")
      .send({
        project_root: projectRoot,
        flow_path: {
          __argentFileInput: true,
          path: "/client/.argent/flows/remote.yaml",
          size: Buffer.byteLength(yaml, "utf8"),
          mtimeMs: 1_790_000_000_000,
          content: Buffer.from(yaml, "utf8").toString("base64"),
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ flow: "remote", executionPrerequisite: "be logged in" });
  });
});

describe("flow-execute over a link, from the real argent client", () => {
  // The client's own source: the client collects the flow's run: closure and
  // sends it, this route resolves it, and the runner reads it.
  const clientSrc = path.resolve(__dirname, "../../argent-tools-client/src/tools-client.ts");
  let server: Server;
  let url: string;

  beforeEach(async () => {
    server = handle.app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  async function write(rel: string, text: string): Promise<string> {
    const file = path.join(projectRoot, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text, "utf8");
    return file;
  }

  /** The real client; `beforeSend` sees the built body of each call to the tool `tool`. */
  async function toolsClient(
    remote: boolean,
    tool: string,
    beforeSend?: (body: string) => Promise<void>
  ) {
    const { createToolsClient } = (await import(clientSrc)) as {
      createToolsClient(options: object): {
        callTool(name: string, args: unknown): Promise<{ data: unknown }>;
      };
    };
    return createToolsClient({
      baseUrl: async () => ({ url, token: "", remote }),
      fetchImpl: async (target: string, init: RequestInit) => {
        if (target.endsWith(`/tools/${tool}`)) await beforeSend?.(String(init.body));
        return fetch(target, init);
      },
    });
  }

  /** The step reports and written baselines of a run of `flowPath`; `beforeSend` sees the built body. */
  async function callFlow(
    remote: boolean,
    flowPath: string,
    beforeSend?: (body: string) => Promise<void>,
    extra: { updateBaselines?: boolean; platform?: string } = {}
  ): Promise<{ steps: Omit<FlowRunResult["steps"][number], "durationMs">[]; writes?: unknown }> {
    const client = await toolsClient(remote, "flow-execute", beforeSend);
    const { data } = await client.callTool("flow-execute", {
      flow_path: flowPath,
      project_root: projectRoot,
      device: DEVICE,
      ...extra,
    });
    const { steps, baselineWrites } = data as FlowRunResult;
    return { steps: steps.map(({ durationMs: _, ...step }) => step), writes: baselineWrites };
  }

  it("runs the run: closure the client sent as the co-located run does, with the project gone from this host", async () => {
    const root = await write(
      ".argent/flows/root.yaml",
      "steps:\n  - echo: start\n  - run: login\n  - when: { platform: ios }\n    steps:\n" +
        "      - run: ../../shared/branch.yaml\n  - run: gone.yaml\n  - echo: never\n"
    );
    await write(".argent/flows/login.yaml", "steps:\n  - echo: logged in\n");
    // A fragment of a fragment, beside the file that names it.
    await write("shared/branch.yaml", "steps:\n  - run: common.yaml\n");
    await write("shared/common.yaml", "steps:\n  - echo: common\n");

    const { steps: colocated } = await callFlow(false, root);
    // Once the client has read the project it leaves this host, so every
    // fragment the linked run reads came with the call.
    const { steps: linked } = await callFlow(true, root, () =>
      fs.rename(projectRoot, `${projectRoot}-moved`)
    );

    expect(linked).toEqual(colocated);
    expect(colocated.map((s) => `${s.status} ${s.flow}`)).toEqual([
      ...["pass root", "pass login", "pass login", "pass root", "pass branch"],
      ...["pass common", "pass common", "error gone", "skip root"],
    ]);
    expect(colocated[7]!.reason).toMatch(/^could not load fragment "gone.yaml": ENOENT/);
  });

  it("refuses before step 1 a fragment outside the project and a .yaml link to a .env, sending neither", async () => {
    await fs.writeFile(path.join(tmpDir, "outside.yaml"), "steps:\n  - echo: outside\n");
    const fenced = await write(
      ".argent/flows/fenced.yaml",
      "steps:\n  - echo: first\n  - run: ../../../outside.yaml\n  - run: secret.yaml\n"
    );
    const env = await write(".env", "TOKEN=hunter2\n");
    await fs.symlink(env, path.join(path.dirname(fenced), "secret.yaml"));
    let members: { state?: string; content?: string }[] = [];

    const err = await callFlow(true, fenced, async (body) => {
      members = JSON.parse(body).flow_path.members;
    }).catch((e: unknown) => e);

    expect(String(err)).toContain(
      "run: ../../../outside.yaml (../../../outside.yaml is outside every root this client serves"
    );
    expect(String(err)).toContain(
      "run: secret.yaml (secret.yaml links to a file that is not a YAML file)"
    );
    expect(members.map((m) => [m.state, m.content])).toEqual([
      ["refused", undefined],
      ["refused", undefined],
    ]);
  });

  it("updates baselines on the client from their names, then compares against its snapshots' baselines only", async () => {
    const capture = new PNG({ width: 30, height: 60 });
    capture.data.fill(200);
    await fs.writeFile(path.join(tmpDir, "capture.png"), PNG.sync.write(capture));
    const root = await write(
      ".argent/flows/root.yaml",
      "steps:\n  - snapshot: title\n  - snapshot: fresh\n  - snapshot: fresh\n"
    );
    const dir = path.join(await fs.realpath(path.dirname(root)), "__baselines__", "root");
    const [title, fresh] = ["title", "fresh"].map((n) => path.join(dir, `${n}__ios-30x60.png`));
    // Not PNGs: a compare that read either would fail.
    await write(".argent/flows/__baselines__/root/title__ios-30x60.png", "stale");
    await write(".argent/flows/__baselines__/root/other__ios-30x60.png", "another snapshot");
    let members: { key: string; state?: string; content?: string }[] = [];
    const keep = async (body: string) => {
      members = JSON.parse(body).flow_path.members;
    };

    const update = await callFlow(true, root, keep, { updateBaselines: true });

    expect(members.map((m) => [path.basename(m.key), m.state, m.content])).toEqual([
      ["other__ios-30x60.png", "listed", undefined],
      ["title__ios-30x60.png", "listed", undefined],
    ]);
    expect(update.steps.map((s) => s.reason)).toEqual([
      `baseline captured; the client updates it when the run ends (${title})`,
      `baseline captured; the client writes it when the run ends (${fresh})`,
      // The capture this call already took is the file the second one replaces.
      `baseline captured; the client updates it when the run ends (${fresh})`,
    ]);
    expect(update.writes).toEqual([title, fresh]);

    // The project leaves this host, so the compare reads the baselines the call carried.
    const compare = await callFlow(true, root, async (body) => {
      await keep(body);
      await fs.rename(projectRoot, `${projectRoot}-moved`);
    });

    expect(members.map((m) => [path.basename(m.key), typeof m.content])).toEqual([
      ["fresh__ios-30x60.png", "string"],
      ["title__ios-30x60.png", "string"],
    ]);
    expect(compare.steps.map((s) => s.reason)).toEqual([
      "diff 0.00% ≤ 0.5% (title__ios-30x60.png)",
      "diff 0.00% ≤ 0.5% (fresh__ios-30x60.png)",
      "diff 0.00% ≤ 0.5% (fresh__ios-30x60.png)",
    ]);
  });

  it("sends a tool: step only the file arguments its tool declares, refuses a .png link to a .env, and reads the baseline the call wrote", async () => {
    const capture = new PNG({ width: 30, height: 60 });
    await fs.writeFile(path.join(tmpDir, "capture.png"), PNG.sync.write(capture));
    const flows = path.join(await fs.realpath(projectRoot), ".argent", "flows");
    const baseline = path.join(flows, "__baselines__", "root", "title__ios-30x60.png");
    await write(".argent/flows/__baselines__/root/title__ios-30x60.png", "old");
    const label = await write("label.png", "not a file input");
    const secret = path.join(flows, "secret.png");
    await fs.symlink(await write(".env", "TOKEN=hunter2\n"), secret);
    const read = (image: string, more = "") =>
      `  - tool: read-file\n    args: { image: ${JSON.stringify(image)}${more} }\n`;
    const root = await write(
      ".argent/flows/root.yaml",
      `steps:\n${read(baseline, `, label: ${JSON.stringify(label)}`)}  - snapshot: title\n` +
        read(baseline) +
        read(secret)
    );
    let members: { role: string; key: string; state?: string; content?: string }[] = [];

    const run = await callFlow(
      true,
      root,
      async (body) => {
        members = JSON.parse(body).flow_path.members;
      },
      { updateBaselines: true }
    );

    expect(members.map((m) => [m.role, m.key, m.state, typeof m.content])).toEqual([
      ["tool", baseline, undefined, "string"],
      ["tool", secret, "refused", "undefined"],
    ]);
    expect(run.writes).toEqual([baseline]);
    const written = await fs.readFile(baseline, "base64");
    expect(run.steps.map((s) => [s.status, (s.result as { read?: string })?.read])).toEqual([
      ["pass", Buffer.from("old").toString("base64")],
      ["pass", undefined],
      // The capture the snapshot step took, not the bytes the client sent.
      ["pass", written],
      ["error", undefined],
    ]);
    expect(run.steps[3]!.reason).toContain(
      `the client refused to send "${secret}": ${secret} links to a file that is not one of .png, .yaml`
    );
  });

  /** A member as `[role, its last two path parts, state, typeof content]`. */
  const memberShape = (m: { role: string; path: string; state?: string; content?: string }) => [
    m.role,
    m.path.split(path.sep).slice(-2).join("/"),
    m.state,
    typeof m.content,
  ];

  it("sends each nested run's flow and baselines as the runner reads or writes them, in one overlay for the call", async () => {
    const capture = PNG.sync.write(new PNG({ width: 30, height: 60 }));
    await fs.writeFile(path.join(tmpDir, "capture.png"), capture);
    const nest = (name: string, more = "") =>
      `  - tool: flow-execute\n    args: { name: ${name}, project_root: ${JSON.stringify(projectRoot)}${more} }\n`;
    // The first nested run updates as its caller does, the second only
    // compares, and the third compares on the device of the run that starts
    // it, whatever platform its step names.
    const root = await write(
      ".argent/flows/root.yaml",
      `steps:\n${nest("child")}${nest("child", ", updateBaselines: false")}` +
        nest("peer", ", updateBaselines: false, platform: android")
    );
    await write(".argent/flows/child.yaml", "steps:\n  - snapshot: snap\n");
    await write(".argent/flows/peer.yaml", "steps:\n  - snapshot: snap\n");
    const baselines = path.join(await fs.realpath(path.dirname(root)), "__baselines__");
    const snap = path.join(baselines, "child", "snap__ios-30x60.png");
    // Not PNGs: a compare that read one would fail.
    await write(".argent/flows/__baselines__/child/snap__ios-30x60.png", "stale");
    await write(".argent/flows/__baselines__/child/old__ios-30x60.png", "another snapshot");
    await write(".argent/flows/__baselines__/peer/snap__android-30x60.png", "another platform");
    await fs.writeFile(path.join(baselines, "peer", "snap__ios-30x60.png"), capture);
    let members: Parameters<typeof memberShape>[0][] = [];

    // The project leaves this host once the client has read it.
    const run = await callFlow(
      true,
      root,
      async (body) => {
        members = JSON.parse(body).flow_path.members;
        await fs.rename(projectRoot, `${projectRoot}-moved`);
      },
      { updateBaselines: true, platform: "ios" }
    );

    expect(members.map(memberShape)).toEqual([
      ["flow", "flows/child.yaml", undefined, "string"],
      ["flow", "flows/peer.yaml", undefined, "string"],
      ["baseline", "child/old__ios-30x60.png", "listed", "undefined"],
      ["baseline", "child/snap__ios-30x60.png", undefined, "string"],
      ["baseline", "peer/snap__ios-30x60.png", undefined, "string"],
    ]);
    expect(
      run.steps.map((s) => (s.result as FlowRunResult | undefined)?.steps[0]?.reason ?? s.reason)
    ).toEqual([
      `baseline captured; the client updates it when the run ends (${snap})`,
      // The capture the first nested run took, not the bytes the client sent.
      "diff 0.00% ≤ 0.5% (snap__ios-30x60.png)",
      "diff 0.00% ≤ 0.5% (snap__ios-30x60.png)",
    ]);
    expect(run.writes).toEqual([snap]);
    expect(await fs.readFile(snap)).toEqual(capture);
  });

  it("records a nested flow over a link from the files of that one step: its flow, fragment and baselines", async () => {
    const capture = PNG.sync.write(new PNG({ width: 30, height: 60 }));
    await fs.writeFile(path.join(tmpDir, "capture.png"), capture);
    // The real path, so the recording and its siblings have one key each.
    const project = await fs.realpath(projectRoot);
    const flows = path.join(project, ".argent", "flows");
    await write(".argent/flows/child.yaml", "steps:\n  - run: frag\n  - snapshot: snap\n");
    await write(".argent/flows/frag.yaml", "steps:\n  - echo: frag\n");
    await write(".argent/flows/unrelated.yaml", "steps:\n  - echo: unrelated\n");
    await write(".argent/flows/__baselines__/child/other__ios-30x60.png", "another snapshot");
    await fs.writeFile(path.join(flows, "__baselines__", "child", "snap__ios-30x60.png"), capture);
    let members: Parameters<typeof memberShape>[0][] = [];
    let onSend = async (_body: string): Promise<void> => {};
    const client = await toolsClient(true, "flow-add-step", (body) => onSend(body));
    const recording = { name: "rec", project_root: project };
    const addFlow = (args: object) =>
      client.callTool("flow-add-step", {
        ...recording,
        command: "flow-execute",
        args: JSON.stringify({ project_root: project, device: DEVICE, ...args }),
      });

    await client.callTool("flow-start-recording", recording);
    // An earlier step of the take runs a flow that the next step does not read.
    await addFlow({ name: "unrelated" });
    onSend = async (body) => {
      members = JSON.parse(body).project_root.members;
      await fs.rename(projectRoot, `${projectRoot}-moved`);
    };
    // A sibling by flow_path, which the recorder runs and records by its name.
    await addFlow({ flow_path: path.join(flows, "child.yaml") });

    expect(members.map(memberShape)).toEqual([
      ["flow", "flows/rec.yaml", undefined, "string"],
      ["flow", "flows/child.yaml", undefined, "string"],
      ["flow", "flows/frag.yaml", undefined, "string"],
      ["baseline", "child/snap__ios-30x60.png", undefined, "string"],
    ]);
    expect(parseFlow(await fs.readFile(path.join(flows, "rec.yaml"), "utf8")).steps).toEqual([
      { kind: "run", flow: "unrelated.yaml" },
      { kind: "run", flow: "child.yaml" },
    ]);
  });

  it("finds nothing past a missing directory and its .., as the co-located run, and sends nothing", async () => {
    // The kernel stops at the missing `x`, so no `..` after it leads back. A
    // lexical collapse would land on a .yaml link to a .env, on a file behind
    // a directory link out of the project, and on a flow that does exist.
    await write(".argent/flows/login.yaml", "steps:\n  - echo: logged in\n");
    const env = await write(".env", "TOKEN=hunter2\n");
    await fs.symlink(env, path.join(projectRoot, ".argent/flows/secret.yaml"));
    await fs.mkdir(path.join(tmpDir, "outside"));
    await fs.writeFile(path.join(tmpDir, "outside/private.yaml"), "steps:\n  - echo: outside\n");
    await fs.symlink(path.join(tmpDir, "outside"), path.join(projectRoot, "linkout"));
    const flowsDir = await fs.realpath(path.join(projectRoot, ".argent/flows"));

    for (const target of [
      "x/../secret.yaml",
      "../../x/../linkout/private.yaml",
      "nonexist/../login.yaml",
    ]) {
      const root = await write(
        ".argent/flows/root.yaml",
        `steps:\n  - echo: start\n  - run: ${target}\n`
      );
      let members: { state?: string; content?: string }[] = [];

      const { steps: linked } = await callFlow(true, root, async (body) => {
        members = JSON.parse(body).flow_path.members;
      });
      const { steps: colocated } = await callFlow(false, root);

      expect(linked).toEqual(colocated);
      expect(colocated[1]!.reason).toBe(
        `could not load fragment "${target}": ENOENT: no such file or directory, ` +
          `open '${flowsDir}${path.sep}${target}'`
      );
      expect(members.map((m) => [m.state, m.content])).toEqual([["missing", undefined]]);
    }
  });

  it("sends no fragment for arguments the tool-server refuses, and gets its error", async () => {
    // Each call names a flow whose run: target lies outside the project. The
    // roots taken from such arguments (the directory a bad name climbs to, a
    // project_root with "..") would reach it, so they must not be taken before
    // the arguments pass.
    await write(".argent/flows/keep.yaml", "steps:\n  - echo: keep\n");
    const nested = await write("e2e/root.yaml", "steps:\n  - run: ../../sib/frag.yaml\n");
    const above = path.join(tmpDir, "above.yaml");
    await fs.writeFile(above, "steps:\n  - run: sib/frag.yaml\n");
    await fs.mkdir(path.join(tmpDir, "sib"));
    await fs.writeFile(path.join(tmpDir, "sib/frag.yaml"), "steps:\n  - echo: outside\n");
    const { createToolsClient } = (await import(clientSrc)) as {
      createToolsClient(options: object): {
        callTool(name: string, args: unknown): Promise<{ data: unknown }>;
      };
    };

    const originalCwd = process.cwd();
    process.chdir(projectRoot);
    try {
      for (const [args, error] of [
        [{ name: "../../../above" }, 'Invalid flow name "../../../above"'],
        [
          { flow_path: nested, project_root: `${projectRoot}/e2e/../..` },
          'project_root must not contain ".." segments',
        ],
        [{ name: "keep", flow_path: above }, "Pass exactly one flow source: name or flow_path."],
      ] as const) {
        let wire: { content?: string; members?: unknown } | undefined;
        const client = createToolsClient({
          baseUrl: async () => ({ url, token: "", remote: true }),
          fetchImpl: async (target: string, init: RequestInit) => {
            if (target.endsWith("/tools/flow-execute")) {
              const body = JSON.parse(String(init.body));
              wire = body.flow_path ?? body.flow_file;
            }
            return fetch(target, init);
          },
        });

        const err = await client
          .callTool("flow-execute", { project_root: projectRoot, device: DEVICE, ...args })
          .catch((e: unknown) => e);

        expect(String(err)).toContain(error);
        // The flow itself went out, so only the argument check kept its run: target back.
        expect(wire?.content).toBeDefined();
        expect(wire?.members).toBeUndefined();
      }
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("sends a relative flow_path as the absolute path in the client's working directory", async () => {
    await write(".argent/flows/relative.yaml", "steps:\n  - run: ../../../sib/frag.yaml\n");
    await fs.mkdir(path.join(tmpDir, "sib"));
    await fs.writeFile(path.join(tmpDir, "sib/frag.yaml"), "steps:\n  - echo: outside\n");
    let wire: { path?: string; members?: { state?: string; content?: string }[] } = {};
    const client = await toolsClient(true, "flow-execute", async (body) => {
      wire = JSON.parse(body).flow_path;
    });

    const originalCwd = process.cwd();
    process.chdir(projectRoot);
    try {
      const err = await client
        .callTool("flow-execute", {
          flow_path: ".argent/flows/relative.yaml",
          project_root: projectRoot,
          device: DEVICE,
        })
        .catch((e: unknown) => e);

      expect(wire.path).toBe(path.join(process.cwd(), ".argent/flows/relative.yaml"));
      // The run: target outside the project still goes out without its bytes.
      expect(wire.members!.map((m) => [m.state, m.content])).toEqual([["refused", undefined]]);
      expect(String(err)).toContain(
        "run: ../../../sib/frag.yaml (../../../sib/frag.yaml is outside every root this client serves"
      );
    } finally {
      process.chdir(originalCwd);
    }
  });

  /** A flow whose first step acts on the device, then runs `target`. */
  function tapThenRun(target: string): Promise<string> {
    return write(
      ".argent/flows/root.yaml",
      `steps:\n  - tool: tap\n    args: { x: 0.5, y: 0.5 }\n  - run: ${target}\n`
    );
  }

  it("refuses before step 1 a script: step in a fragment the client sent", async () => {
    const root = await tapThenRun("seed.yaml");
    const seed = await write(".argent/flows/seed.yaml", "steps:\n  - script: { path: seed.mjs }\n");

    const err = await callFlow(true, root).catch((e: unknown) => e);

    expect(String(err)).toContain(
      `step 1 in ${await fs.realpath(seed)}: script: { path: seed.mjs }`
    );
    expect(steps.invokeTool).not.toHaveBeenCalled();
  });

  it("refuses before step 1 a fragment outside the project that a sent fragment names", async () => {
    await fs.writeFile(path.join(tmpDir, "outside.yaml"), "steps:\n  - echo: outside\n");
    const root = await tapThenRun("mid.yaml");
    const mid = await write(".argent/flows/mid.yaml", "steps:\n  - run: ../../../outside.yaml\n");

    const err = await callFlow(true, root).catch((e: unknown) => e);

    expect(String(err)).toContain(
      `step 1 in ${await fs.realpath(mid)}: run: ../../../outside.yaml ` +
        "(../../../outside.yaml is outside every root this client serves"
    );
    expect(steps.invokeTool).not.toHaveBeenCalled();
  });

  it("tells a client that sends a run: flow without its fragments to update", async () => {
    const root = await tapThenRun("frag.yaml");
    await write(".argent/flows/frag.yaml", "steps:\n  - echo: frag\n");
    const { createToolsClient } = (await import(clientSrc)) as {
      createToolsClient(options: object): {
        callTool(name: string, args: unknown): Promise<{ data: unknown }>;
      };
    };
    const client = createToolsClient({
      baseUrl: async () => ({ url, token: "", remote: true }),
      fetchImpl: async (target: string, init: RequestInit) => {
        if (!target.endsWith("/tools/flow-execute")) return fetch(target, init);
        // An older client sends the flow file alone, with no members.
        const body = JSON.parse(String(init.body));
        const { members: _m, canonical: _c, spelling: _s, ...wire } = body.flow_path;
        return fetch(target, { ...init, body: JSON.stringify({ ...body, flow_path: wire }) });
      },
    });

    const err = await client
      .callTool("flow-execute", { flow_path: root, project_root: projectRoot, device: DEVICE })
      .catch((e: unknown) => e);

    expect(String(err)).toContain("  - step 2: run: frag.yaml\n");
    expect(String(err)).toContain(
      "This tool-server runs run: steps for a client that sends their fragments with the call. " +
        "Update the argent CLI or MCP adapter on the client."
    );
    expect(steps.invokeTool).not.toHaveBeenCalled();
  });

  it("runs a chain that ends past the depth limit as the co-located run does, whatever its last target is", async () => {
    // The runner stops the 20th run: before it reads the target, so the client
    // may refuse that target (here a directory) and the run still goes as deep.
    await write(".argent/flows/n0.yaml", "steps:\n  - echo: n0\n  - run: n1.yaml\n");
    for (let hop = 1; hop < 20; hop++) {
      await write(
        `.argent/flows/n${hop}.yaml`,
        `steps:\n  - echo: n${hop}\n  - run: n${hop + 1}.yaml\n`
      );
    }
    await fs.mkdir(path.join(projectRoot, ".argent/flows/n20.yaml"));
    const root = path.join(projectRoot, ".argent/flows/n0.yaml");
    let members: { key: string; state?: string }[] = [];

    const { steps: colocated } = await callFlow(false, root);
    const { steps: linked } = await callFlow(true, root, async (body) => {
      members = JSON.parse(body).flow_path.members;
    });

    expect(linked).toEqual(colocated);
    expect(colocated.at(-1)).toMatchObject({
      kind: "run",
      status: "error",
      target: "n20.yaml",
      reason: "max run depth exceeded",
    });
    expect(members.at(-1)).toMatchObject({
      key: expect.stringMatching(/n20\.yaml$/),
      state: "refused",
    });
  });
});

describe("flow-execute with run: fragments sent through POST /upload", () => {
  // The client inlines members up to 256 KiB in all, so each fragment this
  // size goes to POST /upload.
  const PADDING = `#${"x".repeat(300 * 1024)}\n`;
  const clientSrc = path.resolve(__dirname, "../../argent-tools-client/src/tools-client.ts");
  let server: Server;
  let url: string;
  let scratch: string;

  beforeEach(async () => {
    server = handle.app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // Uploads and their extract dirs go to os.tmpdir(), so one that stays shows here.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "http-flow-upload-"));
    scratch = dir;
    const restoreTmpdir = redirectTmpdir(dir);
    return async () => {
      restoreTmpdir();
      await fs.rm(dir, { recursive: true, force: true });
    };
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  async function uploadsLeft(): Promise<string[]> {
    return (await fs.readdir(scratch)).filter(
      (entry) => entry.startsWith("argent-upload-") || entry.startsWith("argent-tar-upload-")
    );
  }

  async function writeFlows(files: Record<string, string>): Promise<string> {
    const flows = path.join(projectRoot, ".argent", "flows");
    await fs.mkdir(flows, { recursive: true });
    for (const [name, text] of Object.entries(files)) {
      await fs.writeFile(path.join(flows, name), text, "utf8");
    }
    return path.join(flows, "root.yaml");
  }

  type Body = { flow_path: { members: Record<string, unknown>[] } };

  /** Run `flowPath` over a link. `tamper` edits the body after the client built it. */
  async function callLinked(flowPath: string, tamper?: (body: Body) => void) {
    const { createToolsClient } = (await import(clientSrc)) as {
      createToolsClient(options: object): {
        callTool(name: string, args: unknown): Promise<{ data: unknown }>;
      };
    };
    let sent: Body | undefined;
    const client = createToolsClient({
      baseUrl: async () => ({ url, token: "", remote: true }),
      fetchImpl: async (target: string, init: RequestInit) => {
        if (!target.endsWith("/tools/flow-execute")) return fetch(target, init);
        sent = JSON.parse(String(init.body)) as Body;
        const body = JSON.parse(String(init.body)) as Body;
        tamper?.(body);
        return fetch(target, { ...init, body: JSON.stringify(body) });
      },
    });
    const outcome = await client
      .callTool("flow-execute", { flow_path: flowPath, project_root: projectRoot, device: DEVICE })
      .then(
        ({ data }) => (data as FlowRunResult).steps.map((step) => `${step.status} ${step.flow}`),
        (err: unknown) => err
      );
    return { outcome, sent: sent! };
  }

  it("runs a fragment that came through POST /upload", async () => {
    const root = await writeFlows({
      "root.yaml": "steps:\n  - run: big.yaml\n  - echo: done\n",
      "big.yaml": `steps:\n  - echo: from the upload\n${PADDING}`,
    });

    const { outcome, sent } = await callLinked(root);

    expect(sent.flow_path.members.map((m) => [typeof m.uploadId, m.content])).toEqual([
      ["string", undefined],
    ]);
    expect(outcome).toEqual(["pass big", "pass big", "pass root"]);
    // The extract dir goes once the response has closed.
    await vi.waitFor(async () => expect(await uploadsLeft()).toEqual([]));
  });

  it.each([
    ["an archive that is not the one uploaded", { contentHash: "0".repeat(64) }, /hash mismatch/],
    ["a size that is not the size of the file", { size: 5 }, /but the client recorded 5/],
  ])("fails the call on %s and keeps none of its uploads", async (_case, change, error) => {
    const root = await writeFlows({
      "root.yaml": "steps:\n  - run: a.yaml\n  - run: b.yaml\n",
      "a.yaml": `steps:\n  - echo: a\n${PADDING}`,
      "b.yaml": `steps:\n  - echo: b\n${PADDING}`,
    });

    const { outcome, sent } = await callLinked(root, (body) => {
      Object.assign(body.flow_path.members[0]!, change);
    });

    expect(String(outcome)).toMatch(error);
    expect(steps.invokeTool).not.toHaveBeenCalled();
    expect(await uploadsLeft()).toEqual([]);
    // The upload of the second fragment is gone, not only its file.
    const again = await supertest(handle.app)
      .post("/tools/flow-execute")
      .send({ ...sent, flow_path: { ...sent.flow_path, members: [sent.flow_path.members[1]] } });
    expect(again.status).toBe(422);
    expect(again.body.error).toMatch(/was not found on the tool-server/);
  });
});
