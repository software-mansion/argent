import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import supertest from "supertest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactStore, type Registry, type ToolContext } from "@argent/registry";
import { createHttpApp, type HttpAppHandle } from "../src/http";
import { createRunFlowTool } from "../src/tools/flows/flow-run";
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
 * A registry exposing the REAL flow-execute tool, so a POST exercises the whole
 * chain a forged wrapper must traverse: HTTP file-input resolution →
 * resolveFlowSource's boundary gate → step dispatch.
 */
function httpRegistry(steps: Registry): Registry {
  const runFlow = createRunFlowTool(steps);
  return {
    getSnapshot: vi.fn(() => ({ services: new Map(), namespaces: [], tools: ["flow-execute"] })),
    getTool: vi.fn((id: string) => (id === "flow-execute" ? runFlow : undefined)),
    invokeTool: vi.fn(async (id: string, args: unknown, opts?: Partial<ToolContext>) => {
      if (id !== "flow-execute") throw new Error(`unexpected tool "${id}"`);
      return runFlow.execute({}, args as Parameters<typeof runFlow.execute>[1], {
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
