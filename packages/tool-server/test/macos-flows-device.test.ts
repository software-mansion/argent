import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FAILURE_CODES, getFailureSignal, type Registry } from "@argent/registry";

// The build argent recorded last for the bundle id; host state, faked here.
const tracked: { appPath?: string } = {};
vi.mock("../src/utils/macos-apps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/macos-apps")>()),
  getTrackedMacosApp: () => (tracked.appPath ? { appPath: tracked.appPath } : undefined),
}));

import { createRunFlowTool, type FlowRunResult } from "../src/tools/flows/flow-run";
import { resolveFlowDevice } from "../src/tools/flows/flow-device";
import {
  appIdForPlatform,
  parseFlow,
  serializeFlow,
  type FlowFile,
  type Launch,
} from "../src/tools/flows/flow-utils";
import { useMacosAppsFlag } from "./helpers/macos-apps-flag";

const flag = useMacosAppsFlag();

const APP = "com.argent.probe";
const MAC_DEVICE = `macos-app-${APP}`;
const FLAG_OFF = "the macos-apps flag is off. Run: argent enable macos-apps";

interface Call {
  tool: string;
  args: Record<string, unknown>;
}

function makeRegistry(
  opts: {
    devices?: unknown[];
    /** restart-app's answer: its note, or the error it fails with. */
    restart?: { note?: string } | Error;
    capabilityOf?: (tool: string) => unknown;
  } = {}
): { registry: Registry; calls: Call[] } {
  const calls: Call[] = [];
  const registry = {
    invokeTool: vi.fn(async (tool: string, args: Record<string, unknown>) => {
      // A failed step's screenshot is not a step's action.
      if (tool === "screenshot") return {};
      calls.push({ tool, args });
      if (tool === "list-devices") return { devices: opts.devices ?? [] };
      if (tool === "restart-app") {
        if (opts.restart instanceof Error) throw opts.restart;
        return { restarted: true, bundleId: args.bundleId, ...opts.restart };
      }
      return { ok: true };
    }),
    getTool: vi.fn((tool: string) => ({
      inputSchema: { properties: { udid: {} } },
      capability: opts.capabilityOf?.(tool),
    })),
    resolveService: vi.fn(async () => {
      throw new Error("a flow on a Mac app reached a service");
    }),
  } as unknown as Registry;
  return { registry, calls };
}

let tmpDir: string;

