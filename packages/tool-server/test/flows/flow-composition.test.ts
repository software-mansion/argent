import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactStore, type Registry } from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow, parseFlow } from "../../src/tools/flows/flow-utils";
import { bindDeviceArgs, stripDeviceKeys } from "../../src/tools/flows/flow-device";

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

function asRun(r: FlowRunResult | { notice: string }): FlowRunResult {
  if (!("steps" in r)) throw new Error(`expected a run result, got notice: ${r.notice}`);
  return r;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-compose-"));
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
        { kind: "run", flow: "login" },
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
        steps: [{ kind: "run", flow: "login" }],
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

  it("stamps nesting depth on expanded fragment steps (omitted at top level)", async () => {
    await writeFlow("inner", {
      executionPrerequisite: "",
      steps: [{ kind: "echo", message: "deepest" }],
    });
    await writeFlow("login", {
      executionPrerequisite: "",
      steps: [
        { kind: "tool", name: "tap", args: { x: 0.5 } },
        { kind: "run", flow: "inner" },
      ],
    });
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "run", flow: "login" },
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
      steps: [{ kind: "run", flow: "other-e2e" }],
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
    await writeFlow("a", { executionPrerequisite: "", steps: [{ kind: "run", flow: "b" }] });
    await writeFlow("b", { executionPrerequisite: "", steps: [{ kind: "run", flow: "a" }] });
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [{ kind: "run", flow: "a" }],
    });
    const runFlow = createRunFlowTool(mockRegistry());
    const result = asRun(
      await runFlow.execute({}, { name: "main", project_root: tmpDir, device: DEVICE })
    );
    const errored = result.steps.find((s) => s.status === "error");
    expect(errored?.reason).toMatch(/cyclic/i);
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
        { kind: "run" as const, flow: "login" },
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
