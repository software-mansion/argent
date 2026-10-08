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
// `runLaunch` goes restart-app → treeSourceGate, and the gate reads the
// accessibility tree until it names the launched app as the foreground app.

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow, type FlowFile } from "../../src/tools/flows/flow-utils";

const REMOTE = "remote:00000000-0000-0000-0000-0000000000ab"; // → platform "ios-remote"
const LOCAL = "00000000-0000-0000-0000-0000000000ab"; // → platform "ios"
let tmpDir: string;

/** Records every `restart-app` the run issued — the tool `runLaunch` starts an app with. */
function mockRegistry(
  launched: string[],
  foregroundApp: string,
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
    // Both iOS platforms gate the launch on the accessibility tree naming the app.
    resolveService: vi.fn(async () => ({
      degraded: false,
      tree: async () => ({
        alertVisible: false,
        nodes: [],
        truncated: false,
        foregroundApp,
        treeVersion: 2,
      }),
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
  foregroundApp = "com.acme.app"
): Promise<FlowRunResult & { launched: string[]; restartArgs: Record<string, unknown>[] }> {
  const launched: string[] = [];
  const restartArgs: Record<string, unknown>[] = [];
  const result = await createRunFlowTool(
    mockRegistry(launched, foregroundApp, restartArgs)
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
  /**
   * Run with another app in front for good, the clock faked through the
   * launch's settle and the gate's whole wait. Each pump is a real event-loop
   * turn, so the run's disk I/O settles between advances.
   */
  async function runBehindSpringboard(device: string) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const pending = run("cross", device, "com.apple.springboard");
      let settled = false;
      void pending.then(
        () => (settled = true),
        () => (settled = true)
      );
      for (let i = 0; i < 1000 && !settled; i++) {
        await new Promise((resolve) => setImmediate(resolve));
        await vi.advanceTimersByTimeAsync(250);
      }
      return await pending;
    } finally {
      vi.useRealTimers();
    }
  }

  it("fails the launch when the tree never names the app as the foreground app", async () => {
    await writeFlow("cross", CROSS_PLATFORM);

    const result = await runBehindSpringboard(REMOTE);

    // `restart-app` succeeded: the failure is the gate, not the launch.
    expect(result.launched).toEqual(["com.acme.app"]);
    expect(result.steps[0].status).toBe("error");
    expect(result.steps[0].reason).toContain("com.acme.app did not become the foreground app");
    expect(result.steps[0].reason).toContain("com.apple.springboard is in the foreground");
    expect(result.ok).toBe(false);
  });

  it("reports it in the same words a local simulator reports", async () => {
    // One gate, two hosts. A divergence here means the remote arm has grown its
    // own advice, which the author cannot act on differently anyway.
    await writeFlow("cross", CROSS_PLATFORM);

    const remote = await runBehindSpringboard(REMOTE);
    const local = await runBehindSpringboard(LOCAL);

    expect(remote.steps[0].reason).toBe(local.steps[0].reason);
  });
});