beforeEach(async () => {
  delete tracked.appPath;
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "macos-flows-device-")));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeFlow(name: string, flow: FlowFile, root = tmpDir): Promise<void> {
  const dir = path.join(root, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.yaml`), serializeFlow(flow), "utf8");
}

async function run(
  registry: Registry,
  name: string,
  extra: Record<string, unknown> = {}
): Promise<FlowRunResult> {
  const result = await createRunFlowTool(registry).execute(
    {},
    { name, project_root: tmpDir, ...extra }
  );
  if (!("steps" in result)) throw new Error(`expected a run result, got notice: ${result.notice}`);
  return result;
}

describe("macos in the flow file platform lists", () => {
  it("parses a macos launch map, alone and beside the other platforms, and round-trips it", () => {
    for (const app of [
      { macos: APP },
      { ios: "com.argent.ios", macos: APP },
      { macos: { app: APP, args: ["-Flag", "1"] } },
    ]) {
      const yaml = `steps:\n  - launch: ${JSON.stringify(app)}\n`;
      const flow = parseFlow(yaml);
      expect(flow.steps[0]).toEqual({ kind: "launch", app });
      expect(parseFlow(serializeFlow(flow)).steps).toEqual(flow.steps);
    }
  });

  it("parses and round-trips a when: platform macos guard", () => {
    const flow = parseFlow("steps:\n  - when: { platform: macos }\n    steps: [{ echo: hi }]\n");
    expect(flow.steps[0]).toMatchObject({
      kind: "when",
      condition: { kind: "platform", platform: "macos" },
    });
    expect(parseFlow(serializeFlow(flow)).steps).toEqual(flow.steps);
  });

  it("reads a macos app id as iOS does: the macos key, else native, else the bare string", () => {
    expect(appIdForPlatform({ macos: APP, native: "com.native" }, "macos")).toBe(APP);
    expect(appIdForPlatform({ native: "com.native" }, "macos")).toBe("com.native");
    expect(appIdForPlatform(APP, "macos")).toBe(APP);
    expect(appIdForPlatform({ macos: { app: APP, args: ["-Flag"] } }, "macos")).toBe(APP);
    expect(appIdForPlatform({ ios: "com.ios" }, "macos")).toBeNull();
    // The macos key is not a chromium app path, and not read for another platform.
    expect(appIdForPlatform({ macos: APP }, "ios")).toBeNull();
    expect(appIdForPlatform({ macos: APP }, "chromium")).toBeNull();
  });

  it("accepts --platform macos on e2e-execute", () => {
    const tool = createRunFlowTool(makeRegistry().registry);
    const parsed = tool.zodSchema!.safeParse({
      name: "x",
      project_root: tmpDir,
      platform: "macos",
    });
    expect(parsed.success).toBe(true);
  });
});

describe("resolveFlowDevice with Mac app rows", () => {
  const row = (bundleId: string) => ({
    platform: "macos",
    id: `macos-app-${bundleId}`,
    state: "running",
  });

  it("selects the one running Mac app for --platform macos", async () => {
    const { registry } = makeRegistry({ devices: [row(APP)] });
    await expect(resolveFlowDevice(registry, undefined, { platform: "macos" })).resolves.toEqual({
      id: MAC_DEVICE,
      platform: "macos",
      kind: "app",
    });
  });

  it("never picks a running Mac app for a run without --platform macos", async () => {
    const sim = { platform: "ios", udid: "00000000-0000-0000-0000-0000000000ab", state: "Booted" };
    const { registry } = makeRegistry({ devices: [row(APP), sim] });
    await expect(resolveFlowDevice(registry, undefined, {})).resolves.toMatchObject({
      id: sim.udid,
    });
    const alone = makeRegistry({ devices: [row(APP)] }).registry;
    await expect(resolveFlowDevice(alone, undefined, {})).rejects.toThrow(
      /--platform macos or --device/
    );
  });

  it("names the flag when --platform macos finds nothing, and only while it is off", async () => {
    const { registry } = makeRegistry();
    const errOf = () =>
      resolveFlowDevice(registry, undefined, { platform: "macos" }).catch((e: unknown) => e);
    expect(String(await errOf())).toMatch(/No booted macos device found/);
    expect(String(await errOf())).not.toMatch(/macos-apps flag/);
    flag.off();
    expect(String(await errOf())).toMatch(
      /No booted macos device found\..*The macos-apps flag is off, so no Mac app is listed\. Run: argent enable macos-apps\./
    );
  });
});

describe("the device of a flow led by a macOS launch", () => {
  it.each<[string, Launch, Record<string, unknown>, string[]]>([
    ["a macos launch map", { macos: APP }, {}, []],
    [
      "a macos launch map with args",
      { macos: { app: APP, args: ["-Flag", "1"] } },
      {},
      ["-Flag", "1"],
    ],
    ["a bare-string launch under --platform macos", APP, { platform: "macos" }, []],
    [
      "the macos entry of a multi-platform launch under --platform macos",
      { ios: { app: "com.argent.ios", args: ["-Ios"] }, macos: APP },
      { platform: "macos" },
      [],
    ],
  ])(
    "runs %s on macos-app-<bundle id> with exactly its args, without listing devices",
    async (_label, app, extra, launchArgs) => {
      await writeFlow("e2e", { executionPrerequisite: "", steps: [{ kind: "launch", app }] });
      const { registry, calls } = makeRegistry();
      const result = await run(registry, "e2e", extra);
      expect(result.device).toBe(MAC_DEVICE);
      expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["launch:pass"]);
      expect(calls).toEqual([
        { tool: "restart-app", args: { bundleId: APP, launchArgs, udid: MAC_DEVICE } },
      ]);
    }
  );

  it("leaves a multi-platform launch with no --platform to device auto-detection", async () => {
    await writeFlow("ambiguous", {
      executionPrerequisite: "",
      steps: [{ kind: "launch", app: { ios: "com.argent.ios", macos: APP } }],
    });
    const { registry, calls } = makeRegistry({ devices: [] });
    await expect(run(registry, "ambiguous")).rejects.toThrow(/No booted device found/);
    expect(calls.map((c) => c.tool)).toEqual(["list-devices"]);
  });

  it.each([
    ["the hoisted device", {}],
    ["an explicit --device Mac app", { device: MAC_DEVICE }],
  ])("refuses %s while the flag is off, before any tool runs", async (_label, extra) => {
    flag.off();
    await writeFlow("off", {
      executionPrerequisite: "",
      steps: [{ kind: "launch", app: { macos: APP } }],
    });
    const { registry, calls } = makeRegistry();
    const err = await run(registry, "off", extra).catch((e: unknown) => e);
    expect(String(err)).toContain(FLAG_OFF);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_DEVICE_RESOLUTION);
    expect(calls).toEqual([]);
  });

  it("refuses a macos launch that is not a bundle id instead of building a device from it", async () => {
    await writeFlow("bad", {
      executionPrerequisite: "",
      steps: [{ kind: "launch", app: { macos: "com.argent/probe" } }],
    });
    const { registry, calls } = makeRegistry();
    const err = await run(registry, "bad").catch((e: unknown) => e);
    expect(String(err)).toMatch(
      /launch names "com\.argent\/probe" for macos, which is not a bundle id/
    );
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_DEVICE_RESOLUTION);
    expect(calls).toEqual([]);
  });

  it("runs a when: platform macos block on a Mac app", async () => {
    await writeFlow("guard", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "when",
          condition: { kind: "platform", platform: "macos" },
          steps: [{ kind: "tool", name: "gesture-tap", args: { x: 0.5, y: 0.5 } }],
        },
        {
          kind: "when",
          condition: { kind: "platform", platform: "ios" },
          steps: [{ kind: "tool", name: "keyboard", args: { text: "x" } }],
        },
      ],
    });
    const { registry, calls } = makeRegistry();
    const result = await run(registry, "guard", { device: MAC_DEVICE });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ tool: "gesture-tap", args: { x: 0.5, y: 0.5, udid: MAC_DEVICE } }]);
  });
});

describe("the launch step on a Mac app", () => {
  async function writeLaunch(root = tmpDir): Promise<void> {
    await writeFlow(
      "gate",
      {
        executionPrerequisite: "",
        steps: [
          { kind: "launch", app: { macos: APP } },
          { kind: "tool", name: "gesture-tap", args: { x: 0.5, y: 0.5 } },
        ],
      },
      root
    );
  }

  it("fails when restart-app does, as when the library never connects, and runs nothing after it", async () => {
    await writeLaunch();
    const { registry, calls } = makeRegistry({
      restart: new Error(`${APP} started, but the argent library did not connect`),
    });
    const result = await run(registry, "gate");
    expect(result.steps[0]).toMatchObject({
      kind: "launch",
      status: "error",
      reason: `restart-app failed: ${APP} started, but the argent library did not connect`,
    });
    expect(calls.map((c) => c.tool)).toEqual(["restart-app"]);
  });

  it("passes the launch with restart-app's note as its warning", async () => {
    await writeLaunch();
    const note = `${APP} started, but no window appeared within 5 s.`;
    const { registry } = makeRegistry({ restart: { note } });
    const result = await run(registry, "gate");
    expect(result.steps[0]).toMatchObject({ kind: "launch", status: "pass", warning: note });
    expect(result.steps[1]).toMatchObject({ status: "pass" });
  });

  it("gives a launch without a note no warning", async () => {
    await writeLaunch();
    const { registry } = makeRegistry();
    const result = await run(registry, "gate");
    expect(result.steps[0]).toMatchObject({ kind: "launch", status: "pass" });
    expect(result.steps[0]).not.toHaveProperty("warning");
  });

  it("passes, with a warning, a launch that starts the build of another worktree of the repository", async () => {
    // No commit is needed: an orphan worktree shares the repository without one.
    execFileSync("git", ["init", "-q", "main"], { cwd: tmpDir });
    execFileSync("git", ["-C", "main", "worktree", "add", "-q", "--orphan", "-b", "b", "../b"], {
      cwd: tmpDir,
    });
    tracked.appPath = path.join(tmpDir, "b", "build", "Probe.app");
    await fs.mkdir(tracked.appPath, { recursive: true });
    const root = path.join(tmpDir, "main");
    await writeLaunch(root);
    const { registry } = makeRegistry();
    const result = await run(registry, "gate", { project_root: root });
    expect(result.steps[0]).toMatchObject({
      kind: "launch",
      status: "pass",
      warning: expect.stringContaining(
        `from ${tracked.appPath}, a build of another worktree (${path.join(tmpDir, "b")})`
      ),
    });
    expect(result.steps[1]).toMatchObject({ status: "pass" });
  });
});

describe("raw tool steps on a Mac app", () => {
  // Flow sub-invocations skip the HTTP capability gate, and a tool with no
  // macOS branch picks its backend by elimination (gesture-pinch would reach
  // the simulator-server), so the runner applies the tool's own capability.
  const capabilityOf = (tool: string) =>
    tool === "gesture-pinch"
      ? { apple: { simulator: true }, android: { emulator: true } }
      : { apple: { simulator: true }, macos: { app: true } };

  it("refuses a tool that does not support Mac apps, without invoking it", async () => {
    const { registry, calls } = makeRegistry({ capabilityOf });
    await writeFlow("pinch", {
      executionPrerequisite: "",
      steps: [
        { kind: "tool", name: "gesture-pinch", args: { centerX: 0.5, centerY: 0.5, scale: 2 } },
      ],
    });
    const result = await run(registry, "pinch", { device: MAC_DEVICE });
    // A refused tool is a tool error, as any tool that throws in a `tool:` step.
    expect(result.steps[0]?.status).toBe("error");
    expect(result.steps[0]?.reason).toContain("no trackpad gesture input");
    expect(calls.map((c) => c.tool)).not.toContain("gesture-pinch");
  });

  it("runs a tool that supports Mac apps", async () => {
    const { registry, calls } = makeRegistry({ capabilityOf });
    await writeFlow("tap", {
      executionPrerequisite: "",
      steps: [{ kind: "tool", name: "gesture-tap", args: { x: 0.5, y: 0.5 } }],
    });
    const result = await run(registry, "tap", { device: MAC_DEVICE });
    expect(result.steps[0]?.status).toBe("pass");
    expect(calls.find((c) => c.tool === "gesture-tap")?.args.udid).toBe(MAC_DEVICE);
  });
});
