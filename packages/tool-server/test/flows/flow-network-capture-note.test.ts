import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";

// A run on Android pins the status bar over adb; nothing here may shell out.
vi.mock("../../src/utils/status-bar", () => ({
  pinStatusBar: vi.fn(async () => false),
  restoreStatusBar: vi.fn(async () => {}),
}));

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";

// Each launch waits out the runner's real post-launch settle (1.5 s).
vi.setConfig({ testTimeout: 30_000 });

const SERIAL = "emulator-5554";
const APP = "com.example.networktest";
const NOTE = "native network capture is attached to com.example.networktest";
let tmpDir: string;

/**
 * restart-app and launch-app answer like the Android tools do while native
 * network capture is live for `captured`; the Android helper (the flow tree
 * source the launch gate probes) is ready.
 */
function androidRegistry(captured: string | undefined): Registry {
  const launched = (bundleId: unknown) =>
    bundleId === captured ? { networkCapture: NOTE } : ({} as Record<string, never>);
  return {
    invokeTool: vi.fn(async (id: string, args: Record<string, unknown>) => {
      if (id === "list-devices") return { devices: [] };
      if (id === "restart-app") {
        return { restarted: true, bundleId: args.bundleId, ...launched(args.bundleId) };
      }
      if (id === "launch-app") {
        return { launched: true, bundleId: args.bundleId, ...launched(args.bundleId) };
      }
      return { ok: true };
    }),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    resolveService: vi.fn(async () => ({ isReady: () => true })),
  } as unknown as Registry;
}

