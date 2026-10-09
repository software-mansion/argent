import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import supertest from "supertest";
import * as fs from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactStore, type Registry, type ToolContext } from "@argent/registry";
import { createHttpApp, type HttpAppHandle } from "../src/http";
import { createRunFlowTool, type FlowRunResult } from "../src/tools/flows/flow-run";
import { flowReadPrerequisiteTool } from "../src/tools/flows/flow-read-prerequisite";
import { serializeFlow } from "../src/tools/flows/flow-utils";

vi.mock("../src/utils/update-checker", () => ({
  getUpdateState: vi.fn(() => ({ updateInstallable: false, currentVersion: "1.0.0" })),
  isUpdateNoteSuppressed: vi.fn(() => true),
  suppressUpdateNote: vi.fn(),
}));

const DEVICE = "00000000-0000-0000-0000-0000000000ab";

/** The registry flow-execute dispatches its steps through — never the flow source. */
function stepRegistry(): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "list-devices") return { devices: [] };
      return { ok: true };
    }),
    getTool: vi.fn(() => undefined),
    resolveService: vi.fn(async () => ({
      isConnected: () => true,
      listConnectedBundleIds: () => [],
    })),
  } as unknown as Registry;
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
    ReturnType<typeof createRunFlowTool> | typeof flowReadPrerequisiteTool
  > = {
    "flow-execute": createRunFlowTool(steps),
    "flow-read-prerequisite": flowReadPrerequisiteTool,
  };
  return {
    getSnapshot: vi.fn(() => ({
      services: new Map(),
      namespaces: [],
      tools: Object.keys(tools),
    })),
    getTool: vi.fn((id: string) => tools[id]),
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

  /** The step reports of a run of `flowPath`; `beforeSend` sees the body once the client built it. */
  async function callFlow(
    remote: boolean,
    flowPath: string,
    beforeSend?: (body: string) => Promise<void>
  ): Promise<Omit<FlowRunResult["steps"][number], "durationMs">[]> {
    const { createToolsClient } = (await import(clientSrc)) as {
      createToolsClient(options: object): {
        callTool(name: string, args: unknown): Promise<{ data: unknown }>;
      };
    };
    const client = createToolsClient({
      baseUrl: async () => ({ url, token: "", remote }),
      fetchImpl: async (target: string, init: RequestInit) => {
        if (target.endsWith("/tools/flow-execute")) await beforeSend?.(String(init.body));
        return fetch(target, init);
      },
    });
    const { data } = await client.callTool("flow-execute", {
      flow_path: flowPath,
      project_root: projectRoot,
      device: DEVICE,
    });
    return (data as FlowRunResult).steps.map(({ durationMs: _, ...step }) => step);
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

    const colocated = await callFlow(false, root);
    // Once the client has read the project it leaves this host, so every
    // fragment the linked run reads came with the call.
    const linked = await callFlow(true, root, () => fs.rename(projectRoot, `${projectRoot}-moved`));

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

      const linked = await callFlow(true, root, async (body) => {
        members = JSON.parse(body).flow_path.members;
      });
      const colocated = await callFlow(false, root);

      expect(linked).toEqual(colocated);
      expect(colocated[1]!.reason).toBe(
        `could not load fragment "${target}": ENOENT: no such file or directory, ` +
          `open '${flowsDir}${path.sep}${target}'`
      );
      expect(members.map((m) => [m.state, m.content])).toEqual([["missing", undefined]]);
    }
  });
});
