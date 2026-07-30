import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  ArtifactStore,
  FLOW_FILE_NAME_PATTERN,
  FLOW_NAME_PATTERN,
  type Registry,
} from "@argent/registry";
import {
  createRunFlowTool,
  MAX_RUN_DEPTH,
  type FlowRunResult,
} from "../../src/tools/flows/flow-run";
import { serializeFlow, parseFlow } from "../../src/tools/flows/flow-utils";
import { bindDeviceArgs, stripDeviceKeys } from "../../src/tools/flows/flow-device";
import { runSnapshot } from "../../src/tools/flows/flow-visual";

// Stub the snapshot differ: the baseline-anchoring test asserts only WHERE the
// runner points it (root flowsDir + root flow name), not the diffing itself.
vi.mock("../../src/tools/flows/flow-visual", () => ({
  DEFAULT_MAX_MISMATCH: 0.5,
  runSnapshot: vi.fn(async () => ({ status: "pass", reason: "snapshot stubbed" })),
}));

const DEVICE = "00000000-0000-0000-0000-0000000000ab";
let tmpDir: string;

/**
 * `props`, when given, makes `getTool` report that schema for EVERY tool id —
 * so a fixture using it must be a single step and must pass an explicit device,
 * otherwise unrelated dispatches (list-devices) would be handed a bogus schema.
 */
function mockRegistry(props?: Record<string, unknown>): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "list-devices") return { devices: [] };
      return { ok: true };
    }),
    getTool: vi.fn(() => (props ? { inputSchema: { properties: props } } : undefined)),
    // iOS launch steps gate on a native-devtools connection: report connected
    // so the run proceeds. No selector directives run in these tests, so the
    // flow tree is never fetched.
    resolveService: vi.fn(async () => ({
      isConnected: () => true,
      listConnectedBundleIds: () => [],
    })),
  } as unknown as Registry;
}

