import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface IosSimulator {
  udid: string;
  name: string;
  state: string;
  runtime: string;
}

interface SimctlDevice {
  udid: string;
  name: string;
  state: string;
  deviceTypeIdentifier: string;
  isAvailable: boolean;
}

interface SimctlOutput {
  devices: Record<string, SimctlDevice[]>;
}

/**
 * List all available iOS simulators via `xcrun simctl list devices --json`.
 * Returns an empty array when xcrun is missing or the call fails so the
 * rest of the tool surface stays usable on non-mac hosts.
 */
export async function listIosSimulators(): Promise<IosSimulator[]> {
  try {
    const { stdout } = await execFileAsync("xcrun", ["simctl", "list", "devices", "--json"], {
      timeout: 10_000,
    });
    const data: SimctlOutput = JSON.parse(stdout);
    const out: IosSimulator[] = [];
    for (const [runtimeId, devices] of Object.entries(data.devices)) {
      if (!runtimeId.includes("iOS")) continue;
      for (const d of devices) {
        if (!d.isAvailable) continue;
        out.push({ udid: d.udid, name: d.name, state: d.state, runtime: runtimeId });
      }
    }
    return out;
  } catch {
    return [];
  }
}
