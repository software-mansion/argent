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

const REMOTE = "remote:00000000-0000-0000-0000-0000000000ab"; // → platform "ios-remote"
const LOCAL = "00000000-0000-0000-0000-0000000000ab"; // → platform "ios"
let tmpDir: string;

/** Records every `restart-app` the run issued — the tool `runLaunch` starts an app with. */
function mockRegistry(launched: string[]): Registry {
  return {
    invokeTool: vi.fn(async (id: string, args: Record<string, unknown>) => {
      if (id === "list-devices") return { devices: [] };
      if (id === "restart-app") {
        launched.push(args.bundleId as string);
        return { restarted: true };
      }
      return { ok: true };
    }),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    // The local-iOS control below gates on a native-devtools connection.
    resolveService: vi.fn(async () => ({
      isConnected: () => true,
      listConnectedBundleIds: () => ["com.acme.app"],
    })),
  } as unknown as Registry;
}

async function writeFlow(name: string, flow: FlowFile): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.yaml`), serializeFlow(flow), "utf8");
}

async function run(name: string, device: string): Promise<FlowRunResult & { launched: string[] }> {
  const launched: string[] = [];
  const result = await createRunFlowTool(mockRegistry(launched)).execute(
    {},
    { name, project_root: tmpDir, device }
  );
  if (!("steps" in result))
    throw new Error(`expected a run result, got: ${JSON.stringify(result)}`);
  return Object.assign(result as FlowRunResult, { launched });
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
