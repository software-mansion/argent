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
  description: `Start an iOS simulator by UDID and open the Simulator.app window.
Use when the target simulator is in the Shutdown state and must be running before calling simulator-server, launch-app, or any interaction tool.

Parameters: udid — the simulator UDID (e.g. A1B2C3D4-E5F6-7890-ABCD-EF1234567890). Use list-simulators to discover available UDIDs.
Example: { "udid": "A1B2C3D4-E5F6-7890-ABCD-EF1234567890" }
Returns { udid, booted: true } on success. If the simulator is already booted the tool succeeds silently. Throws if the UDID is invalid or Xcode is not installed.`,
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
