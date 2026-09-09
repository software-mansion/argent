import { describe, expect, it, vi } from "vitest";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import { installApp, launchApp } from "../src/utils/ios-device/devicectl";

const fake = vi.hoisted(() => ({ stderr: "", code: undefined as number | undefined }));

// devicectl promisifies execFile at module load, so the mock must replace the
// callback-style function itself; every call fails with the scripted stderr.
vi.mock("node:child_process", () => ({
  execFile: (_file: unknown, _args: unknown, _options: unknown, callback: unknown) => {
    (callback as (error: Error) => void)(
      Object.assign(new Error("Command failed: xcrun devicectl"), {
        stdout: "",
        stderr: fake.stderr,
        code: fake.code,
      })
    );
  },
}));

const UDID = "00008110-000978540290401E";

describe("devicectl error hints are folded into the message", () => {
  it("carries the unlock guidance for a locked-screen launch failure", async () => {
    fake.stderr = "ERROR: The application failed to launch.";

    const error = await launchApp(UDID, "com.example.app").catch((caught: unknown) => caught);

    expect((error as Error).name).toBe("IosDeviceControlError");
    expect((error as Error).message).toBe(
      "Failed to launch com.example.app: ERROR: The application failed to launch. " +
        "Hint: Unlock the device and keep the screen awake, then retry; " +
        "if it is already unlocked, check the phone's screen: a pending system prompt " +
        "(for example a default-app choice) also blocks launches."
    );
    // The property survives for callers that branch on it.
    expect((error as { hint?: string | null }).hint).toContain("Unlock the device");
  });

  it("carries the trust/pairing guidance for an unpaired-device failure", async () => {
    fake.stderr = "ERROR: The device must be paired before use";

    const error = await installApp(UDID, "/tmp/Example.app").catch((caught: unknown) => caught);

    expect((error as Error).message).toContain("Failed to install app");
    expect((error as Error).message).toContain(
      "Connect the device by cable, accept the Trust prompt"
    );
  });

  it("prefers the developer-mode guidance over the unlock hint for a 10002 launch failure", async () => {
    // devicectl wraps every process launch failure as 10002, so the specific
    // cause in the same output has to win over the hedged unlock guidance.
    fake.stderr =
      "ERROR: The application failed to launch. (com.apple.dt.CoreDeviceError error 10002 (0x2712))\n" +
      "Developer Mode is disabled on this device.";

    const error = await launchApp(UDID, "com.example.app").catch((caught: unknown) => caught);

    expect((error as { hint?: string | null }).hint).toContain("Enable Developer Mode");
    expect((error as Error).message).not.toContain("Unlock the device");
  });

  it("names the bundle id and reinstall-app when the app is not installed", async () => {
    const notInstalled =
      "com.example.missing is not installed on the device; install it with reinstall-app, then retry.";

    // SpringBoard's shape, wrapped in the same 10002 launch failure.
    fake.stderr =
      "ERROR: The application failed to launch. (com.apple.dt.CoreDeviceError error 10002 (0x2712))\n" +
      'Application info provider (FBSApplicationLibrary) returned nil for "com.example.missing"';
    let error = await launchApp(UDID, "com.example.missing").catch((caught: unknown) => caught);
    expect((error as { hint?: string | null }).hint).toBe(notInstalled);

    // The plainer shape from other toolchain versions.
    fake.stderr = "ERROR: The requested application com.example.missing could not be found.";
    error = await launchApp(UDID, "com.example.missing").catch((caught: unknown) => caught);
    expect((error as { hint?: string | null }).hint).toBe(notInstalled);
  });

  it("keeps the hedged unlock guidance for a bare 10002 failure", async () => {
    fake.stderr =
      "ERROR: The operation couldn't be completed. (com.apple.dt.CoreDeviceError error 10002 (0x2712))";

    const error = await launchApp(UDID, "com.example.app").catch((caught: unknown) => caught);

    expect((error as { hint?: string | null }).hint).toContain("Unlock the device");
  });
});

describe("devicectl failures carry a structured failure signal", () => {
  it("stamps IOS_DEVICECTL_COMMAND_FAILED with subprocess metadata, hint and class intact", async () => {
    fake.stderr = "ERROR: The application failed to launch.";
    fake.code = 1;

    const error = await launchApp(UDID, "com.example.app").catch((caught: unknown) => caught);

    const signal = getFailureSignal(error);
    expect(signal?.error_code).toBe(FAILURE_CODES.IOS_DEVICECTL_COMMAND_FAILED);
    expect(signal?.error_kind).toBe("subprocess");
    expect(signal?.failure_exit_code).toBe(1);
    // Stamping must not disturb the hint-folded error surface.
    expect((error as Error).name).toBe("IosDeviceControlError");
    expect((error as { hint?: string | null }).hint).toContain("Unlock the device");
  });
});
