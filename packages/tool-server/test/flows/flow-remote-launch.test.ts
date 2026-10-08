import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";

// A `launch:` step on a remote (cloud) simulator. The device resolves as
// platform "ios-remote", a spelling a flow file cannot write — the launch map
// takes `ios`. So the runner reads the map by the AUTHORING platform, and a
// cross-platform flow starts its app in the cloud with no file edit.
//
// No tree stub: a launch-only flow reads no UI tree. `runLaunch` goes
// restart-app → treeSourceGate, and the gate resolves a service rather than
// reading a tree.

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow, type FlowFile } from "../../src/tools/flows/flow-utils";

/** The app element every daemon tree starts with: a launch gate probe needs one node to count as a read. */
const APP_NODE = { index: 0, label: "App", frame: { x: 0, y: 0, width: 1, height: 1 } };

const REMOTE = "remote:00000000-0000-0000-0000-0000000000ab"; // → platform "ios-remote"
const LOCAL = "00000000-0000-0000-0000-0000000000ab"; // → platform "ios"
let tmpDir: string;

/** Records every `restart-app` the run issued — the tool `runLaunch` starts an app with. */
function mockRegistry(
  launched: string[],
  resolveService?: Registry["resolveService"],
  restartArgs: Record<string, unknown>[] = []
): Registry {
  return {
    invokeTool: vi.fn(async (id: string, args: Record<string, unknown>) => {
      if (id === "list-devices") return { devices: [] };
      if (id === "restart-app") {
        launched.push(args.bundleId as string);
        restartArgs.push(args);
        return { restarted: true };
      }
      return { ok: true };
    }),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    // Both iOS platforms gate the launch on the accessibility daemon resolving;
    // a launch-only flow never reads its tree.
    resolveService:
      resolveService ??
      vi.fn(async () => ({
        tree: async () => ({ alertVisible: false, nodes: [APP_NODE], truncated: false }),
      })),
  } as unknown as Registry;
}

