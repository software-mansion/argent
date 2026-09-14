import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FAILURE_CODES, FailureError, getFailureSignal, type DeviceInfo } from "@argent/registry";
import { fakeAmInstrument } from "../helpers/fake-am-instrument";

const am = fakeAmInstrument();
const adbCalls: string[][] = [];
let installFails: Error | string | null = null;

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: () => am.spawn() };
});

vi.mock("../../src/utils/adb", () => ({
  runAdb: vi.fn(async (args: string[]) => {
    adbCalls.push(args);
    if (args.includes("forward")) return { stdout: "45678\n", stderr: "" };
    if (args.includes("install") && installFails) {
      throw typeof installFails === "string" ? new Error(installFails) : installFails;
    }
    return { stdout: "", stderr: "" };
  }),
  // The probe reports the bundled build as present, so every install in these
  // tests is one the repair path forced.
  adbShell: vi.fn(async () => "package:com.argent.androiddevtools versionCode:1\n"),
}));

vi.mock("../../src/utils/android-binary", () => ({
  resolveAndroidBinary: vi.fn(async () => "/usr/bin/adb"),
}));

// The bundled APK is built by a gradle step CI does not run.
vi.mock("@argent/native-devtools-android", () => ({
  helperManifest: () => ({
    packageName: "com.argent.androiddevtools",
    instrumentationRunner: "com.argent.androiddevtools/.SnapshotInstrumentation",
    versionName: "0.1.0",
    versionCode: 1,
    installFlags: ["-r", "-t"],
  }),
  bundledHelperApkPath: () => "/tmp/argent-android-devtools.apk",
}));

vi.mock("../../src/utils/android-devtools-client", () => ({
  connectAndroidDevtoolsClient: vi.fn(async () => ({
    request: vi.fn(async () => ({ ok: true })),
    close: vi.fn(),
  })),
}));

import { androidDevtoolsBlueprint } from "../../src/blueprints/android-devtools";
import {
  __resetAndroidDevtoolsInstallCache,
  __setHelperAttemptCooldownForTesting,
} from "../../src/utils/android-helper-install";

const DEVICE: DeviceInfo = { id: "emulator-5554", platform: "android", kind: "emulator" };

const MISSING = {
  stdout: [
    "INSTRUMENTATION_STATUS: Error=Unable to find instrumentation info for: ComponentInfo{com.argent.androiddevtools/.SnapshotInstrumentation}",
    "INSTRUMENTATION_STATUS_CODE: -1",
  ],
  exit: { code: 1 },
};
const READY = { stdout: ["INSTRUMENTATION_STATUS: port=41000"] };

function installs(): string[][] {
  return adbCalls.filter((args) => args.includes("install"));
}

async function start() {
  return androidDevtoolsBlueprint.factory({}, DEVICE, { device: DEVICE });
}

beforeEach(() => {
  adbCalls.length = 0;
  am.spawned.length = 0;
  installFails = null;
  __resetAndroidDevtoolsInstallCache();
  __setHelperAttemptCooldownForTesting(5 * 60_000);
});

afterEach(() => {
  __resetAndroidDevtoolsInstallCache();
  __setHelperAttemptCooldownForTesting(5 * 60_000);
});

