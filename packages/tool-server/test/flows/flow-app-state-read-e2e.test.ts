import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { NativeAppState, NativeDevtoolsApi } from "../../src/blueprints/native-devtools";
import type { IosDeviceRunnerApi } from "../../src/blueprints/ios-device-runner";
import {
  clearCurrentIosDeviceApp,
  setCurrentIosDeviceApp,
} from "../../src/utils/ios-device/app-session";
import { RunnerCommandError } from "../../src/utils/ios-device/runner-client";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";

// A read that fails because of which app is connected or in the foreground
// right now is not a refusal: a crash, a relaunch or a step that left the app
// changes that state, so a re-run can read the tree. The step is flagged and
// gets the shared hint, the same as when nothing is connected at all. Nothing
// on the tree path is mocked: the runner goes through the REAL fetchFlowTree
// and its iOS readers, and the only seams are the native-devtools service and
// the physical-device runner.

const SIMULATOR = "00000000-0000-0000-0000-0000000000ab"; // iOS simulator UDID shape
const PHONE = "00008110-000978540290401E"; // physical iPhone UDID shape
const APP = "com.example.app";
let tmpDir: string;

/** A connected app that answers the state probe from the background. */
function backgroundState(bundleId: string): NativeAppState {
  return {
    bundleId,
    applicationState: "background",
    foregroundActiveSceneCount: 0,
    foregroundInactiveSceneCount: 0,
    backgroundSceneCount: 1,
    unattachedSceneCount: 0,
    isFrontmostCandidate: false,
  };
}

/** The app under test is gone; only `connected`, all in the background, remain. */
function simulatorRegistry(connected: string[]): Registry {
  const api = {
    listConnectedBundleIds: () => connected,
    isConnected: (id: string) => connected.includes(id),
    getAppState: async (id: string) => backgroundState(id),
    queryViewHierarchy: async () => {
      throw new Error("no connected app is in the foreground, so none may be read");
    },
  } as unknown as NativeDevtoolsApi;
  return {
    resolveService: async () => api,
    invokeTool: async () => ({ ok: true }),
    getTool: () => undefined,
  } as unknown as Registry;
}

/** A physical-device runner that refuses to snapshot a backgrounded app. */
function phoneRegistry(): Registry {
  const api: IosDeviceRunnerApi = {
    udid: PHONE,
    run: async () => {
      throw new RunnerCommandError(`app '${APP}' is running in the background`, {
        code: "APP_BACKGROUNDED",
      });
    },
  };
  return {
    resolveService: async () => api,
    invokeTool: async () => ({ ok: true }),
    getTool: () => undefined,
  } as unknown as Registry;
}

async function runAssert(registry: Registry, device: string): Promise<FlowRunResult> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "home.yaml"),
    serializeFlow({
      executionPrerequisite: "",
      steps: [{ kind: "assert", condition: "visible", selector: { text: "Home" } }],
    }),
    "utf8"
  );
  const result = await createRunFlowTool(registry).execute(
    {},
    { name: "home", project_root: tmpDir, device }
  );
  if (!("steps" in result)) throw new Error(`expected a run result, got: ${result.notice}`);
  return result;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-app-state-read-"));
});
afterEach(async () => {
  clearCurrentIosDeviceApp(PHONE);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("a read that fails on the app state of the moment", () => {
  const CONNECTED_SETS: string[][] = [[], ["com.apple.Other"], ["com.apple.A", "com.apple.B"]];

  for (const connected of CONNECTED_SETS) {
    it(`flags the step when the app is gone and [${connected.join(", ")}] is connected`, async () => {
      const r = await runAssert(simulatorRegistry(connected), SIMULATOR);

      expect(r.steps[0]).toMatchObject({ kind: "assert", status: "fail", indeterminate: true });
      expect(r.steps[0].reason).toContain("could not read the UI tree");
      expect(r.steps[0].hint).toMatch(/^check the app first/);
    });
  }

  it("flags the step when a physical iPhone's app is in the background", async () => {
    setCurrentIosDeviceApp(PHONE, APP);
    const r = await runAssert(phoneRegistry(), PHONE);

    expect(r.steps[0]).toMatchObject({ kind: "assert", status: "fail", indeterminate: true });
    expect(r.steps[0].reason).toContain("is backgrounded");
    expect(r.steps[0].hint).toMatch(/^check the app first/);
  });

  // The control: no app under automation is a refusal. A re-run reads nothing
  // either, until the e2e test launches an app.
  it("does not flag the step when a physical iPhone has no app under automation", async () => {
    const r = await runAssert(phoneRegistry(), PHONE);

    expect(r.steps[0]).toMatchObject({ kind: "assert", status: "fail" });
    expect(r.steps[0].reason).toContain("No app is under automation");
    expect(r.steps[0]).not.toHaveProperty("indeterminate");
    expect(r.steps[0]).not.toHaveProperty("hint");
  });
});
