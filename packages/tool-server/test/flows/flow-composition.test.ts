import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow, parseFlow } from "../../src/tools/flows/flow-utils";
import { bindDeviceArgs, stripDeviceKeys } from "../../src/tools/flows/flow-device";

const DEVICE = "00000000-0000-0000-0000-0000000000ab";
let tmpDir: string;

function mockRegistry(): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "list-devices") return { devices: [] };
      return { ok: true };
    }),
    getTool: vi.fn(() => undefined),
    // iOS flows gate on a native-devtools connection: report connected so the
    // run proceeds, but expose no target app so the tree fetch falls back to
    // the AX tree (these tests don't drive the native hierarchy).
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

  it("rejects running an e2e flow as a fragment", async () => {
    await writeFlow("other-e2e", {
      executionPrerequisite: "",
      steps: [{ kind: "launch", app: "com.acme.app" }],
    });
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [{ kind: "run", flow: "other-e2e" }],
    });
    const runFlow = createRunFlowTool(mockRegistry());
    const result = asRun(
      await runFlow.execute({}, { name: "main", project_root: tmpDir, device: DEVICE })
    );
    expect(result.steps[0]).toMatchObject({ kind: "run", status: "error" });
    expect(result.steps[0].reason).toMatch(/e2e flow/i);
    expect(result.ok).toBe(false);
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

  it("stripDeviceKeys removes udid / device_id", () => {
    expect(stripDeviceKeys({ udid: "A", device_id: "B", x: 1 })).toEqual({ x: 1 });
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
    expect(() => parseFlow("steps:\n  - launch: { web: foo }\n")).toThrow(
      /launch needs an app id/i
    );
    expect(() => parseFlow("steps:\n  - launch: 42\n")).toThrow(/launch needs an app id/i);
  });
});