describe("android-devtools helper repair", () => {
  it("reinstalls once and starts when the device says the instrumentation is missing", async () => {
    am.queue(MISSING, READY);

    const instance = await start();

    expect(instance.api.isReady()).toBe(true);
    expect(am.spawned).toHaveLength(2);
    expect(installs()).toHaveLength(1);
    // `-d` so the reinstall may go backwards over a foreign same-version build.
    expect(installs()[0]).toEqual(expect.arrayContaining(["install", "-r", "-t", "-d"]));

    await instance.dispose();
  });

  it("reports the repair failure with the command that shows the device's reason", async () => {
    am.queue(MISSING);

    const err = await start().catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(
      FAILURE_CODES.ANDROID_DEVTOOLS_HELPER_REPAIR_FAILED
    );
    expect((err as Error).message).toContain("even after reinstalling it");
    expect((err as Error).message).toContain(
      "adb -s emulator-5554 shell am instrument -w com.argent.androiddevtools/.SnapshotInstrumentation"
    );
    expect(installs()).toHaveLength(1);
  });

  it("does not reinstall for a fault a reinstall cannot fix", async () => {
    am.queue({
      stdout: ["INSTRUMENTATION_STATUS_CODE: -1"],
      stderr: "java.lang.SecurityException: not allowed",
      exit: { code: 1 },
    });

    const err = await start().catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(
      FAILURE_CODES.ANDROID_DEVTOOLS_HELPER_EXITED_BEFORE_READY
    );
    expect(am.spawned).toHaveLength(1);
    expect(installs()).toHaveLength(0);
  });

  it("reports an install the device rejected, without spawning a second time", async () => {
    am.queue(MISSING);
    installFails =
      "adb: failed to install /tmp/argent-android-devtools.apk: Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]";

    const err = await start().catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(
      FAILURE_CODES.ANDROID_DEVTOOLS_HELPER_INSTALL_FAILED
    );
    expect((err as Error).message).toContain("INSTALL_FAILED_INSUFFICIENT_STORAGE");
    expect(am.spawned).toHaveLength(1);
  });

  it("passes a non-install failure through as the device reported it", async () => {
    am.queue(MISSING);
    installFails =
      "Bundled Android devtools helper APK not found at /tmp/x.apk. Run `bash packages/native-devtools-android/scripts/build.sh` to build it.";

    const err = await start().catch((e: unknown) => e);

    expect((err as Error).message).toContain("to build it.");
    expect((err as Error).message).not.toContain("Unlock the device");
  });

  // A device that was asleep, busy or briefly unauthorized fixes itself, and a
  // five-minute suppression would outlast the fault.
  it("keeps a device adb cannot reach out of the cooldown", async () => {
    am.queue(MISSING);
    installFails = new Error("adb: device 'emulator-5554' not found");

    const first = await start().catch((e: unknown) => e);
    const second = await start().catch((e: unknown) => e);

    expect(getFailureSignal(first)?.error_code).toBe(
      FAILURE_CODES.ANDROID_DEVTOOLS_HELPER_INSTALL_FAILED
    );
    expect((second as Error).message).not.toContain("retrying after the cooldown");
    expect(installs()).toHaveLength(2);
  });

  // Uncached, a wedged device charges the install's own 60 s cap to every
  // auto-describe; cached for five minutes, a device that recovers waits.
  it("holds an install that timed out under the short window only", async () => {
    am.queue(MISSING);
    installFails = new FailureError("adb install timed out after 60000ms", {
      error_code: FAILURE_CODES.ANDROID_ADB_COMMAND_FAILED,
      failure_stage: "android_adb_run",
      failure_area: "tool_server",
      error_kind: "timeout",
    });

    await start().catch(() => undefined);
    const held = await start().catch((e: unknown) => e);
    expect((held as Error).message).toContain("retrying after the cooldown");
    expect(installs()).toHaveLength(1);

    // Past the short window, while the standard one would still be holding.
    __setHelperAttemptCooldownForTesting(5 * 60_000, 0);
    const retried = await start().catch((e: unknown) => e);
    expect((retried as Error).message).not.toContain("retrying after the cooldown");
    expect(installs()).toHaveLength(2);
  });

  it("replays the terminal verdict during the cooldown instead of reinstalling again", async () => {
    am.queue(MISSING);

    await start().catch(() => undefined);
    const repeat = await start().catch((e: unknown) => e);

    expect((repeat as Error).message).toContain("retrying after the cooldown");
    expect(getFailureSignal(repeat)?.error_code).toBe(
      FAILURE_CODES.ANDROID_DEVTOOLS_HELPER_REPAIR_FAILED
    );
    // The second call touched neither the device nor the helper.
    expect(am.spawned).toHaveLength(2);
    expect(installs()).toHaveLength(1);
  });

  it("forgets the verdict once the helper starts", async () => {
    am.queue(MISSING);
    await start().catch(() => undefined);

    __setHelperAttemptCooldownForTesting(0);
    am.queue(READY);
    const instance = await start();
    await instance.dispose();

    __setHelperAttemptCooldownForTesting(5 * 60_000);
    am.queue(MISSING);
    const err = await start().catch((e: unknown) => e);

    expect((err as Error).message).not.toContain("retrying after the cooldown");
  });
});