async function writeFlow(name: string, flow: FlowFile): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.yaml`), serializeFlow(flow), "utf8");
}

async function run(
  name: string,
  device: string,
  resolveService?: Registry["resolveService"]
): Promise<FlowRunResult & { launched: string[]; restartArgs: Record<string, unknown>[] }> {
  const launched: string[] = [];
  const restartArgs: Record<string, unknown>[] = [];
  const result = await createRunFlowTool(
    mockRegistry(launched, resolveService, restartArgs)
  ).execute({}, { name, project_root: tmpDir, device });
  if (!("steps" in result))
    throw new Error(`expected a run result, got: ${JSON.stringify(result)}`);
  return Object.assign(result as FlowRunResult, { launched, restartArgs });
}

const CROSS_PLATFORM: FlowFile = {
  executionPrerequisite: "",
  steps: [{ kind: "launch", app: { ios: "com.acme.app", android: "com.acme.app.android" } }],
};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-remote-launch-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("launch on a remote simulator", () => {
  it("starts the app the flow's `ios` entry names", async () => {
    await writeFlow("cross", CROSS_PLATFORM);

    const result = await run("cross", REMOTE);

    expect(result.device).toBe(REMOTE);
    expect(result.launched).toEqual(["com.acme.app"]);
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["launch:pass"]);
    expect(result.ok).toBe(true);
  });

  it("starts the same app a local simulator does, from the same file", async () => {
    // The control: one flow, two hosts, one app. If these ever diverge the
    // launch map has started to name a machine.
    await writeFlow("cross", CROSS_PLATFORM);

    expect((await run("cross", LOCAL)).launched).toEqual(["com.acme.app"]);
  });

  it("names a key the author can write when no entry applies", async () => {
    // The reason is advice: quoting "ios-remote" would send the reader to a key
    // the parser rejects as a misspelled platform.
    await writeFlow("android-only", {
      executionPrerequisite: "",
      steps: [{ kind: "launch", app: { android: "com.acme.app.android" } }],
    });

    const result = await run("android-only", REMOTE);

    expect(result.steps[0].status).toBe("error");
    expect(result.steps[0].reason).toContain('no app id declared for platform "ios"');
    expect(result.steps[0].reason).not.toContain("ios-remote");
    expect(result.ok).toBe(false);
  });
});

describe("launch args from an ios { app, args } entry", () => {
  const WITH_ARGS: FlowFile = {
    executionPrerequisite: "",
    steps: [
      {
        kind: "launch",
        app: { ios: { app: "com.acme.app", args: ["-Flag", "YES"] }, android: "com.acme.app" },
      },
    ],
  };

  it.each([
    ["a local simulator", LOCAL],
    ["a remote simulator", REMOTE],
  ])("forwards them as launchArgs on %s", async (_label, device) => {
    await writeFlow("with-args", WITH_ARGS);

    const result = await run("with-args", device);

    expect(result.restartArgs).toEqual([
      expect.objectContaining({ bundleId: "com.acme.app", launchArgs: ["-Flag", "YES"] }),
    ]);
    expect(result.ok).toBe(true);
  });

  it("does not forward them on Android", async () => {
    await writeFlow("with-args", WITH_ARGS);

    const result = await run("with-args", "emulator-5554");

    expect(result.restartArgs).toHaveLength(1);
    expect(result.restartArgs[0]).toMatchObject({ bundleId: "com.acme.app" });
    expect(result.restartArgs[0]).not.toHaveProperty("launchArgs");
  });

  it("sends no launchArgs for a bare ios id", async () => {
    await writeFlow("cross", CROSS_PLATFORM);

    const result = await run("cross", LOCAL);

    expect(result.restartArgs).toHaveLength(1);
    expect(result.restartArgs[0]).not.toHaveProperty("launchArgs");
  });
});

// The launch gate. Without it a remote run passes its `launch:` the instant
// `restart-app` returns, and the first directive behind it races the cold
// start - which is how four taps 50ms apart went out into a still-launching app
// and every one of them reported `pass`.
describe("a remote launch waits for the tree source, exactly as a local one does", () => {
  /** An accessibility daemon that never resolves for this device. */
  const unavailable = vi.fn(async () => {
    throw new Error("no sim-remote tunnel");
  }) as unknown as Registry["resolveService"];

  it("fails the launch when the accessibility daemon never comes up", async () => {
    await writeFlow("cross", CROSS_PLATFORM);

    const result = await run("cross", REMOTE, unavailable);

    expect(result.steps[0].status).toBe("error");
    expect(result.steps[0].reason).toContain(
      `the accessibility daemon (ax-service) is not available for ${REMOTE}`
    );
    // The resolution error is the only place the cause surfaces.
    expect(result.steps[0].reason).toContain("no sim-remote tunnel");
    expect(result.ok).toBe(false);
  });

  it("reports it in the same words a local simulator reports", async () => {
    // One gate, two hosts. A divergence here means the remote arm has grown its
    // own advice, which the author cannot act on differently anyway. Only the
    // device id the reason names differs.
    await writeFlow("cross", CROSS_PLATFORM);

    const remote = await run("cross", REMOTE, unavailable);
    const local = await run("cross", LOCAL, unavailable);

    // The id appears twice: in the outage and in the scoped restart it advises.
    expect(remote.steps[0].reason?.replaceAll(REMOTE, "<device>")).toBe(
      local.steps[0].reason?.replaceAll(LOCAL, "<device>")
    );
  });

  it("still gates the launch when the app itself was started fine", async () => {
    // `restart-app` succeeded: the failure is the gate, not the launch, so the
    // app id it started is on record and the reason says why the daemon matters.
    await writeFlow("cross", CROSS_PLATFORM);

    const result = await run("cross", REMOTE, unavailable);

    expect(result.launched).toEqual(["com.acme.app"]);
    expect(result.steps[0].reason).toContain("resolve selectors against its tree");
  });
});
