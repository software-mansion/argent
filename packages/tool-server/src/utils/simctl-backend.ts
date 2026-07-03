import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { simctlLaunch, simctlTerminate } from "./sim-remote";

const execFileAsync = promisify(execFile);

/**
 * Strategy for the simctl verbs that a tool handler shells out to. Lets a
 * single iOS handler serve both local sims (`xcrun simctl`) and remote sims
 * (`sim-remote simctl`) without an `isRemote` branch inside the handler body.
 */
export interface SimctlBackend {
  launch(udid: string, bundleId: string): Promise<void>;
  terminate(udid: string, bundleId: string): Promise<void>;
}

export const localSimctl: SimctlBackend = {
  async launch(udid, bundleId) {
    await execFileAsync("xcrun", ["simctl", "launch", udid, bundleId]);
  },
  async terminate(udid, bundleId) {
    await execFileAsync("xcrun", ["simctl", "terminate", udid, bundleId]);
  },
};

export const remoteSimctl: SimctlBackend = {
  launch: simctlLaunch,
  terminate: simctlTerminate,
};
