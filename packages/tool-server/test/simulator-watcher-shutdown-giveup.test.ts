import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execSimctlMock = vi.fn();
const sim = vi.hoisted(() => ({ booted: false }));
const spawnCalls: string[][] = [];

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (
      cmd: string,
      args: readonly string[],
      opts: unknown,
      cb?: (err: Error | null, out: { stdout: string; stderr: string }) => void
    ) => {
      const callback = typeof opts === "function" ? opts : cb!;
      if (args.includes("list")) return callback(null, { stdout: '{"devices":{}}', stderr: "" });
      if (args.includes("spawn")) {
        spawnCalls.push([...args]);
        if (!sim.booted) {
          const e = new Error(
            "Process spawn via launchd failed because device is not booted."
          ) as Error & {
            stdout: string;
            stderr: string;
          };
          e.stdout = "";
          e.stderr = e.message;
          return callback(e, { stdout: "", stderr: e.message });
        }
      }
      callback(null, { stdout: "", stderr: "" });
    },
  };
});

vi.mock("@argent/native-devtools-ios", async () => {
  const actual = await vi.importActual<typeof import("@argent/native-devtools-ios")>(
    "@argent/native-devtools-ios"
  );
  return { ...actual, bootstrapDylibPath: () => "/tmp/fake-bootstrap.dylib" };
});

vi.mock("../src/utils/simctl-exec", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/simctl-exec")>(
    "../src/utils/simctl-exec"
  );
  return { ...actual, execSimctl: (...args: unknown[]) => execSimctlMock(...args) };
});

vi.mock("../src/utils/ios-device-sets", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/ios-device-sets")>(
    "../src/utils/ios-device-sets"
  );
  return { ...actual, configuredAdditionalDeviceSets: () => [] };
});

import { Registry, type DeviceInfo } from "@argent/registry";
import {
  nativeDevtoolsBlueprint,
  nativeDevtoolsRef,
  precheckNativeDevtools,
  type NativeDevtoolsApi,
} from "../src/blueprints/native-devtools";
import * as watcher from "../src/utils/simulator-watcher";
import { processScopedUdid } from "./helpers/process-scoped-udid";

const SIMULATOR: DeviceInfo = {
  id: processScopedUdid("-9a23-4523-8523-152315231599"),
  platform: "ios",
  kind: "simulator",
};
const BOOTED = JSON.stringify({
  devices: { "iOS-18-0": [{ udid: SIMULATOR.id, state: "Booted" }] },
});

let registry: Registry;
beforeEach(() => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.useFakeTimers();
  registry = new Registry();
  registry.registerBlueprint(nativeDevtoolsBlueprint);
  sim.booted = false;
  execSimctlMock.mockResolvedValue('{"devices":{}}');
});
afterEach(async () => {
  await registry.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function armWhileShutDown(): Promise<NativeDevtoolsApi> {
  for (let i = 0; i < 3; i++) await watcher.armSimulator(SIMULATOR.id);
  const ref = nativeDevtoolsRef(SIMULATOR);
  const service = await registry.resolveService<NativeDevtoolsApi>(ref.urn, ref.options);
  expect(service.getInitFailure()).toMatchObject({ attempts: 3, givenUp: false });
  return service;
}

describe("a simulator targeted while shut down", () => {
  it("is armed by the watcher once it boots", async () => {
    const { ready, stop } = watcher.startSimulatorWatcher(registry);
    await ready;
    const service = await armWhileShutDown();

    sim.booted = true;
    execSimctlMock.mockResolvedValue(BOOTED);
    await vi.advanceTimersByTimeAsync(10_000);
    stop();
    expect(service.isEnvSetup()).toBe(true);
  });

  it("passes the launch precheck right after it boots, before the next poll", async () => {
    const { ready, stop } = watcher.startSimulatorWatcher(registry);
    await ready;
    const service = await armWhileShutDown();

    sim.booted = true;
    execSimctlMock.mockResolvedValue(BOOTED);
    const block = await precheckNativeDevtools(service, SIMULATOR.id);
    stop();
    expect(block).toBeNull();
    expect(service.isEnvSetup()).toBe(true);
  });
});