async function writeFlow(name: string, yaml: Parameters<typeof serializeFlow>[0]): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.yaml`), serializeFlow(yaml), "utf8");
}

/**
 * Write a straight `run:` chain root → n1 → … → n{links} → tail, one `run:`
 * step per flow. The final hop fires with the root plus every link on the run
 * stack, i.e. a stack of exactly `links + 1` entries — which is what lets the
 * depth-boundary tests below land on the guard's threshold precisely.
 */
async function writeRunChain(links: number, tail: string): Promise<void> {
  await writeFlow("root", { executionPrerequisite: "", steps: [{ kind: "run", flow: "n1.yaml" }] });
  for (let i = 1; i <= links; i++) {
    await writeFlow(`n${i}`, {
      executionPrerequisite: "",
      steps: [{ kind: "run", flow: i === links ? tail : `n${i + 1}.yaml` }],
    });
  }
}

function asRun(r: FlowRunResult | { notice: string }): FlowRunResult {
  if (!("steps" in r)) throw new Error(`expected a run result, got notice: ${r.notice}`);
  return r;
}

beforeEach(async () => {
  // realpath'd so the path math below matches the runner's canonical anchors:
  // macOS's tmpdir lives behind the /var → /private/var symlink, which would
  // otherwise skew every equality for reasons unrelated to what a test pins.
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "flow-compose-")));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("flow composition (run:)", () => {
  it("expands a referenced fragment's steps inline", async () => {
    await writeFlow("login", {
      executionPrerequisite: "On login screen",
      steps: [
        { kind: "echo", message: "logging in" },
        { kind: "tool", name: "tap", args: { x: 0.5 } },
      ],
    });
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "run", flow: "login.yaml" },
        { kind: "echo", message: "done" },
      ],
    });

    const runFlow = createRunFlowTool(mockRegistry());
    const result = asRun(
      await runFlow.execute({}, { name: "main", project_root: tmpDir, device: DEVICE })
    );

    // run marker, login's echo + tap, then main's echo.
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "run:pass",
      "echo:pass",
      "tool:pass",
      "echo:pass",
    ]);
    // The expanded steps are attributed to the fragment.
    expect(result.steps[1].flow).toBe("login");
    expect(result.steps[3].flow).toBe("main");
    expect(result.ok).toBe(true);
  });

  it("resolves run: fragments beside an explicit top-level flow_path", async () => {
    const externalDir = path.join(tmpDir, "external-flows");
    const mainPath = path.join(externalDir, "main.yaml");
    await fs.mkdir(externalDir, { recursive: true });
    await fs.writeFile(
      path.join(externalDir, "login.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "echo", message: "sibling fragment" }],
      }),
      "utf8"
    );
    await fs.writeFile(
      mainPath,
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "run", flow: "login.yaml" }],
      }),
      "utf8"
    );

    const runFlow = createRunFlowTool(mockRegistry());
    const result = asRun(
      await runFlow.execute(
        {},
        { project_root: tmpDir, flow_path: mainPath, device: DEVICE },
        {
          artifacts: new ArtifactStore(),
          fileInputs: {
            flow_path: {
              clientPath: mainPath,
              presentOnHost: true,
              viaUpload: false,
              statVerified: true,
            },
          },
        }
      )
    );

    expect(result.flow).toBe("main");
    expect(result.steps.map((step) => `${step.kind}:${step.status}`)).toEqual([
      "run:pass",
      "echo:pass",
    ]);
    expect(result.steps[1]).toMatchObject({ flow: "login", message: "sibling fragment" });
  });

  it("names the lowercase requirement when only the flow_path extension's case is wrong", async () => {
    const upperPath = path.join(tmpDir, "Main.YAML");
    await fs.writeFile(
      upperPath,
      serializeFlow({ executionPrerequisite: "", steps: [{ kind: "echo", message: "hi" }] }),
      "utf8"
    );

    const runFlow = createRunFlowTool(mockRegistry());
    await expect(
      runFlow.execute(
        {},
        { project_root: tmpDir, flow_path: upperPath, device: DEVICE },
        {
          artifacts: new ArtifactStore(),
          fileInputs: {
            flow_path: {
              clientPath: upperPath,
              presentOnHost: true,
              viaUpload: false,
              statVerified: true,
            },
          },
        }
      )
    ).rejects.toThrow('flow files must use the lowercase .yaml extension, not ".YAML"');
  });

  it("resolves a run: path against the containing flow's own directory, not the root's", async () => {
    // Root (in .argent/flows) → ../../shared/login.yaml → helper.yaml, where
    // helper.yaml is login's OWN sibling in shared/ and absent from the root's
    // directory — only per-file anchoring resolves it.
    const sharedDir = path.join(tmpDir, "shared");
    await fs.mkdir(sharedDir, { recursive: true });
    await fs.writeFile(
      path.join(sharedDir, "helper.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "echo", message: "from helper" }],
      }),
      "utf8"
    );
    await fs.writeFile(
      path.join(sharedDir, "login.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "run", flow: "helper.yaml" }],
      }),
      "utf8"
    );
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [{ kind: "run", flow: "../../shared/login.yaml" }],
    });

    const runFlow = createRunFlowTool(mockRegistry());
    const result = asRun(
      await runFlow.execute({}, { name: "main", project_root: tmpDir, device: DEVICE })
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "run:pass",
      "run:pass",
      "echo:pass",
    ]);
    // Attribution is the basename stem; the report target keeps the as-written path.
    expect(result.steps[0]).toMatchObject({ flow: "login", target: "../../shared/login.yaml" });
    expect(result.steps[1]).toMatchObject({ flow: "helper", target: "helper.yaml" });
    expect(result.steps[2]).toMatchObject({ flow: "helper", message: "from helper" });
    expect(result.ok).toBe(true);
  });

  it("does not flag two different files sharing a basename as a cycle", async () => {
    const subDir = path.join(tmpDir, ".argent", "flows", "sub");
    await fs.mkdir(subDir, { recursive: true });
    await fs.writeFile(
      path.join(subDir, "login.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "echo", message: "inner login" }],
      }),
      "utf8"
    );
    // Root flow "login" runs sub/login.yaml: same stem, different file.
    await writeFlow("login", {
      executionPrerequisite: "",
      steps: [{ kind: "run", flow: "sub/login.yaml" }],
    });

    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "login", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["run:pass", "echo:pass"]);
    expect(result.ok).toBe(true);
  });

  it("disambiguates a fragment whose stem collides with the root flow's name", async () => {
    // Root login.yaml composes helpers/login.yaml — two different files, one
    // stem. A bare-stem attribution would make every fragment step carry
    // flow === the report's top-level flow, and renderers that mark fragment
    // steps by that inequality (the CLI's `[fragment]` suffix) would read a
    // failure inside the fragment as a failure of the root flow itself.
    const helpersDir = path.join(tmpDir, ".argent", "flows", "helpers");
    await fs.mkdir(helpersDir, { recursive: true });
    await fs.writeFile(
      path.join(helpersDir, "login.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "echo", message: "inside the shared fragment" }],
      }),
      "utf8"
    );
    await writeFlow("login", {
      executionPrerequisite: "",
      steps: [{ kind: "run", flow: "helpers/login.yaml" }],
    });

    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "login", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.flow).toBe("login");
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["run:pass", "echo:pass"]);
    // On collision the attribution is the as-written path minus the .yaml
    // extension — never the bare stem, which would equal result.flow — on the
    // run marker and every expanded step alike.
    expect(result.steps[0]).toMatchObject({ flow: "helpers/login", target: "helpers/login.yaml" });
    expect(result.steps[1]).toMatchObject({
      flow: "helpers/login",
      message: "inside the shared fragment",
    });
    expect(result.ok).toBe(true);
  });

  it("keeps the bare stem attribution when the fragment's stem does not collide with the root's", async () => {
    // The SAME fragment as the collision test above, composed from a root
    // with a different name: attribution stays the documented basename stem,
    // because only a root-stem collision makes the stem ambiguous downstream.
    const helpersDir = path.join(tmpDir, ".argent", "flows", "helpers");
    await fs.mkdir(helpersDir, { recursive: true });
    await fs.writeFile(
      path.join(helpersDir, "login.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "echo", message: "inside the shared fragment" }],
      }),
      "utf8"
    );
    await writeFlow("checkout", {
      executionPrerequisite: "",
      steps: [{ kind: "run", flow: "helpers/login.yaml" }],
    });

    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "checkout", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.flow).toBe("checkout");
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["run:pass", "echo:pass"]);
    expect(result.steps[0]).toMatchObject({ flow: "login", target: "helpers/login.yaml" });
    expect(result.steps[1]).toMatchObject({ flow: "login", message: "inside the shared fragment" });
  });

  it("qualifies a nested fragment's bare same-stem spelling as ./<stem>", async () => {
    // Root login.yaml → helpers/steps.yaml → run: login.yaml. The bare
    // spelling resolves against the CONTAINING file's directory, so it names
    // helpers/login.yaml — a genuine fragment, not the root, and no cycle.
    // Stripping the extension off a bare spelling reproduces the stem, which
    // would equal result.flow and drop the renderers' fragment marker; the
    // collision rule qualifies it as ./login — an equivalent spelling of the
    // as-written reference that keeps the inequality.
    const helpersDir = path.join(tmpDir, ".argent", "flows", "helpers");
    await fs.mkdir(helpersDir, { recursive: true });
    await fs.writeFile(
      path.join(helpersDir, "steps.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "run", flow: "login.yaml" }],
      }),
      "utf8"
    );
    await fs.writeFile(
      path.join(helpersDir, "login.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "echo", message: "inside the nested sibling" }],
      }),
      "utf8"
    );
    await writeFlow("login", {
      executionPrerequisite: "",
      steps: [{ kind: "run", flow: "helpers/steps.yaml" }],
    });

    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "login", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.flow).toBe("login");
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "run:pass",
      "run:pass",
      "echo:pass",
    ]);
    // The nested run marker and the fragment's expanded step carry ./login —
    // never the bare "login", which would read as the root flow itself.
    expect(result.steps[1]).toMatchObject({ flow: "./login", target: "login.yaml" });
    expect(result.steps[2]).toMatchObject({
      flow: "./login",
      message: "inside the nested sibling",
    });
    expect(result.steps[1]?.flow).not.toBe(result.flow);
    expect(result.ok).toBe(true);
  });

  it("detects a cycle reached through a different relative spelling", async () => {
    const subDir = path.join(tmpDir, ".argent", "flows", "sub");
    await fs.mkdir(subDir, { recursive: true });
    await writeFlow("a", {
      executionPrerequisite: "",
      steps: [{ kind: "run", flow: "sub/b.yaml" }],
    });
    await fs.writeFile(
      path.join(subDir, "b.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "run", flow: "../a.yaml" }],
      }),
      "utf8"
    );

    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "a", project_root: tmpDir, device: DEVICE }
      )
    );

    const errored = result.steps.find((s) => s.status === "error");
    // The closing hop shares the root's stem (a cycle back to the root always
    // does), so the collision disambiguation renders it as-written — which
    // names the exact edge that closes the loop, rather than the bare "a"
    // that reads like a self-reference from the root's own directory.
    expect(errored?.reason).toMatch(/cyclic flow reference: a → b → \.\.\/a/);
    // Where the as-written path differs from the stem it is the value that
    // locates the reference — `run ../a.yaml`, not a stem-derived fallback.
    expect(errored?.target).toBe("../a.yaml");
  });

  it("anchors a symlinked root flow's run: at the real file's directory", async () => {
    // .argent/flows/main.yaml is a symlink to shared/flows/main.yaml, which
    // references ../helpers/x.yaml. Only the canonical anchor resolves the
    // shared helper; the un-canonicalized one would hit the project decoy.
    const sharedFlows = path.join(tmpDir, "shared", "flows");
    const sharedHelpers = path.join(tmpDir, "shared", "helpers");
    const decoyHelpers = path.join(tmpDir, ".argent", "helpers");
    await fs.mkdir(sharedFlows, { recursive: true });
    await fs.mkdir(sharedHelpers, { recursive: true });
    await fs.mkdir(decoyHelpers, { recursive: true });
    await fs.writeFile(
      path.join(sharedFlows, "main.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "run", flow: "../helpers/x.yaml" }],
      }),
      "utf8"
    );
    await fs.writeFile(
      path.join(sharedHelpers, "x.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "echo", message: "shared helper" }],
      }),
      "utf8"
    );
    await fs.writeFile(
      path.join(decoyHelpers, "x.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "echo", message: "project decoy" }],
      }),
      "utf8"
    );
    const flowsDir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(flowsDir, { recursive: true });
    await fs.symlink(path.join(sharedFlows, "main.yaml"), path.join(flowsDir, "main.yaml"));

    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.ok).toBe(true);
    expect(result.steps[1]).toMatchObject({ kind: "echo", message: "shared helper" });
  });

  it("detects a cycle through a symlinked spelling", async () => {
    const flowsDir = path.join(tmpDir, ".argent", "flows");
    await writeFlow("a", {
      executionPrerequisite: "",
      steps: [{ kind: "run", flow: "alias.yaml" }],
    });
    await fs.symlink(path.join(flowsDir, "a.yaml"), path.join(flowsDir, "alias.yaml"));

    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "a", project_root: tmpDir, device: DEVICE }
      )
    );

    // Exact-match on the whole report, not a substring: the symlink-aware
    // guard trips on the FIRST hop (realpath equates alias.yaml with the
    // running a.yaml), one error step and nothing expanded. Without realpath
    // the run recurses a level before the resolved-path comparison catches
    // it — "a → alias → alias" after an expanded pass — which a substring
    // match on the shorter chain would still accept.
    expect(result.steps.map((s) => `${s.kind}:${s.status}:${s.depth ?? 0}`)).toEqual([
      "run:error:0",
    ]);
    expect(result.steps[0]?.reason).toBe("cyclic flow reference: a → alias");
  });

  it("names a cycle that closes exactly at the run-depth limit as a cycle", async () => {
    // The closing hop back to root fires with a run stack of exactly
    // MAX_RUN_DEPTH — the same hop the depth guard would reject. It is still a
    // loop, and the chain is what tells the author which edge to cut, so the
    // cycle must win here; ordering the depth guard first swallows both.
    const links = MAX_RUN_DEPTH - 1;
    await writeRunChain(links, "root.yaml");

    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "root", project_root: tmpDir, device: DEVICE }
      )
    );

    // The closing hop is the bare spelling `root.yaml`, whose stem is the
    // root's own name — the collision rule qualifies a bare same-stem
    // spelling as `./<stem>`, so the chain's final entry renders as ./root.
    const chain = ["root", ...Array.from({ length: links }, (_, i) => `n${i + 1}`), "./root"];
    const errored = result.steps.find((s) => s.status === "error");
    expect(errored?.reason).toBe(`cyclic flow reference: ${chain.join(" → ")}`);
    expect(errored?.reason).not.toContain("max run depth");
  });

  it("reports a non-cyclic chain past the run-depth limit as excessive depth", async () => {
    // Same shape and same threshold as the cycle above, but every flow is
    // distinct — this is the depth guard's remaining reachable case, and it
    // must keep firing now that the cycle guard precedes it.
    const links = MAX_RUN_DEPTH - 1;
    await writeRunChain(links, `n${MAX_RUN_DEPTH}.yaml`);
    await writeFlow(`n${MAX_RUN_DEPTH}`, {
      executionPrerequisite: "",
      steps: [{ kind: "echo", message: "one hop too deep to reach" }],
    });

    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "root", project_root: tmpDir, device: DEVICE }
      )
    );

    const errored = result.steps.find((s) => s.status === "error");
    expect(errored?.reason).toBe("max run depth exceeded");
    expect(errored?.flow).toBe(`n${MAX_RUN_DEPTH}`);
    // The as-written path rides the depth error too — the report line must
    // name the reference that overflowed, not just the stem.
    expect(errored?.target).toBe(`n${MAX_RUN_DEPTH}.yaml`);
  });

  it("reports a missing run: target as a step error, not a tool-level rejection", async () => {
    // A typo'd or moved fragment path is the most common way a run: fails,
    // and it must land in the per-step report — resolved, ok: false, with the
    // underlying cause — never reject the whole tool call. The catch around
    // the fragment read is the only thing between the two.
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "run", flow: "gone.yaml" },
        { kind: "echo", message: "never reached" },
      ],
    });

    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({
      kind: "run",
      status: "error",
      flow: "gone",
      target: "gone.yaml",
    });
    expect(result.steps[0]?.reason).toMatch(/^could not load fragment "gone\.yaml": /);
    expect(result.steps[0]?.reason).toContain("ENOENT");
    // The failure hard-stops the flow like any other step error.
    expect(result.steps[1]).toMatchObject({ kind: "echo", status: "skip" });
  });

  it("reports a malformed run: target as a step error carrying the parse failure", async () => {
    // The same catch covers parseFlow, so a fragment that exists but does not
    // parse degrades identically — the parse diagnostic reaches the step
    // report instead of rejecting the run.
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [{ kind: "run", flow: "broken.yaml" }],
    });
    // Written raw — serializeFlow could never produce an invalid step.
    await fs.writeFile(
      path.join(tmpDir, ".argent", "flows", "broken.yaml"),
      "steps:\n  - frobnicate: nope\n",
      "utf8"
    );

    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({
      kind: "run",
      status: "error",
      flow: "broken",
      target: "broken.yaml",
    });
    expect(result.steps[0]?.reason).toMatch(/^could not load fragment "broken\.yaml": /);
    expect(result.steps[0]?.reason).toContain("unrecognized step kind");
  });

  it("rejects run: composition when the root flow was uploaded (no shared filesystem)", async () => {
    // A remote client's flow arrives as content and is materialized to a temp
    // file — the files its run: paths reference stayed on the client, and a
    // same-named file on the server must never be read in their place. The
    // rejection is a preflight contract error, so no step (e.g. a leading
    // launch or tap) executes before it fires.
    const uploadedPath = path.join(tmpDir, "materialized-upload.yaml");
    await fs.writeFile(
      uploadedPath,
      serializeFlow({
        executionPrerequisite: "",
        steps: [
          { kind: "echo", message: "before" },
          { kind: "run", flow: "login.yaml" },
          { kind: "echo", message: "after" },
        ],
      }),
      "utf8"
    );
    await fs.writeFile(
      path.join(tmpDir, "login.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "echo", message: "server-local file" }],
      }),
      "utf8"
    );

    const registry = mockRegistry();
    await expect(
      createRunFlowTool(registry).execute(
        {},
        { name: "main", project_root: tmpDir, flow_file: uploadedPath, device: DEVICE },
        {
          artifacts: new ArtifactStore(),
          fileInputs: {
            flow_file: {
              clientPath: "/client/.argent/flows/main.yaml",
              presentOnHost: false,
              viaUpload: true,
            },
          },
        }
      )
    ).rejects.toThrow(/co-located/i);
    // Preflight, not mid-run: nothing was dispatched to the device.
    expect(registry.invokeTool).not.toHaveBeenCalled();
  });

  it("rejects an uploaded flow whose run: hides behind a when: block that would not fire", async () => {
    // Without the preflight walking when: children, this flow reports green on
    // iOS and only errors when the android guard first fires (e.g. in CI).
    const uploadedPath = path.join(tmpDir, "materialized-upload.yaml");
    await fs.writeFile(
      uploadedPath,
      "steps:\n  - when:\n      platform: android\n    steps:\n      - run: login.yaml\n",
      "utf8"
    );

    await expect(
      createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "main", project_root: tmpDir, flow_file: uploadedPath, device: DEVICE },
        {
          artifacts: new ArtifactStore(),
          fileInputs: {
            flow_file: {
              clientPath: "/client/.argent/flows/main.yaml",
              presentOnHost: false,
              viaUpload: true,
            },
          },
        }
      )
    ).rejects.toThrow(/co-located/i);
  });

  it("attributes a hard-stop-skipped run: step to its target stem, like every other path", async () => {
    await writeFlow("login", {
      executionPrerequisite: "",
      steps: [{ kind: "echo", message: "never runs" }],
    });
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: { android: "com.acme.app" } }, // DEVICE is iOS → errors
        { kind: "run", flow: "login.yaml" },
      ],
    });

    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["launch:error", "run:skip"]);
    // Same attribution as an executed/errored run marker: the target stem,
    // with the as-written path in target — not the enclosing flow.
    expect(result.steps[1]).toMatchObject({ flow: "login", target: "login.yaml" });
  });

  it("applies the root-stem collision disambiguation on the hard-stop skip path too", async () => {
    // Same setup as above, but the root shares the fragment's stem — the skip
    // report must carry the same disambiguated name an executed run marker
    // would, or attribution would depend on whether the step ever ran.
    const helpersDir = path.join(tmpDir, ".argent", "flows", "helpers");
    await fs.mkdir(helpersDir, { recursive: true });
    await fs.writeFile(
      path.join(helpersDir, "login.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "echo", message: "never runs" }],
      }),
      "utf8"
    );
    await writeFlow("login", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: { android: "com.acme.app" } }, // DEVICE is iOS → errors
        { kind: "run", flow: "helpers/login.yaml" },
      ],
    });

    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "login", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["launch:error", "run:skip"]);
    expect(result.steps[1]).toMatchObject({ flow: "helpers/login", target: "helpers/login.yaml" });
  });

  it("attributes a fragment's when marker and skipped block steps to the fragment, not the root", async () => {
    // A platform guard is static (no tree fetch) and android never matches the
    // iOS DEVICE, so the block skips with the fragment on the run stack. The
    // marker line (execWhenStep) and the authored-step skip line
    // (reportBlockSkipped → stepFlow's non-run branch) each derive attribution
    // separately — all of them must name the fragment, or the CLI's
    // `[fragment]` suffix would tag these lines with the wrong flow.
    await writeFlow("frag", {
      executionPrerequisite: "",
      steps: [
        { kind: "echo", message: "inside fragment" },
        {
          kind: "when",
          condition: { kind: "platform", platform: "android" },
          steps: [{ kind: "echo", message: "android only" }],
        },
      ],
    });
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [{ kind: "run", flow: "frag.yaml" }],
    });

    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "run:pass",
      "echo:pass",
      "when:skip",
      "echo:skip",
    ]);
    // Executed echo, unmet-guard marker, and block-skip line: all "frag".
    expect(result.steps[1]).toMatchObject({ flow: "frag", message: "inside fragment" });
    expect(result.steps[2]).toMatchObject({ flow: "frag", depth: 1 });
    expect(result.steps[3]).toMatchObject({ flow: "frag", depth: 2, message: "android only" });
    expect(result.ok).toBe(true);
  });

  it("attributes hard-stop skips inside a fragment to the fragment, and the root's own to the root", async () => {
    // The fragment's leading launch declares no iOS app id, so it errors and
    // hard-stops the run with the fragment still on the stack. Every post-stop
    // skip line inside the fragment — plain step, when marker, and the when
    // block's expansion — must stay attributed to the fragment, while the
    // root's trailing step flips back to the root: attribution follows the
    // run stack, not where the stop happened.
    await writeFlow("frag", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: { android: "com.acme.app" } }, // DEVICE is iOS → errors
        { kind: "echo", message: "fragment echo" },
        {
          kind: "when",
          condition: { kind: "platform", platform: "ios" },
          steps: [{ kind: "echo", message: "guarded echo" }],
        },
      ],
    });
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "run", flow: "frag.yaml" },
        { kind: "echo", message: "root echo" },
      ],
    });

    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "run:pass",
      "launch:error",
      "echo:skip",
      "when:skip",
      "echo:skip",
      "echo:skip",
    ]);
    expect(result.steps[2]).toMatchObject({ flow: "frag", message: "fragment echo" });
    expect(result.steps[3]).toMatchObject({ flow: "frag", kind: "when" });
    expect(result.steps[4]).toMatchObject({ flow: "frag", message: "guarded echo" });
    expect(result.steps[5]).toMatchObject({ flow: "main", message: "root echo" });
    expect(result.ok).toBe(false);
  });

  it("keys and stores a composed fragment's snapshot with the root flow", async () => {
    const sharedDir = path.join(tmpDir, "shared");
    await fs.mkdir(sharedDir, { recursive: true });
    await fs.writeFile(
      path.join(sharedDir, "visual.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "snapshot", name: "home", maxMismatch: 0.5 }],
      }),
      "utf8"
    );
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [{ kind: "run", flow: "../../shared/visual.yaml" }],
    });

    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.ok).toBe(true);
    // The snapshot ran from shared/visual.yaml but stays anchored to the ROOT
    // flow: baselines under the root flow's directory, keyed by the root name.
    expect(vi.mocked(runSnapshot)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        flowsDir: path.join(tmpDir, ".argent", "flows"),
        flowName: "main",
      })
    );
  });

  it("anchors a symlinked root flow's snapshot baselines beside the real file", async () => {
    // .argent/flows/visual.yaml is a symlink to shared/flows/visual.yaml. The
    // baseline anchor must be the real file's directory — the same canonical
    // anchor `run:` targets resolve against — not the symlink's spelling, or
    // one root file reached through two spellings would keep two baseline sets.
    const sharedFlows = path.join(tmpDir, "shared", "flows");
    await fs.mkdir(sharedFlows, { recursive: true });
    await fs.writeFile(
      path.join(sharedFlows, "visual.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "snapshot", name: "home", maxMismatch: 0.5 }],
      }),
      "utf8"
    );
    const flowsDir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(flowsDir, { recursive: true });
    await fs.symlink(path.join(sharedFlows, "visual.yaml"), path.join(flowsDir, "visual.yaml"));

    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "visual", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.ok).toBe(true);
    // The real directory, not the spelling the run was addressed by.
    expect(vi.mocked(runSnapshot)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ flowsDir: sharedFlows, flowName: "visual" })
    );
  });

  it("stamps nesting depth on expanded fragment steps (omitted at top level)", async () => {
    await writeFlow("inner", {
      executionPrerequisite: "",
      steps: [{ kind: "echo", message: "deepest" }],
    });
    await writeFlow("login", {
      executionPrerequisite: "",
      steps: [
        { kind: "tool", name: "tap", args: { x: 0.5 } },
        { kind: "run", flow: "inner.yaml" },
      ],
    });
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "run", flow: "login.yaml" },
        { kind: "echo", message: "done" },
      ],
    });

    const runFlow = createRunFlowTool(mockRegistry());
    const result = asRun(
      await runFlow.execute({}, { name: "main", project_root: tmpDir, device: DEVICE })
    );

    // Each run marker sits at its enclosing depth; the fragment it expands runs
    // one deeper. Top-level steps omit the field entirely, so a flow with no
    // block directives reports byte-identically to the pre-depth shape.
    expect(result.steps.map((s) => `${s.kind}:${s.depth ?? 0}`)).toEqual([
      "run:0",
      "tool:1",
      "run:1",
      "echo:2",
      "echo:0",
    ]);
    expect(result.steps[0].depth).toBeUndefined();
    expect(result.steps[4].depth).toBeUndefined();
  });

  it("expands a referenced e2e flow inline, launch step and all", async () => {
    await writeFlow("other-e2e", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: "com.acme.app" },
        { kind: "echo", message: "in nested e2e" },
      ],
    });
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [{ kind: "run", flow: "other-e2e.yaml" }],
    });
    const runFlow = createRunFlowTool(mockRegistry());
    const result = asRun(
      await runFlow.execute({}, { name: "main", project_root: tmpDir, device: DEVICE })
    );
    // run marker, then the nested e2e's launch + echo expanded inline.
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "run:pass",
      "launch:pass",
      "echo:pass",
    ]);
    expect(result.steps[1].flow).toBe("other-e2e");
    expect(result.ok).toBe(true);
  });

  it("runs a nested flow-execute against the run device, not the recorded one (issue #607)", async () => {
    // The raw `tool: flow-execute` form is what the recorder falls back to when
    // the target is not a resolvable sibling — and what a remote recording always
    // produces. Its device parameter is named `device`, which was not a bind key,
    // so the sub-run drove the id baked in at record time. Here the flow carries
    // a device that does not exist while the run is given a real one.
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "tool",
          name: "flow-execute",
          args: { name: "b-only", project_root: "/elsewhere", device: "STALE-ID" },
        },
      ],
    });

    // Single step + explicit device, per mockRegistry's contract.
    const registry = mockRegistry({ name: {}, project_root: {}, device: {} });
    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(registry.invokeTool).toHaveBeenCalledWith(
      "flow-execute",
      expect.objectContaining({ device: DEVICE })
    );
    expect(registry.invokeTool).not.toHaveBeenCalledWith(
      "flow-execute",
      expect.objectContaining({ device: "STALE-ID" })
    );
    expect(result.ok).toBe(true);
  });

  it("detects a cyclic run reference", async () => {
    await writeFlow("a", { executionPrerequisite: "", steps: [{ kind: "run", flow: "b.yaml" }] });
    await writeFlow("b", { executionPrerequisite: "", steps: [{ kind: "run", flow: "a.yaml" }] });
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [{ kind: "run", flow: "a.yaml" }],
    });
    const runFlow = createRunFlowTool(mockRegistry());
    const result = asRun(
      await runFlow.execute({}, { name: "main", project_root: tmpDir, device: DEVICE })
    );
    const errored = result.steps.find((s) => s.status === "error");
    expect(errored?.reason).toMatch(/cyclic/i);
    // The chain renders the human-readable stems, not canonical paths.
    expect(errored?.reason).toContain("main → a → b → a");
    // The error report carries the as-written path: on a failed resolution it
    // is what locates the bad reference (`run ../shared/x.yaml`, not a bare
    // stem), and stepLabel in argent-mcp falls back to the stem without it.
    expect(errored?.target).toBe("a.yaml");
    // The cycle is detected two fragments down; its error marker keeps that
    // depth (the fail() path stamps depthOf(scope) like the success marker),
    // so the error line renders inside the block that caused it.
    expect(result.steps.map((s) => `${s.kind}:${s.status}:${s.depth ?? 0}`)).toEqual([
      "run:pass:0",
      "run:pass:1",
      "run:error:2",
    ]);
  });

  it("executes a leading launch step from scratch (restart-app) and reports it", async () => {
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: "com.acme.app" },
        { kind: "echo", message: "running" },
      ],
    });
    const registry = mockRegistry();
    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["launch:pass", "echo:pass"]);
    // e2e contract: terminate + relaunch, so a running copy can't leak state.
    expect(registry.invokeTool).toHaveBeenCalledWith("restart-app", { bundleId: "com.acme.app" });
    expect(result.ok).toBe(true);
  });

  it("errors the launch step when no app id is declared for the platform", async () => {
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: { android: "com.acme.app" } }, // DEVICE is iOS
        { kind: "echo", message: "should never run" },
      ],
    });
    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["launch:error", "echo:skip"]);
    expect(result.steps[0].reason).toMatch(/no app id declared for platform/i);
    expect(result.ok).toBe(false);
  });

  it("errors the launch step when native devtools never connects on iOS", async () => {
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: "com.acme.app" },
        { kind: "echo", message: "should never run" },
      ],
    });
    // Registry whose native-devtools service is unavailable: the launch step
    // must fail rather than let selectors silently fall back to the AX tree.
    // (An unresolvable service fails fast; a resolvable-but-never-connected
    // one hits the same guard after the connect timeout.)
    const registry = {
      invokeTool: vi.fn(async (id: string) =>
        id === "list-devices" ? { devices: [] } : { ok: true }
      ),
      getTool: vi.fn(() => undefined),
      resolveService: vi.fn(async () => {
        throw new Error("native-devtools unavailable");
      }),
    } as unknown as Registry;

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["launch:error", "echo:skip"]);
    expect(result.steps[0].reason).toMatch(/could not connect to native devtools/i);
    expect(result.ok).toBe(false);
  });
});

describe("device binding (portability)", () => {
  const reg = (props: Record<string, unknown>) =>
    ({ getTool: () => ({ inputSchema: { properties: props } }) }) as unknown as Registry;

  it("the resolved device wins over a stale stored udid", () => {
    const out = bindDeviceArgs(reg({ udid: {}, x: {}, y: {} }), "gesture-tap", "RESOLVED", {
      udid: "STALE",
      x: 0.5,
      y: 0.5,
    });
    expect(out).toEqual({ udid: "RESOLVED", x: 0.5, y: 0.5 });
  });

  it("drops a device id entirely for a tool that doesn't declare one", () => {
    const out = bindDeviceArgs(reg({ foo: {} }), "x", "R", { device_id: "STALE", foo: 1 });
    expect(out).toEqual({ foo: 1 });
  });

  it("stripDeviceKeys removes udid / device_id / device", () => {
    expect(stripDeviceKeys({ udid: "A", device_id: "B", device: "C", x: 1 })).toEqual({ x: 1 });
  });

  it("rebinds a nested flow-execute onto the run device (issue #607)", () => {
    // `flow-execute`'s own device parameter is named `device`, so before it was
    // a bind key a recorded nested step kept the id it was recorded on and the
    // sub-run drove that device instead of the one the replay was given.
    const out = bindDeviceArgs(
      reg({ name: {}, project_root: {}, device: {} }),
      "flow-execute",
      "RESOLVED",
      { name: "b", project_root: "/p", device: "STALE" }
    );
    expect(out).toEqual({ name: "b", project_root: "/p", device: "RESOLVED" });
  });

  it("leaves `platform` alone", () => {
    // Deliberate, and pinned here so a later "symmetry" edit fails loudly. The
    // strip is schema-blind, and `platform` is not device-specific on every tool
    // — react-profiler-analyze declares its own — so stripping it would silently
    // retarget an unrelated recorded step. It is also inert once `device` is
    // bound, because device resolution returns before it is ever read.
    expect(stripDeviceKeys({ platform: "android", x: 1 })).toEqual({ platform: "android", x: 1 });
  });
});

describe("flow validation", () => {
  it("rejects an e2e flow that declares executionPrerequisite", () => {
    expect(() =>
      parseFlow("executionPrerequisite: nope\nsteps:\n  - launch: com.acme.app\n")
    ).toThrow(/must not declare executionPrerequisite/i);
  });

  it("a leading echo does not hide the launch step from the e2e check", () => {
    expect(() =>
      parseFlow(
        "executionPrerequisite: nope\nsteps:\n  - echo: starting\n  - launch: com.acme.app\n"
      )
    ).toThrow(/must not declare executionPrerequisite/i);
  });

  it("rejects a path-unsafe snapshot name (no traversal into baseline path)", () => {
    expect(() => parseFlow("steps:\n  - snapshot:\n      name: ../../etc/evil\n")).toThrow(
      /snapshot name/i
    );
  });

  it("rejects a bare saved-flow name in run: with a migration hint", () => {
    expect(() => parseFlow("steps:\n  - run: login\n")).toThrow(/did you mean `run: login\.yaml`/);
  });

  it("reports a missing target instead of a null.yaml migration hint for a valueless run:", () => {
    for (const body of ["", " ~", " null"]) {
      expect(() => parseFlow(`steps:\n  - run:${body}\n`)).toThrow(/`run` has no target/);
      expect(() => parseFlow(`steps:\n  - run:${body}\n`)).not.toThrow(/null\.yaml/);
    }
  });

  it("rejects a non-string run: scalar instead of migrating it to a filename", () => {
    expect(() => parseFlow("steps:\n  - run: true\n")).toThrow(/must be a YAML path string/);
    expect(() => parseFlow("steps:\n  - run: true\n")).not.toThrow(/true\.yaml/);
    expect(() => parseFlow("steps:\n  - run: 123\n")).toThrow(/must be a YAML path string/);
    expect(() => parseFlow("steps:\n  - run: 123\n")).not.toThrow(/123\.yaml/);
  });

  it("rejects a run: path without the .yaml extension", () => {
    expect(() => parseFlow("steps:\n  - run: flows/login.yml\n")).toThrow(/must end in \.yaml/);
    // A correctly-typed empty string is a string, so it still reaches the
    // extension check — this boundary is what keeps the non-string rejection
    // above targeted at YAML scalars rather than at "no path here" generally.
    expect(() => parseFlow('steps:\n  - run: ""\n')).toThrow(/must end in \.yaml/);
  });

  it("names the lowercase requirement when only the run: extension's case is wrong", () => {
    expect(() => parseFlow("steps:\n  - run: shared/Login.YAML\n")).toThrow(
      /lowercase \.yaml extension/
    );
  });

  it("rejects an absolute run: path", () => {
    expect(() => parseFlow("steps:\n  - run: /anywhere/login.yaml\n")).toThrow(/must be relative/);
    expect(() => parseFlow("steps:\n  - run: C:/anywhere/login.yaml\n")).toThrow(
      /must be relative/
    );
    // Drive-relative: not isAbsolute, but resolves against the drive's cwd.
    expect(() => parseFlow("steps:\n  - run: C:foo/login.yaml\n")).toThrow(/must be relative/);
  });

  it("rejects a run: path whose filename is not a safe flow name", () => {
    expect(() => parseFlow("steps:\n  - run: ../we!rd.yaml\n")).toThrow(/letters, digits/);
  });

  it("cites a pattern a rejected .yaml filename could actually match", () => {
    // `my.flow.yaml` IS a .yaml file, so citing the dot-free flow-name pattern
    // would demand a regex forbidding the extension the same check requires.
    let message = "";
    try {
      parseFlow("steps:\n  - run: my.flow.yaml\n");
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain(String(FLOW_FILE_NAME_PATTERN));
    expect(message).not.toContain(String(FLOW_NAME_PATTERN));
    expect(message).toMatch(/letters, digits, underscore, hyphen before the \.yaml/);
  });

  it("rejects backslashes in a run: path", () => {
    expect(() => parseFlow("steps:\n  - run: frag\\login.yaml\n")).toThrow(/forward slashes/);
  });

  it("round-trips the new step kinds through YAML", () => {
    const flow = {
      executionPrerequisite: "",
      steps: [
        { kind: "launch" as const, app: "com.acme.app" },
        // Text-only selectors serialize to bare strings, which parse back loose.
        { kind: "tap" as const, selector: { text: "Login", loose: true } },
        { kind: "tap" as const, x: 0.5, y: 0.57 },
        { kind: "type" as const, into: { identifier: "email" }, text: "a@b.com" },
        {
          kind: "assert" as const,
          condition: "visible" as const,
          selector: { text: "Welcome", loose: true },
        },
        { kind: "snapshot" as const, name: "home", maxMismatch: 0.5 },
        { kind: "run" as const, flow: "../shared/login.yaml" },
        // Mid-flow relaunch with a per-platform map.
        { kind: "launch" as const, app: { ios: "com.acme.app", android: "com.acme.android" } },
      ],
    };
    const parsed = parseFlow(serializeFlow(flow));
    expect(parsed.steps).toEqual(flow.steps);
  });

  it("rejects a launch step with an invalid body", () => {
    // An unrecognized platform key is named (strict unknown-key rejection)…
    expect(() => parseFlow("steps:\n  - launch: { web: foo }\n")).toThrow(
      /launch has unknown key `web`/
    );
    // …while a non-map, non-string body still gets the shape error.
    expect(() => parseFlow("steps:\n  - launch: 42\n")).toThrow(/launch needs an app id/i);
  });
});
