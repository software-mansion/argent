import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import supertest from "supertest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactStore, type Registry, type ToolContext } from "@argent/registry";
import { createHttpApp, type HttpAppHandle } from "../src/http";
import { createRunFlowTool } from "../src/tools/flows/flow-run";
import { flowReadPrerequisiteTool } from "../src/tools/flows/flow-read-prerequisite";
import {
  clearActiveFlow,
  clearActiveProjectRoot,
  serializeFlow,
} from "../src/tools/flows/flow-utils";

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
  clearActiveFlow();
});

afterEach(async () => {
  handle?.dispose();
  clearActiveFlow();
  clearActiveProjectRoot();
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
});