async function writeFlow(name: string, yaml: Parameters<typeof serializeFlow>[0]): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.yaml`), serializeFlow(yaml), "utf8");
}

async function run(name: string, registry: Registry, device = SERIAL): Promise<FlowRunResult> {
  const result = await createRunFlowTool(registry).execute(
    {},
    { name, project_root: tmpDir, device },
    { signal: new AbortController().signal } as never
  );
  if (!("steps" in result)) throw new Error(`expected a run result, got: ${result.notice}`);
  return result;
}

/** `kind:status` per step, with `!` when the step carries a warning. */
function outline(result: FlowRunResult): string[] {
  return result.steps.map((s) => `${s.kind}:${s.status}${s.warning ? "!" : ""}`);
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-net-capture-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("flow-execute reports native network capture on Android launches", () => {
  it("warns on the first launch of a captured app, once per run", async () => {
    await writeFlow("relaunch", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: APP },
        { kind: "launch", app: APP },
        { kind: "tool", name: "restart-app", args: { bundleId: APP } },
      ],
    });

    const result = await run("relaunch", androidRegistry(APP));

    expect(outline(result)).toEqual(["launch:pass!", "launch:pass", "tool:pass"]);
    expect(result.steps[0]!.warning).toBe(NOTE);
    expect(result.ok).toBe(true);
  });

  it("warns on a tool: launch-app step when it is the first launch of a captured app", async () => {
    await writeFlow("tool-launch", {
      executionPrerequisite: "",
      steps: [
        { kind: "tool", name: "launch-app", args: { bundleId: APP } },
        { kind: "launch", app: APP },
      ],
    });

    const result = await run("tool-launch", androidRegistry(APP));

    expect(outline(result)).toEqual(["tool:pass!", "launch:pass"]);
    expect(result.steps[0]!.warning).toBe(NOTE);
    // The tool's own result still carries the note for clients that render it.
    expect(result.steps[0]!.result).toMatchObject({ networkCapture: NOTE });
  });

  it("warns again when a later launch's note differs, and not when only the pid changes", async () => {
    const notes = [
      `native network capture is on for ${APP}, but no process of it appeared within 3 s; the next native-network-logs call attaches the agent`,
      `native network capture is attached to ${APP} (pid 4101); native-network-logs with stop: true ends it`,
      `native network capture is attached to ${APP} (pid 4188); native-network-logs with stop: true ends it`,
      `native network capture could not follow this launch: the attach failed`,
    ];
    let launches = 0;
    const registry = {
      invokeTool: vi.fn(async (id: string, args: Record<string, unknown>) => {
        if (id === "list-devices") return { devices: [] };
        if (id === "restart-app") {
          return { restarted: true, bundleId: args.bundleId, networkCapture: notes[launches++] };
        }
        return { ok: true };
      }),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
      resolveService: vi.fn(async () => ({ isReady: () => true })),
    } as unknown as Registry;
    await writeFlow("notes-change", {
      executionPrerequisite: "",
      steps: notes.map(() => ({ kind: "launch" as const, app: APP })),
    });

    const result = await run("notes-change", registry);

    expect(outline(result)).toEqual([
      "launch:pass!",
      "launch:pass!",
      "launch:pass",
      "launch:pass!",
    ]);
    expect(result.steps.map((s) => s.warning)).toEqual([notes[0], notes[1], undefined, notes[3]]);
  });

  it("warns once when the attach fails the same way for a new pid on each launch", async () => {
    let launches = 0;
    const registry = {
      invokeTool: vi.fn(async (id: string, args: Record<string, unknown>) => {
        if (id === "list-devices") return { devices: [] };
        if (id === "restart-app") {
          const pid = 4101 + 87 * launches++;
          return {
            restarted: true,
            bundleId: args.bundleId,
            networkCapture: `native network capture could not follow this launch: attach-agent failed for pid ${pid} (Unknown process: ${pid}); the next native-network-logs call or launch tries again`,
          };
        }
        return { ok: true };
      }),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
      resolveService: vi.fn(async () => ({ isReady: () => true })),
    } as unknown as Registry;
    await writeFlow("attach-fails", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: APP },
        { kind: "launch", app: APP },
        { kind: "launch", app: APP },
      ],
    });

    const result = await run("attach-fails", registry);

    expect(launches).toBe(3);
    expect(outline(result)).toEqual(["launch:pass!", "launch:pass", "launch:pass"]);
    expect(result.steps[0]!.warning).toContain("pid 4101 (Unknown process: 4101)");
  });

  it("shares the last note of each app with a nested run: flow", async () => {
    let launches = 0;
    const registry = {
      invokeTool: vi.fn(async (id: string, args: Record<string, unknown>) => {
        if (id === "list-devices") return { devices: [] };
        if (id === "restart-app") {
          launches++;
          return {
            restarted: true,
            bundleId: args.bundleId,
            networkCapture: `native network capture is attached to ${APP} (pid ${4100 + launches}); native-network-logs with stop: true ends it`,
          };
        }
        return { ok: true };
      }),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
      resolveService: vi.fn(async () => ({ isReady: () => true })),
    } as unknown as Registry;
    await writeFlow("child", { executionPrerequisite: "", steps: [{ kind: "launch", app: APP }] });
    await writeFlow("parent", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: APP },
        { kind: "run", flow: "child" },
      ],
    });

    const result = await run("parent", registry);

    expect(launches).toBe(2);
    expect(result.steps.filter((s) => s.kind === "launch").map((s) => Boolean(s.warning))).toEqual([
      true,
      false,
    ]);
  });

  it("adds no warning when capture follows a different app", async () => {
    await writeFlow("other-app", {
      executionPrerequisite: "",
      steps: [{ kind: "launch", app: APP }],
    });

    const result = await run("other-app", androidRegistry("com.example.other"));

    expect(outline(result)).toEqual(["launch:pass"]);
  });
});

const IOS_UDID = "00000000-0000-0000-0000-0000000000cd";

/**
 * restart-app and launch-app answer like the iOS simulator tools do while
 * native network capture is on for APP, the pid changing with each launch;
 * the native devtools the iOS launch gate waits for are connected. Launch `n`
 * returns `notes[n]` when given, otherwise the note of an armed capture.
 */
function iosRegistry(notes?: string[]): { registry: Registry; launches: () => number } {
  let launches = 0;
  const note = () => {
    const n = launches++;
    return (
      notes?.[n] ??
      `native network capture is armed for ${APP} (pid ${4101 + 87 * n}); stop-all-simulator-servers for this device, then restart-app, ends it`
    );
  };
  const registry = {
    invokeTool: vi.fn(async (id: string, args: Record<string, unknown>) => {
      if (id === "list-devices") return { devices: [] };
      if (id === "restart-app") {
        return { restarted: true, bundleId: args.bundleId, networkCapture: note() };
      }
      if (id === "launch-app") {
        return { launched: true, bundleId: args.bundleId, networkCapture: note() };
      }
      return { ok: true };
    }),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    resolveService: vi.fn(async () => ({
      isConnected: () => true,
      listConnectedBundleIds: () => [APP],
    })),
  } as unknown as Registry;
  return { registry, launches: () => launches };
}

describe("flow-execute reports native network capture on iOS simulator launches", () => {
  it("warns on the first launch of a captured app, once per run", async () => {
    await writeFlow("ios-relaunch", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: APP },
        { kind: "launch", app: APP },
        { kind: "tool", name: "restart-app", args: { bundleId: APP } },
      ],
    });
    const { registry, launches } = iosRegistry();

    const result = await run("ios-relaunch", registry, IOS_UDID);

    expect(launches()).toBe(3);
    expect(outline(result)).toEqual(["launch:pass!", "launch:pass", "tool:pass"]);
    expect(result.steps[0]!.warning).toBe(
      `native network capture is armed for ${APP} (pid 4101); stop-all-simulator-servers for this device, then restart-app, ends it`
    );
    expect(result.ok).toBe(true);
  });

  it("warns on a tool: restart-app step when it is the first launch of a captured app", async () => {
    await writeFlow("ios-tool-restart", {
      executionPrerequisite: "",
      steps: [
        { kind: "tool", name: "restart-app", args: { bundleId: APP } },
        { kind: "launch", app: APP },
      ],
    });
    const { registry } = iosRegistry();

    const result = await run("ios-tool-restart", registry, IOS_UDID);

    expect(outline(result)).toEqual(["tool:pass!", "launch:pass"]);
    expect(result.steps[0]!.warning).toContain(`native network capture is armed for ${APP}`);
    expect(result.steps[0]!.result).toMatchObject({
      networkCapture: result.steps[0]!.warning,
    });
  });

  it("warns again when a later launch's note differs, and not when only the pid changes", async () => {
    const pending = (pid: number) =>
      `native network capture is on for ${APP}, and its new process (pid ${pid}) has not acknowledged Network.enable yet; native-network-logs shows when it is armed`;
    const armed = (pid: number) =>
      `native network capture is armed for ${APP} (pid ${pid}); stop-all-simulator-servers for this device, then restart-app, ends it`;
    const notes = [pending(4101), armed(4188), armed(4275), pending(4362)];
    await writeFlow("ios-notes-change", {
      executionPrerequisite: "",
      steps: notes.map(() => ({ kind: "launch" as const, app: APP })),
    });
    const { registry, launches } = iosRegistry(notes);

    const result = await run("ios-notes-change", registry, IOS_UDID);

    expect(launches()).toBe(4);
    expect(outline(result)).toEqual([
      "launch:pass!",
      "launch:pass!",
      "launch:pass",
      "launch:pass!",
    ]);
    expect(result.steps.map((s) => s.warning)).toEqual([notes[0], notes[1], undefined, notes[3]]);
  });
});
