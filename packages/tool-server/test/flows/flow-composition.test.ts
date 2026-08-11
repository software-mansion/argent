import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  ArtifactStore,
  FLOW_FILE_NAME_PATTERN,
  FLOW_NAME_PATTERN,
  getFailureSignal,
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

// Mock the Electron launcher: no test here may legitimately reach it — the
// chromium-ordering test below pins exactly that — so a misplaced upload guard
// records a boot attempt instead of spawning a real process.
const bootElectronApp = vi.fn(async () => ({
  platform: "chromium" as const,
  id: "chromium-cdp-12345",
  port: 12345,
  pid: 4242,
  appPath: "/abs/e2e-app",
  booted: true as const,
}));
vi.mock("../../src/tools/devices/boot-electron", () => ({
  bootElectronApp: (...args: unknown[]) =>
    (bootElectronApp as (...a: unknown[]) => unknown)(...args),
  killChromiumByPort: vi.fn(),
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

  it("composes a bare run: name from the containing flow's own directory", async () => {
    // The legacy layout: both flows saved flat in .argent/flows, main written
    // when a run: target was a saved-flow NAME resolved in that directory. A
    // bare target now anchors to the containing file's directory instead —
    // which for this layout IS that directory, so the flow replays unchanged.
    await writeFlow("login", {
      executionPrerequisite: "On login screen",
      steps: [{ kind: "echo", message: "logging in" }],
    });
    await fs.writeFile(
      path.join(tmpDir, ".argent", "flows", "main.yaml"),
      "steps:\n  - run: login\n  - echo: done\n",
      "utf8"
    );

    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "run:pass",
      "echo:pass",
      "echo:pass",
    ]);
    // Parse completed the extension, so the report names the file it opened
    // while attribution keeps the same stem the spelled-out form produces.
    expect(result.steps[0]).toMatchObject({ target: "login.yaml", flow: "login" });
    expect(result.steps[1].flow).toBe("login");
  });

  it("resolves a bare run: name against a nested fragment's directory", async () => {
    // The one place the two schemes disagree: a bare name inside a fragment
    // that does NOT sit in the flows dir root. `helpers/steps.yaml` composing
    // `login` gets helpers/login.yaml — its own sibling — not the flows-dir
    // copy a name lookup would have found. Both exist here with different
    // messages, so the assertion distinguishes them.
    const helpers = path.join(tmpDir, ".argent", "flows", "helpers");
    await fs.mkdir(helpers, { recursive: true });
    await writeFlow("login", {
      executionPrerequisite: "",
      steps: [{ kind: "echo", message: "FLOWS-DIR-COPY" }],
    });
    await fs.writeFile(
      path.join(helpers, "login.yaml"),
      "steps:\n  - echo: HELPERS-SIBLING\n",
      "utf8"
    );
    await fs.writeFile(path.join(helpers, "steps.yaml"), "steps:\n  - run: login\n", "utf8");
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [{ kind: "run", flow: "helpers/steps.yaml" }],
    });

    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.message)).toContain("HELPERS-SIBLING");
    expect(result.steps.map((s) => s.message)).not.toContain("FLOWS-DIR-COPY");
  });

  it("refuses a bare run: name whose casing is not the one on disk", async () => {
    // Completing the extension must not open a casing hole: `run: Login`
    // becomes Login.yaml and meets the same on-disk spelling gate as the
    // spelled-out form, so a macOS-green / Linux-red tree is still refused.
    await writeFlow("login", {
      executionPrerequisite: "",
      steps: [{ kind: "echo", message: "RAN-THE-LOWERCASE-FILE" }],
    });
    await fs.writeFile(
      path.join(tmpDir, ".argent", "flows", "main.yaml"),
      "steps:\n  - run: Login\n",
      "utf8"
    );

    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.ok).toBe(false);
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["run:error"]);
    expect(result.steps[0]?.reason ?? "").toMatch(/^mis-cased fragment reference "Login\.yaml": /);
    expect(result.steps.map((s) => s.message)).not.toContain("RAN-THE-LOWERCASE-FILE");
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

  it("applies the root-stem collision disambiguation to a failed run: report too", async () => {
    // Root login.yaml references helpers/login.yaml, which is MISSING — a
    // moved or deleted fragment is the most common way a run: fails, and the
    // errored marker (execRunStep's fail(), which stamps `flow: display`) is
    // the line that names the missing file. Every other test reaching fail()
    // uses a non-colliding root, so weakening just that line to the bare stem
    // (`flow: runTargetName(target)`) would slip through the rest of the
    // suite — here it would collapse flow to "login" === result.flow, and
    // renderers that mark fragment lines by that inequality (the CLI's
    // `[fragment]` suffix) would read the load failure as the root flow's own.
    const helpersDir = path.join(tmpDir, ".argent", "flows", "helpers");
    await fs.mkdir(helpersDir, { recursive: true });
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

    expect(result.ok).toBe(false);
    expect(result.flow).toBe("login");
    expect(result.steps[0]).toMatchObject({
      kind: "run",
      status: "error",
      flow: "helpers/login",
      target: "helpers/login.yaml",
    });
    expect(result.steps[0]?.reason).toMatch(/^could not load fragment "helpers\/login\.yaml": /);
    expect(result.steps[0]?.reason).toContain("ENOENT");
    // The exact inequality renderers key on to mark fragment lines.
    expect(result.steps[0]?.flow).not.toBe(result.flow);
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

  it("collides a fragment's stem against a symlinked root's SPELLED name, not its real file's", async () => {
    // .argent/flows/smoke.yaml is a symlink to shared/flows/main.yaml —
    // renaming on the link side is the ordinary reason to symlink a saved
    // flow — whose only step is run: helpers/smoke.yaml. The fragment's stem
    // "smoke" collides with the SPELLED root name (what result.flow carries),
    // not the real file's stem "main", so the disambiguation must fire.
    // Seeding the runStack with the canonical stem instead — `display:
    // path.basename(canonicalPath, ".yaml")` in execute()'s seed — survives
    // every other fixture, because each one points its symlink at a real file
    // with the SAME basename (the two candidate values are equal); here it
    // collapses the fragment's flow to "smoke" === result.flow, and renderers
    // that mark fragment steps by that inequality (the CLI's `[fragment]`
    // suffix) would print the fragment's steps as the root flow's own.
    const sharedFlows = path.join(tmpDir, "shared", "flows");
    const sharedHelpers = path.join(sharedFlows, "helpers");
    await fs.mkdir(sharedHelpers, { recursive: true });
    await fs.writeFile(
      path.join(sharedFlows, "main.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "run", flow: "helpers/smoke.yaml" }],
      }),
      "utf8"
    );
    await fs.writeFile(
      path.join(sharedHelpers, "smoke.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "echo", message: "inside the shared fragment" }],
      }),
      "utf8"
    );
    const flowsDir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(flowsDir, { recursive: true });
    await fs.symlink(path.join(sharedFlows, "main.yaml"), path.join(flowsDir, "smoke.yaml"));

    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "smoke", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.ok).toBe(true);
    expect(result.flow).toBe("smoke");
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["run:pass", "echo:pass"]);
    // The run marker and the fragment's expanded step both carry the
    // as-written path minus the extension — never the bare stem.
    expect(result.steps[0]).toMatchObject({ flow: "helpers/smoke", target: "helpers/smoke.yaml" });
    expect(result.steps[1]).toMatchObject({
      flow: "helpers/smoke",
      message: "inside the shared fragment",
    });
    // The exact inequality renderers key on to mark fragment lines.
    expect(result.steps[0]?.flow).not.toBe(result.flow);
    expect(result.steps[1]?.flow).not.toBe(result.flow);
  });

  it("resolves a run: `..` after a symlinked component with kernel semantics", async () => {
    // .argent/flows/link is a symlink to lex/other, so on disk
    // `link/../frag.yaml` means lex/frag.yaml — `..` names the parent of the
    // link's TARGET. A lexical collapse of the spelling (path.resolve before
    // realpath) instead names the flows-dir sibling frag.yaml; with a decoy
    // planted there, only kernel-faithful resolution runs the file the
    // written path denotes.
    const lexDir = path.join(tmpDir, "lex");
    await fs.mkdir(path.join(lexDir, "other"), { recursive: true });
    await fs.writeFile(
      path.join(lexDir, "frag.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "echo", message: "kernel-resolved fragment" }],
      }),
      "utf8"
    );
    await writeFlow("frag", {
      executionPrerequisite: "",
      steps: [{ kind: "echo", message: "lexical decoy" }],
    });
    await writeFlow("root", {
      executionPrerequisite: "",
      steps: [{ kind: "run", flow: "link/../frag.yaml" }],
    });
    const flowsDir = path.join(tmpDir, ".argent", "flows");
    await fs.symlink(path.join(lexDir, "other"), path.join(flowsDir, "link"));

    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "root", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["run:pass", "echo:pass"]);
    expect(result.steps[1]).toMatchObject({ kind: "echo", message: "kernel-resolved fragment" });
    expect(result.steps.map((s) => s.message)).not.toContain("lexical decoy");
  });

  it("errors on a run: `..` through a dangling symlink instead of executing a lexical impostor", async () => {
    // .argent/flows/dangling points at a missing target, so the kernel refuses
    // the spelling `dangling/../frag.yaml` with ENOENT — realpath fails on both
    // the full path and its dirname. A lexical collapse of the spelling would
    // name the flows-dir sibling frag.yaml (planted as a decoy) and run it with
    // run:pass; the fallback must instead surface the kernel's ENOENT for the
    // spelling itself and never execute the decoy.
    await writeFlow("frag", {
      executionPrerequisite: "",
      steps: [{ kind: "echo", message: "lexical decoy" }],
    });
    await writeFlow("root", {
      executionPrerequisite: "",
      steps: [{ kind: "run", flow: "dangling/../frag.yaml" }],
    });
    const flowsDir = path.join(tmpDir, ".argent", "flows");
    await fs.symlink(path.join(tmpDir, "gone"), path.join(flowsDir, "dangling"));

    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "root", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.ok).toBe(false);
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["run:error"]);
    expect(result.steps[0]?.reason).toMatch(/could not load fragment "dangling\/\.\.\/frag\.yaml"/);
    expect(result.steps[0]?.reason).toMatch(/ENOENT/);
    expect(result.steps.map((s) => s.message)).not.toContain("lexical decoy");
  });

  it("runs a run: target that reaches above the project root", async () => {
    // There is no path fence on `run:`. A target is reachable when the tool
    // server can read it — the same reach the front door already grants,
    // since flow_path can name any YAML on the host. The old fence made
    // admission depend on project_root, which the CLI sets to the operator's
    // cwd, so the identical file passed from the repo root and failed from a
    // subdirectory. Project root is proj/, the target resolves above it, and
    // it must run.
    const proj = path.join(tmpDir, "proj");
    const flowsDir = path.join(proj, ".argent", "flows");
    await fs.mkdir(flowsDir, { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "outside.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "echo", message: "executed from outside project root" }],
      }),
      "utf8"
    );
    await fs.writeFile(
      path.join(flowsDir, "main.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "run", flow: "../../../outside.yaml" }],
      }),
      "utf8"
    );

    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "main", project_root: proj, device: DEVICE }
      )
    );

    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["run:pass", "echo:pass"]);
    expect(result.steps[0]).toMatchObject({ flow: "outside", target: "../../../outside.yaml" });
    expect(result.steps[1]).toMatchObject({ message: "executed from outside project root" });
  });

  it("reports a MISSING target above the project root as that file's own ENOENT", async () => {
    // With the fence gone, a target that resolves nowhere gets the ordinary
    // per-file load error naming the as-written spelling — the same report an
    // in-project typo produces, wherever it points. The old boundary error
    // ("resolves outside the project root") answered a typo above the root
    // with a policy message about a boundary that no longer exists, sending
    // the author to look at project_root instead of at the spelling.
    const proj = path.join(tmpDir, "proj");
    const flowsDir = path.join(proj, ".argent", "flows");
    await fs.mkdir(flowsDir, { recursive: true });
    await fs.writeFile(
      path.join(flowsDir, "main.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "run", flow: "../../../nothing-here.yaml" }],
      }),
      "utf8"
    );

    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "main", project_root: proj, device: DEVICE }
      )
    );

    expect(result.ok).toBe(false);
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["run:error"]);
    expect(result.steps[0]?.reason).toMatch(
      /could not load fragment "\.\.\/\.\.\/\.\.\/nothing-here\.yaml"/
    );
    expect(result.steps[0]?.reason).toMatch(/ENOENT/);
  });

  it("gives the same verdict for one flow file under two different project_root values", async () => {
    // The regression the fence caused: admission was decided by
    // `params.project_root`, which `argent flow run` sets to process.cwd(),
    // so `cd packages/app && argent flow run .argent/flows/e2e.yaml` failed
    // while the identical file passed from the repo root — green locally, red
    // in CI, for a reason nothing in the flow file expresses. The two roots
    // here STRADDLE the target: shared/login.yaml sits under tmpDir, which the
    // old fence's project-root zone admitted, and outside proj, which neither
    // that zone nor the containing file's directory (proj/.argent/flows)
    // covered — so the fence passed the first and refused the second. Same
    // flow_path, same sideways `run:` target: the two must now reach the same
    // verdict and execute the fragment.
    const proj = path.join(tmpDir, "proj");
    const flowsDir = path.join(proj, ".argent", "flows");
    const sharedDir = path.join(tmpDir, "shared");
    await fs.mkdir(flowsDir, { recursive: true });
    await fs.mkdir(sharedDir, { recursive: true });
    await fs.writeFile(
      path.join(sharedDir, "login.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "echo", message: "shared login" }],
      }),
      "utf8"
    );
    const mainPath = path.join(flowsDir, "main.yaml");
    await fs.writeFile(
      mainPath,
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "run", flow: "../../../shared/login.yaml" }],
      }),
      "utf8"
    );

    // The flow_path route with a boundary-resolved, stat-verified client path
    // is exactly what `argent flow run` sends (see packages/argent-cli/src/flow.ts).
    const runFrom = async (projectRoot: string): Promise<FlowRunResult> =>
      asRun(
        await createRunFlowTool(mockRegistry()).execute(
          {},
          { project_root: projectRoot, flow_path: mainPath, device: DEVICE },
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

    const fromAboveProject = await runFrom(tmpDir);
    const fromProject = await runFrom(proj);

    for (const result of [fromAboveProject, fromProject]) {
      expect(result.ok).toBe(true);
      expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["run:pass", "echo:pass"]);
      expect(result.steps[1]).toMatchObject({ flow: "login", message: "shared login" });
    }
  });

  it("runs a symlinked-out vendored tree's own subtree fragments", async () => {
    // The vault/vendored layout with the real tree OUTSIDE the project root:
    // proj/.argent/flows/main.yaml is a symlink to vendor/flows/main.yaml,
    // which composes helpers/x.yaml below its own real directory. Every path
    // here is anchored on the containing file's CANONICAL directory, so the
    // fragment is looked up beside the real main.yaml in vendor/flows, not
    // beside the symlink in the project — which is what makes the
    // SKILL-recommended shared-tree layout work at all.
    const proj = path.join(tmpDir, "proj");
    const projFlows = path.join(proj, ".argent", "flows");
    const vendorFlows = path.join(tmpDir, "vendor", "flows");
    await fs.mkdir(projFlows, { recursive: true });
    await fs.mkdir(path.join(vendorFlows, "helpers"), { recursive: true });
    await fs.writeFile(
      path.join(vendorFlows, "helpers", "x.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "echo", message: "vendored helper" }],
      }),
      "utf8"
    );
    await fs.writeFile(
      path.join(vendorFlows, "main.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "run", flow: "helpers/x.yaml" }],
      }),
      "utf8"
    );
    await fs.symlink(path.join(vendorFlows, "main.yaml"), path.join(projFlows, "main.yaml"));

    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "main", project_root: proj, device: DEVICE }
      )
    );

    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["run:pass", "echo:pass"]);
    expect(result.steps[1]).toMatchObject({ kind: "echo", message: "vendored helper" });
  });

  it("lets a nested fragment in a symlinked-out tree reach a sibling of its root flow", async () => {
    // Same vendored layout, one level deeper: main.yaml → helpers/b.yaml →
    // ../sibling.yaml, where sibling.yaml sits beside main.yaml in the vendor
    // tree. This is the case the review filed. The old fence narrowed on
    // every descent — from helpers/ the admitted zone was helpers/ itself,
    // and the vendor tree is by definition not under the project root — so a
    // fragment could reach that sibling from main.yaml but not from one
    // directory down, capping a shared flows tree at a single level. Nothing
    // narrows now: each hop anchors on its own containing file's canonical
    // directory and the target is read if it is there.
    const proj = path.join(tmpDir, "proj");
    const projFlows = path.join(proj, ".argent", "flows");
    const vendorFlows = path.join(tmpDir, "vendor", "flows");
    await fs.mkdir(path.join(vendorFlows, "helpers"), { recursive: true });
    await fs.mkdir(projFlows, { recursive: true });
    await fs.writeFile(
      path.join(vendorFlows, "sibling.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "echo", message: "vendored sibling" }],
      }),
      "utf8"
    );
    await fs.writeFile(
      path.join(vendorFlows, "helpers", "b.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "run", flow: "../sibling.yaml" }],
      }),
      "utf8"
    );
    await fs.writeFile(
      path.join(vendorFlows, "main.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "run", flow: "helpers/b.yaml" }],
      }),
      "utf8"
    );
    await fs.symlink(path.join(vendorFlows, "main.yaml"), path.join(projFlows, "main.yaml"));

    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "main", project_root: proj, device: DEVICE }
      )
    );

    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "run:pass",
      "run:pass",
      "echo:pass",
    ]);
    expect(result.steps[1]).toMatchObject({ flow: "sibling", target: "../sibling.yaml" });
    expect(result.steps[2]).toMatchObject({ message: "vendored sibling" });
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

  it("bounds the reason when a run: target is in-project YAML but not a flow", async () => {
    // A mistyped run: path can select any YAML file inside the project root —
    // here a CI config whose sole top-level key happens to be `steps`. Its
    // first entry lands in the parse diagnostic, and the reason ships verbatim
    // to `argent flow run` stdout and into the MCP content block, so badEntry's
    // cap must keep the file's values from surviving to those surfaces in full.
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [{ kind: "run", flow: "../../ci/deploy.yaml" }],
    });
    await fs.mkdir(path.join(tmpDir, "ci"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "ci", "deploy.yaml"),
      `steps:\n  - db_password: "hunter2-${"x".repeat(4000)}-PROD-TAIL"\n`,
      "utf8"
    );

    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({ kind: "run", status: "error" });
    const reason = result.steps[0]?.reason ?? "";
    expect(reason).toMatch(/^could not load fragment "\.\.\/\.\.\/ci\/deploy\.yaml": /);
    expect(reason).toContain("…(+");
    expect(reason).not.toContain("PROD-TAIL");
    expect(reason.length).toBeLessThan(500);
  });

  it("refuses a mis-cased run: target instead of running the case-folded file", async () => {
    // These tests run on macOS, whose case-insensitive APFS is precisely what
    // makes this reachable: `run: Frag.yaml` opens the file really named
    // frag.yaml, the fragment's steps run, and every one of them is attributed
    // to "Frag" — a name no directory entry carries. The same tree on a
    // case-sensitive checkout (Linux CI) dies with ENOENT, so the slip must be
    // refused where it is authored, not where it is replayed. Nothing of the
    // fragment may execute: the refusal precedes the read.
    await writeFlow("frag", {
      executionPrerequisite: "",
      steps: [{ kind: "echo", message: "RAN-THE-LOWERCASE-FILE" }],
    });
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "run", flow: "Frag.yaml" },
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
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["run:error", "echo:skip"]);
    expect(result.steps[0]).toMatchObject({ kind: "run", flow: "Frag", target: "Frag.yaml" });
    const reason = result.steps[0]?.reason ?? "";
    expect(reason).toMatch(/^mis-cased fragment reference "Frag\.yaml": /);
    expect(reason).toContain(`no directory entry is named "Frag.yaml"`);
    expect(reason).toContain(`case-insensitively to "frag.yaml"`);
    // The recovery quotes a target the run: gate would itself accept.
    expect(reason).toContain(`reference it as "frag.yaml"`);
    // Not the load error: the file was never read, so nothing of it ran.
    expect(reason).not.toContain("could not load fragment");
    expect(result.steps.map((s) => s.message)).not.toContain("RAN-THE-LOWERCASE-FILE");
  });

  it("runs a run: target whose mixed-case spelling is the one really on disk", async () => {
    // The gate compares byte-for-byte against the listing, not against a
    // lowercase convention: an on-disk Frag.yaml is a perfectly portable
    // fragment and `run: Frag.yaml` must compose it, with the mixed-case stem
    // keying its steps. A gate that merely lowercased the target would fail
    // this and break every camelCase flow tree.
    await writeFlow("Frag", {
      executionPrerequisite: "",
      steps: [{ kind: "echo", message: "from the mixed-case file" }],
    });
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [{ kind: "run", flow: "Frag.yaml" }],
    });

    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["run:pass", "echo:pass"]);
    expect(result.steps[0]).toMatchObject({ flow: "Frag", target: "Frag.yaml" });
    expect(result.steps[1]).toMatchObject({ flow: "Frag", message: "from the mixed-case file" });
  });

  it("runs a symlinked run: spelling whose real file is named differently", async () => {
    // The listing consulted must be the directory the target is SPELLED in,
    // compared against the SPELLED basename. Comparing against
    // path.basename(canonical) instead — realpath rewrites a symlink to its
    // target — would see "a.yaml" for `run: alias.yaml` and refuse a link that
    // every directory entry backs and that the cycle guard already treats as a
    // first-class spelling.
    const flowsDir = path.join(tmpDir, ".argent", "flows");
    await writeFlow("a", {
      executionPrerequisite: "",
      steps: [{ kind: "echo", message: "reached through the link" }],
    });
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [{ kind: "run", flow: "alias.yaml" }],
    });
    await fs.symlink(path.join(flowsDir, "a.yaml"), path.join(flowsDir, "alias.yaml"));

    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["run:pass", "echo:pass"]);
    expect(result.steps[0]).toMatchObject({ flow: "alias", target: "alias.yaml" });
    expect(result.steps[1]).toMatchObject({ message: "reached through the link" });
  });

  it("reports a target absent from the listing as ENOENT, not as a casing slip", async () => {
    // Only a case-FOLDED verdict may refuse. A mixed-case target with no
    // case-insensitive neighbour at all is an ordinary missing fragment, and
    // the per-file ENOENT from the read names the spelling and the reason far
    // better than a casing complaint could — a gate that fired on `absent` too
    // would answer every typo with advice about capitalization.
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [{ kind: "run", flow: "Gone.yaml" }],
    });

    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.ok).toBe(false);
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["run:error"]);
    const reason = result.steps[0]?.reason ?? "";
    expect(reason).toMatch(/^could not load fragment "Gone\.yaml": /);
    expect(reason).toContain("ENOENT");
    expect(reason).not.toContain("case-insensitively");
  });

  it("refuses a mis-cased run: target in a subdirectory", async () => {
    // A multi-segment target is checked in whatever directory it lands in, not
    // only in the containing flow's own — the phantom spelling is exactly as
    // unportable one level down, and a check anchored on the anchor directory
    // alone would list the wrong directory and wave it through.
    const subDir = path.join(tmpDir, ".argent", "flows", "sub");
    await fs.mkdir(subDir, { recursive: true });
    await fs.writeFile(
      path.join(subDir, "frag.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "echo", message: "RAN-THE-SUBDIR-FILE" }],
      }),
      "utf8"
    );
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [{ kind: "run", flow: "sub/Frag.yaml" }],
    });

    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.ok).toBe(false);
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["run:error"]);
    const reason = result.steps[0]?.reason ?? "";
    expect(reason).toMatch(/^mis-cased fragment reference "sub\/Frag\.yaml": /);
    expect(reason).toContain(`case-insensitively to "frag.yaml"`);
    // The hint keeps the target's own directory prefix, so it is the line the
    // author can paste back into the flow.
    expect(reason).toContain(`reference it as "sub/frag.yaml"`);
    expect(result.steps.map((s) => s.message)).not.toContain("RAN-THE-SUBDIR-FILE");
  });

  it("asks for a rename when the on-disk spelling no run: target could reach", async () => {
    // The on-disk name here is frag.YAML, which the run: extension gate
    // (parseRunTarget) refuses outright — quoting it back as a replacement
    // target would send the author to an error one layer down. The only way
    // out is the rename, so that is what the recovery asks for.
    await fs.mkdir(path.join(tmpDir, ".argent", "flows"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, ".argent", "flows", "frag.YAML"),
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "echo", message: "RAN-THE-SHOUTY-FILE" }],
      }),
      "utf8"
    );
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

    expect(result.ok).toBe(false);
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["run:error"]);
    const reason = result.steps[0]?.reason ?? "";
    expect(reason).toMatch(/^mis-cased fragment reference "frag\.yaml": /);
    expect(reason).toContain(`rename "frag.YAML" to "frag.yaml"`);
    expect(reason).not.toContain("reference it as");
    expect(result.steps.map((s) => s.message)).not.toContain("RAN-THE-SHOUTY-FILE");
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

  it("rejects an uploaded flow whose run: sits two when: blocks deep", async () => {
    // Pins walkSteps' recursion DEPTH, which the single-level test above
    // cannot: a one-level peek (`yield* step.steps` in place of
    // `yield* walkSteps(step.steps)`) still passes that neighbor but never
    // reaches this run:, so the flow reports ok: true with the run line inside
    // a block skip — the silent-green CI outcome the preflight exists to
    // prevent. The parser nests when: to MAX_WHEN_DEPTH (20), so two levels is
    // ordinary authorable YAML, not an edge case.
    const uploadedPath = path.join(tmpDir, "materialized-upload.yaml");
    await fs.writeFile(
      uploadedPath,
      "steps:\n" +
        "  - when:\n" +
        "      platform: android\n" +
        "    steps:\n" +
        "      - when:\n" +
        "          platform: android\n" +
        "        steps:\n" +
        "          - run: login.yaml\n",
      "utf8"
    );

    const registry = mockRegistry();
    const err = await createRunFlowTool(registry)
      .execute(
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
      .then(
        () => null,
        (e: unknown) => e
      );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('run: composition ("run: login.yaml")');
    expect(getFailureSignal(err)?.failure_stage).toBe("flow_upload_run_composition");
    // Preflight, not mid-run: nothing was dispatched to the device.
    expect(registry.invokeTool).not.toHaveBeenCalled();
  });

  it("rejects an uploaded chromium e2e flow's run: before booting the launch's Electron app", async () => {
    // The guard's docstring promises the rejection fires "before anything
    // executes" — a POSITIONAL contract its mere existence doesn't keep. For
    // an uploaded chromium e2e flow that also carries a run:, the guard
    // sitting above resolveRunDevice is what decides whether an Electron
    // instance is booted (and orphaned by the throw, which lands before the
    // teardown finally) just to deliver a contract error. The absolute app
    // path is deliberate — legal for an upload — so nothing else stands
    // between the boot and the error: move the guard call below
    // `const device = resolved.device;` and the boot fires first.
    bootElectronApp.mockClear();
    const uploadedPath = path.join(tmpDir, "materialized-upload.yaml");
    await fs.writeFile(
      uploadedPath,
      "steps:\n  - launch: { chromium: /abs/e2e-app }\n  - run: login.yaml\n",
      "utf8"
    );

    const registry = mockRegistry();
    await expect(
      createRunFlowTool(registry).execute(
        {},
        { name: "main", project_root: tmpDir, flow_file: uploadedPath },
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
    ).rejects.toThrow(/run: composition/);
    // Preflight, not post-boot: no Electron instance was spawned and no
    // device was resolved before the rejection.
    expect(bootElectronApp).not.toHaveBeenCalled();
    expect(registry.invokeTool).not.toHaveBeenCalled();
  });

  it("rejects an uploaded fragment's run: instead of answering the prerequisite handshake", async () => {
    // The other half of the guard's "before anything executes" position: it
    // sits above the executionPrerequisite early return. A prerequisite is
    // fragments-only (no leading launch) and fragments can carry run:, so an
    // uploaded fragment can declare both. With the blocks
    // swapped, the un-acknowledged call gets the prerequisite notice back —
    // sending the agent off to do manual device setup for a flow the very
    // next call rejects. The contract error must win.
    const uploadedPath = path.join(tmpDir, "materialized-upload.yaml");
    await fs.writeFile(
      uploadedPath,
      serializeFlow({
        executionPrerequisite: "Signed into the demo account",
        steps: [{ kind: "run", flow: "login.yaml" }],
      }),
      "utf8"
    );

    const outcome = await createRunFlowTool(mockRegistry())
      .execute(
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
      .then(
        (r) => r,
        (e: unknown) => e
      );
    // A rejection — not a { notice, executionPrerequisite } return: on a
    // failure this prints the notice that leaked through instead.
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain('run: composition ("run: login.yaml")');
    expect(getFailureSignal(outcome)?.failure_stage).toBe("flow_upload_run_composition");
  });

  it("rejects an uploaded flow quoting the first run:'s as-written directory-qualified path", async () => {
    // The guard's quote is the author's remediation pointer: with two
    // same-stem steps (`run: ios/login.yaml`, then `run: android/login.yaml`)
    // the throw fires on the FIRST offender, and only the as-written
    // directory says which of the two lines it means. Reducing the target to
    // its basename stem (runTargetName — what the report attribution sites
    // use, and what `step.flow` carried before targets kept their spelling)
    // would print `run: login`, a string appearing nowhere in the flow and
    // ambiguous between the two steps. The bare-spelling rejections above
    // pin only the `.yaml` suffix (there the as-written path and the stem
    // differ by nothing else), so this test is what holds the directory
    // component — the contract content.ts pins for the MCP renderer
    // ("`run ios/login.yaml` and `run android/login.yaml` must render
    // distinctly, not as one stem"); this error path is that same reasoning
    // on the tool-server surface.
    const uploadedPath = path.join(tmpDir, "materialized-upload.yaml");
    await fs.writeFile(
      uploadedPath,
      "steps:\n  - run: ios/login.yaml\n  - run: android/login.yaml\n",
      "utf8"
    );

    const registry = mockRegistry();
    const err = await createRunFlowTool(registry)
      .execute(
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
      .then(
        () => null,
        (e: unknown) => e
      );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('run: composition ("run: ios/login.yaml")');
    expect(getFailureSignal(err)?.failure_stage).toBe("flow_upload_run_composition");
    // Preflight, not mid-run: nothing was dispatched to the device.
    expect(registry.invokeTool).not.toHaveBeenCalled();
  });

  it("allows run: composition for a co-located flow_file resolved in place", async () => {
    // The everyday co-located client: the flow_file boundary resolves the
    // exact ${project_root}/.argent/flows/${name}.yaml path on a shared
    // filesystem (presentOnHost, NOT an upload). This return is what carries
    // the whole feature — misclassifying it as an upload would reject every
    // local run: composition with the co-located contract error, so the
    // upload-rejection tests above need this inverse pin.
    await writeFlow("login", {
      executionPrerequisite: "",
      steps: [{ kind: "echo", message: "composed fragment ran" }],
    });
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [{ kind: "run", flow: "login.yaml" }],
    });
    const flowFile = path.join(tmpDir, ".argent", "flows", "main.yaml");

    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "main", project_root: tmpDir, flow_file: flowFile, device: DEVICE },
        {
          artifacts: new ArtifactStore(),
          fileInputs: {
            flow_file: {
              clientPath: flowFile,
              presentOnHost: true,
              viaUpload: false,
            },
          },
        }
      )
    );

    expect(result.ok).toBe(true);
    expect(result.steps[1]).toMatchObject({
      kind: "echo",
      status: "pass",
      message: "composed fragment ran",
    });
  });

  it("rejects a snapshot step when the root flow was uploaded (no durable baseline dir)", async () => {
    // Baselines anchor beside the flow's file, and an uploaded flow
    // materializes to a fresh temp directory each call — a plain snapshot can
    // only fail on a missing baseline, and updateBaselines would write PNGs no
    // later run can find. Rejected preflight, like uploaded run: composition.
    vi.mocked(runSnapshot).mockClear();
    const uploadedPath = path.join(tmpDir, "materialized-upload.yaml");
    await fs.writeFile(
      uploadedPath,
      serializeFlow({
        executionPrerequisite: "",
        steps: [
          { kind: "echo", message: "before" },
          { kind: "snapshot", name: "home", maxMismatch: 0.5 },
        ],
      }),
      "utf8"
    );

    const registry = mockRegistry();
    const err = await createRunFlowTool(registry)
      .execute(
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
      .then(
        () => null,
        (e: unknown) => e
      );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('snapshot step ("snapshot: home")');
    expect(getFailureSignal(err)?.failure_stage).toBe("flow_upload_snapshot_baseline");
    // Preflight, not mid-run: nothing was dispatched to the device and the
    // differ was never pointed at the temp materialization dir.
    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(vi.mocked(runSnapshot)).not.toHaveBeenCalled();
  });

  it("rejects an uploaded flow whose snapshot hides behind a when: block that would not fire", async () => {
    // Same preflight walk as run: — a guard-gated snapshot must not report
    // green on one platform and only surface the contract error where the
    // guard first fires (e.g. in CI).
    const uploadedPath = path.join(tmpDir, "materialized-upload.yaml");
    await fs.writeFile(
      uploadedPath,
      "steps:\n  - when:\n      platform: android\n    steps:\n      - snapshot:\n          name: home\n",
      "utf8"
    );

    const err = await createRunFlowTool(mockRegistry())
      .execute(
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
      .then(
        () => null,
        (e: unknown) => e
      );
    expect(getFailureSignal(err)?.failure_stage).toBe("flow_upload_snapshot_baseline");
  });

  it("allows a snapshot step for a co-located flow_file resolved in place", async () => {
    // The inverse pin for the snapshot upload rejection above: the everyday
    // co-located client (presentOnHost, NOT an upload) keeps its durable
    // baseline directory beside the flow file, so the snapshot path still runs.
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [{ kind: "snapshot", name: "home", maxMismatch: 0.5 }],
    });
    const flowFile = path.join(tmpDir, ".argent", "flows", "main.yaml");

    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "main", project_root: tmpDir, flow_file: flowFile, device: DEVICE },
        {
          artifacts: new ArtifactStore(),
          fileInputs: {
            flow_file: {
              clientPath: flowFile,
              presentOnHost: true,
              viaUpload: false,
            },
          },
        }
      )
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0]).toMatchObject({ kind: "snapshot", status: "pass" });
    expect(vi.mocked(runSnapshot)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        flowsDir: path.join(tmpDir, ".argent", "flows"),
        flowName: "main",
      })
    );
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
    // The real directory, not the spelling the run was addressed by. (The
    // link and its target share a basename here, so this fixture cannot tell
    // the two candidate KEYS apart — the vault tests below do that.)
    expect(vi.mocked(runSnapshot)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ flowsDir: sharedFlows, flowName: "visual" })
    );
  });

  /**
   * The baseline store is `<flowsDir>/__baselines__/<flowName>`, and flowsDir
   * is the CANONICAL root flow's directory — so the key has to name the
   * canonical file too, or the pair identifies no single file. These pin that
   * agreement from both sides: two flows that share an anchor must not share a
   * store, and a flow that is its own real file must not move.
   */
  it("gives two projects' same-named symlinks into one vault separate baseline stores", async () => {
    // The shared-vault layout: each project has its own legitimately named
    // .argent/flows/smoke.yaml, both symlinked into one vault at differently
    // named real files. The canonical anchor is vault/ for both, so keying by
    // the as-written stem would give them ONE vault/__baselines__/smoke/:
    // whichever project ran --update-baselines last would silently replace the
    // other's reviewed, committed PNG — reported as "baseline updated", as
    // though it had refreshed its own — and the other project's next run would
    // then fail against a screen it never captured. Nothing is printed either
    // way, so only the store paths can catch this.
    const vault = path.join(tmpDir, "vault");
    await fs.mkdir(vault, { recursive: true });
    const snapshotFlow = serializeFlow({
      executionPrerequisite: "",
      steps: [{ kind: "snapshot", name: "home", maxMismatch: 0.5 }],
    });
    await fs.writeFile(path.join(vault, "a-smoke.yaml"), snapshotFlow, "utf8");
    await fs.writeFile(path.join(vault, "b-smoke.yaml"), snapshotFlow, "utf8");
    const vaultedProject = async (proj: string, target: string): Promise<string> => {
      const flows = path.join(tmpDir, proj, ".argent", "flows");
      await fs.mkdir(flows, { recursive: true });
      await fs.symlink(path.join(vault, target), path.join(flows, "smoke.yaml"));
      return path.join(tmpDir, proj);
    };
    const projA = await vaultedProject("projA", "a-smoke.yaml");
    const projB = await vaultedProject("projB", "b-smoke.yaml");

    vi.mocked(runSnapshot).mockClear();
    const runFlow = createRunFlowTool(mockRegistry());
    const a = asRun(
      await runFlow.execute({}, { name: "smoke", project_root: projA, device: DEVICE })
    );
    const b = asRun(
      await runFlow.execute({}, { name: "smoke", project_root: projB, device: DEVICE })
    );

    expect([a.ok, b.ok]).toEqual([true, true]);
    // The caller-visible identity is untouched — both runs still report as the
    // flow the user asked to run. Only the baseline key follows the real file.
    expect([a.flow, b.flow]).toEqual(["smoke", "smoke"]);

    const stores = vi
      .mocked(runSnapshot)
      .mock.calls.map(([, opts]) => path.join(opts.flowsDir, "__baselines__", opts.flowName));
    expect(stores).toEqual([
      path.join(vault, "__baselines__", "a-smoke"),
      path.join(vault, "__baselines__", "b-smoke"),
    ]);
  });

  it("leaves a regular (non-symlinked) root flow's baseline store exactly where it was", async () => {
    // The no-regression pin for every existing user: when the root flow is a
    // real file its canonical stem IS the as-written one, so deriving the key
    // from the canonical path must not move the store anyone has already
    // seeded and committed under .argent/flows/__baselines__/<flow>/.
    await writeFlow("checkout", {
      executionPrerequisite: "",
      steps: [{ kind: "snapshot", name: "home", maxMismatch: 0.5 }],
    });

    vi.mocked(runSnapshot).mockClear();
    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "checkout", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.ok).toBe(true);
    const [, opts] = vi.mocked(runSnapshot).mock.calls[0]!;
    expect(path.join(opts.flowsDir, "__baselines__", opts.flowName)).toBe(
      path.join(tmpDir, ".argent", "flows", "__baselines__", "checkout")
    );
  });

  it("keys a fragment's snapshot to a symlinked root's REAL file, not the fragment or the link", async () => {
    // The root-anchoring pin above, extended to the symlinked-root case the
    // key change touches: the snapshot is authored in vault/frag.yaml, so
    // three names are in play — the fragment's stem ("frag"), the spelling the
    // run was addressed by ("smoke"), and the root's real file ("a-smoke").
    // Only the last agrees with the anchor the store sits in.
    const vault = path.join(tmpDir, "vault");
    await fs.mkdir(vault, { recursive: true });
    await fs.writeFile(
      path.join(vault, "a-smoke.yaml"),
      serializeFlow({ executionPrerequisite: "", steps: [{ kind: "run", flow: "frag.yaml" }] }),
      "utf8"
    );
    await fs.writeFile(
      path.join(vault, "frag.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "snapshot", name: "home", maxMismatch: 0.5 }],
      }),
      "utf8"
    );
    const flowsDir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(flowsDir, { recursive: true });
    await fs.symlink(path.join(vault, "a-smoke.yaml"), path.join(flowsDir, "smoke.yaml"));

    vi.mocked(runSnapshot).mockClear();
    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "smoke", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["run:pass", "snapshot:pass"]);
    expect(vi.mocked(runSnapshot)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ flowsDir: vault, flowName: "a-smoke" })
    );
    // Report attribution is unchanged by the key: the root still reports under
    // the name it was run as, the expanded step under the fragment's.
    expect(result.flow).toBe("smoke");
    expect(result.steps[1]?.flow).toBe("frag");
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

  it("passes the run's Metro port down to a nested flow-execute", async () => {
    // A `run:` fragment inherits `metroPort` by construction — it shares one
    // ExecState — so the raw `tool: flow-execute` form must not disagree about
    // which bundler a dev-client launch opens. Without this the inner run always
    // used the default, and the two composition forms recovered onto different
    // Metros.
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [{ kind: "tool", name: "flow-execute", args: { name: "b-only" } }],
    });

    const registry = mockRegistry({ name: {}, project_root: {}, device: {} });
    await createRunFlowTool(registry).execute(
      {},
      { name: "main", project_root: tmpDir, device: DEVICE, metroPort: 8085 }
    );

    expect(registry.invokeTool).toHaveBeenCalledWith(
      "flow-execute",
      expect.objectContaining({ metroPort: 8085 })
    );
  });

  it("leaves a nested flow-execute alone when the run took the default port", async () => {
    // The inner run resolves the same default itself, so injecting it would only
    // add noise to every nested step's reported args.
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [{ kind: "tool", name: "flow-execute", args: { name: "b-only" } }],
    });

    const registry = mockRegistry({ name: {}, project_root: {}, device: {} });
    await createRunFlowTool(registry).execute(
      {},
      { name: "main", project_root: tmpDir, device: DEVICE }
    );

    expect(registry.invokeTool).toHaveBeenCalledWith(
      "flow-execute",
      expect.not.objectContaining({ metroPort: expect.anything() })
    );
  });

  it("keeps a port the nested step names for itself", async () => {
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [{ kind: "tool", name: "flow-execute", args: { name: "b-only", metroPort: 8090 } }],
    });

    const registry = mockRegistry({ name: {}, project_root: {}, device: {} });
    await createRunFlowTool(registry).execute(
      {},
      { name: "main", project_root: tmpDir, device: DEVICE, metroPort: 8085 }
    );

    expect(registry.invokeTool).toHaveBeenCalledWith(
      "flow-execute",
      expect.objectContaining({ metroPort: 8090 })
    );
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

  it("stripDeviceKeys removes udid / device_id / device, leaving other args untouched", () => {
    expect(stripDeviceKeys({ udid: "A", device_id: "B", device: "C", x: 1 })).toEqual({ x: 1 });
  });

  it("stripDeviceKeys KEEPS a `devices` scope, because dropping it changes the step's meaning", () => {
    // A target is stripped so the flow points at no device. A scope is not:
    // `stop-all-simulator-servers` with no `devices` is the machine-wide sweep,
    // so stripping it would record a correctly scoped teardown as a bare step
    // that reaps every device on the machine when hand-run from the YAML — the
    // manual-execution strategy the create-flow skill documents. Replay rebinds
    // it either way (see bindDeviceArgs below).
    expect(stripDeviceKeys({ udid: "A", devices: ["D", "E"], x: 1 })).toEqual({
      devices: ["D", "E"],
      x: 1,
    });
  });

  it("bindDeviceArgs keeps a recorded scope when the run resolved NO device", () => {
    // A cleanup flow resolves no device when none is unambiguous. Dropping the
    // recorded scope there would widen the teardown from the devices the
    // recording named to every device on the machine — the one direction that
    // costs another agent their session. There is no run target to override.
    expect(
      bindDeviceArgs(reg({ devices: {} }), "stop-all-simulator-servers", "", {
        devices: ["RECORDED"],
      })
    ).toEqual({ devices: ["RECORDED"] });
  });

  it("bindDeviceArgs never forwards a scope to a tool that does not declare it", () => {
    // The schema-blind strip's job: a `.strict()` schema would reject the call.
    expect(
      bindDeviceArgs(reg({ port: {} }), "stop-metro", "RESOLVED", {
        devices: ["RECORDED"],
        port: 8081,
      })
    ).toEqual({ port: 8081 });
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

  it("injects devices: [resolvedId] for a tool that declares it in its schema", () => {
    // stop-all-simulator-servers' `devices` is a scope, not a single-device
    // target, but it names the recording host's device ids the same way `udid`
    // does — so it gets the same schema-aware rebind, as a one-element list.
    const out = bindDeviceArgs(reg({ devices: {} }), "stop-all-simulator-servers", "RESOLVED", {});
    expect(out).toEqual({ devices: ["RESOLVED"] });
  });

  it("does not invent a devices key for a tool that doesn't declare it", () => {
    const out = bindDeviceArgs(reg({ foo: {} }), "x", "RESOLVED", { foo: 1 });
    expect(out).toEqual({ foo: 1 });
    expect(out).not.toHaveProperty("devices");
  });

  it("replaces a stale recorded devices list when the caller NAMED the run device", () => {
    // An explicit `device` is the caller saying which device this run is about,
    // so retargeting the teardown at it is what they asked for — and a flow
    // recorded on one host must not carry that host's ids forward.
    const out = bindDeviceArgs(
      reg({ devices: {} }),
      "stop-all-simulator-servers",
      "RESOLVED",
      { devices: ["OLD-HOST-ID", "OTHER"] },
      true
    );
    expect(out).toEqual({ devices: ["RESOLVED"] });
  });

  it("keeps a recorded scope when the run device was only auto-detected", () => {
    // The destructive direction: the flow named one device, exactly one other
    // happens to be booted, and replay would reap THAT one — a device nobody in
    // this run ever named, quite possibly another agent's. This is the
    // cross-agent teardown the `devices` scope exists to prevent, so the
    // recorded ids stand; on another host they reap nothing and come back in
    // `unmatched`, which is the safe direction and a legible one.
    const out = bindDeviceArgs(reg({ devices: {} }), "stop-all-simulator-servers", "AUTO", {
      devices: ["RECORDED-HOST"],
    });
    expect(out).toEqual({ devices: ["RECORDED-HOST"] });
  });

  it("still narrows an UNSCOPED recorded sweep onto an auto-detected device", () => {
    // Nothing recorded means the step is the machine-wide sweep, so binding can
    // only narrow it. That is why a cleanup flow resolves a device at all.
    const out = bindDeviceArgs(reg({ devices: {} }), "stop-all-simulator-servers", "AUTO", {});
    expect(out).toEqual({ devices: ["AUTO"] });
  });

  it("binds a scalar and a list device key together when a tool declares both", () => {
    const out = bindDeviceArgs(
      reg({ udid: {}, devices: {} }),
      "hypothetical-tool",
      "RESOLVED",
      { udid: "STALE", devices: ["OLD"] },
      true
    );
    expect(out).toEqual({ udid: "RESOLVED", devices: ["RESOLVED"] });
  });

  it("rebinds the TARGET but not the recorded SCOPE on an auto-detected device", () => {
    // The two keys part company here: a stale `udid` must never survive (the
    // step would drive the wrong device), while a stale `devices` must never be
    // retargeted (the step would destroy the wrong device).
    const out = bindDeviceArgs(reg({ udid: {}, devices: {} }), "hypothetical-tool", "AUTO", {
      udid: "STALE",
      devices: ["OLD"],
    });
    expect(out).toEqual({ udid: "AUTO", devices: ["OLD"] });
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

  it("completes a bare run: name to <name>.yaml", () => {
    // The compatibility spelling for flows written when a run: target was a
    // saved-flow name. Completed at PARSE, so one spelling reaches the runner.
    expect(parseFlow("steps:\n  - run: login\n").steps[0]).toEqual({
      kind: "run",
      flow: "login.yaml",
    });
  });

  it("completes an extensionless run: path, keeping its directory prefix", () => {
    for (const [written, completed] of [
      ["shared/login", "shared/login.yaml"],
      ["../shared/login", "../shared/login.yaml"],
      ["./login", "./login.yaml"],
    ]) {
      expect(parseFlow(`steps:\n  - run: ${written}\n`).steps[0], written).toEqual({
        kind: "run",
        flow: completed,
      });
    }
  });

  it("does not complete a run: target the extension cannot rescue", () => {
    // basename() strips a trailing slash, so a completion driven by the
    // SUPPLIED basename would turn "shared/" into the unopenable "shared/.yaml"
    // instead of reporting a target that names no file.
    expect(() => parseFlow("steps:\n  - run: shared/\n")).toThrow(/must end in \.yaml/);
    expect(() => parseFlow("steps:\n  - run: shared/\n")).not.toThrow(/\.yaml\.yaml/);
    // A wrong extension is a typo to report, not a stem to extend: completing
    // it would run "login.yml.yaml" and bury the mistake.
    expect(() => parseFlow("steps:\n  - run: login.yml\n")).toThrow(/must end in \.yaml/);
    // Dots are outside the flow-name charset, so a version-ish stem stays an
    // error rather than becoming "v1.2.yaml".
    expect(() => parseFlow("steps:\n  - run: v1.2\n")).toThrow(/must end in \.yaml/);
  });

  it("reports a missing target instead of a null.yaml completion for a valueless run:", () => {
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
