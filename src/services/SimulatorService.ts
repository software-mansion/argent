import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import { SimulatorInfo, TokenVerifyResult } from "../types/index";

const execFileAsync = promisify(execFile);

const BINARY_PATH = path.join(__dirname, "..", "..", "simulator-server");

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

export class SimulatorService {
  async listAll(): Promise<SimulatorInfo[]> {
    const { stdout } = await execFileAsync("xcrun", ["simctl", "list", "devices", "--json"]);
    const data: SimctlOutput = JSON.parse(stdout);
    const simulators: SimulatorInfo[] = [];

    for (const [runtimeId, devices] of Object.entries(data.devices)) {
      if (!runtimeId.includes("iOS")) continue;
      for (const device of devices) {
        if (!device.isAvailable) continue;
        simulators.push({
          udid: device.udid,
          name: device.name,
          state: device.state,
          deviceTypeId: device.deviceTypeIdentifier,
          runtimeId,
        });
      }
    }

    return simulators;
  }

  async listRunning(): Promise<SimulatorInfo[]> {
    const all = await this.listAll();
    return all.filter((s) => s.state === "Booted");
  }

  async boot(udid: string): Promise<void> {
    await execFileAsync("xcrun", ["simctl", "boot", udid]);
  }

  async shutdown(udid: string): Promise<void> {
    await execFileAsync("xcrun", ["simctl", "shutdown", udid]);
  }

  async getFingerprint(): Promise<string> {
    const { stdout } = await execFileAsync(BINARY_PATH, ["fingerprint"]);
    return stdout.trim();
  }

  async verifyToken(token: string): Promise<TokenVerifyResult> {
    const { stdout } = await execFileAsync(BINARY_PATH, ["verify_token", token]);
    const output = stdout.trim();

    if (output.startsWith("token_valid")) {
      const parts = output.split(" ");
      return { valid: true, plan: parts[1] };
    } else {
      // token_invalid <reason>
      const parts = output.split(" ");
      return { valid: false, reason: parts[1] ?? "unknown" };
    }
  }
}
