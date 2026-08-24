import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { simctlArgsForUdid } from "./ios-device-sets";
import { simctlLaunch, simctlTerminate } from "./sim-remote";

const execFileAsync = promisify(execFile);

export interface SimctlBackend {
  launch(udid: string, bundleId: string): Promise<void>;
  terminate(udid: string, bundleId: string): Promise<void>;
}

export const localSimctl: SimctlBackend = {
  async launch(udid, bundleId) {
    await execFileAsync("xcrun", await simctlArgsForUdid(udid, ["launch", udid, bundleId]));
  },
  async terminate(udid, bundleId) {
    await execFileAsync("xcrun", await simctlArgsForUdid(udid, ["terminate", udid, bundleId]));
  },
};

export const remoteSimctl: SimctlBackend = {
  launch: simctlLaunch,
  terminate: simctlTerminate,
};
