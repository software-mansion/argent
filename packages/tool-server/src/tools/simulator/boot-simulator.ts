import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";

const execFileAsync = promisify(execFile);

const zodSchema = z.object({
  udid: z.string().describe("The UDID of the simulator to boot"),
});

export const bootSimulatorTool: ToolDefinition<{ udid: string }> = {
  id: "boot-simulator",
  description: "Start an iOS simulator by UDID. Use when the target simulator is in Shutdown state before starting a session. Returns when the simulator is ready. Fails if the UDID is invalid or Xcode tools are not installed.",
  zodSchema,
  services: () => ({}),
  async execute(_services, params, _options) {
    const bootPromise = execFileAsync("xcrun", ["simctl", "boot", params.udid]).catch(
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        // xcrun simctl boot exits with an error if the device is already booted — treat as success
        if (!message.includes("Unable to boot device in current state: Booted")) {
          throw err;
        }
      }
    );
    await bootPromise;
    // Write the preference before opening so it applies to both fresh launches and
    // already-running instances. `open --args` is ignored when the app is already running.
    await execFileAsync("defaults", [
      "write",
      "com.apple.iphonesimulator",
      "CurrentDeviceUDID",
      params.udid,
    ]);
    await execFileAsync("open", ["-a", "Simulator.app"]);
    return { udid: params.udid, booted: true };
  },
};
