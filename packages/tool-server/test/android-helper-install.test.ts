import { beforeEach, describe, expect, it, vi } from "vitest";

const adbCalls: string[][] = [];
const shellCalls: string[] = [];
let installError: string | null = null;

vi.mock("../src/utils/adb", () => ({
  runAdb: vi.fn(async (args: string[]) => {
    adbCalls.push(args);
    if (args.includes("install") && installError) {
      const message = installError;
      // One failure per configured error: the retry after the uninstall has to
      // be able to succeed.
      installError = null;
      throw new Error(message);
    }
    return { stdout: "", stderr: "" };
  }),
  adbShell: vi.fn(async (_serial: string, command: string) => {
    shellCalls.push(command);
    return "package:com.argent.androiddevtools versionCode:1\n";
  }),
}));

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

import { adbShell } from "../src/utils/adb";
import { ensureAndroidDevtoolsInstalled } from "../src/utils/android-helper-install";

const SERIAL = "emulator-5554";

function installs(): string[][] {
  return adbCalls.filter((args) => args.includes("install"));
}

beforeEach(() => {
  adbCalls.length = 0;
  shellCalls.length = 0;
  installError = null;
});

describe("ensureAndroidDevtoolsInstalled", () => {
  // A wipe or snapshot restore drops the package while the serial stays
  // connected, so a per-process memo would skip the install for good.
  it("probes on every call rather than trusting an earlier success", async () => {
    await ensureAndroidDevtoolsInstalled(SERIAL);
    await ensureAndroidDevtoolsInstalled(SERIAL);

    expect(shellCalls).toHaveLength(2);
    expect(installs()).toHaveLength(0);
  });

  // API levels without `cmd package` answer through `pm list packages`, which
  // reports presence only; installing on every probe would replace a working
  // helper each time.
  it("treats a present package with no readable versionCode as current", async () => {
    vi.mocked(adbShell).mockResolvedValueOnce("package:com.argent.androiddevtools\n");

    await ensureAndroidDevtoolsInstalled(SERIAL);

    expect(installs()).toHaveLength(0);
  });

  it("installs when the device has no helper", async () => {
    vi.mocked(adbShell).mockResolvedValueOnce("");

    await ensureAndroidDevtoolsInstalled(SERIAL);

    expect(installs()).toEqual([
      ["-s", SERIAL, "install", "-r", "-t", "/tmp/argent-android-devtools.apk"],
    ]);
  });

  it("skips the probe and downgrades over the installed build when forced", async () => {
    await ensureAndroidDevtoolsInstalled(SERIAL, { force: true });

    expect(shellCalls).toHaveLength(0);
    expect(installs()).toEqual([
      ["-s", SERIAL, "install", "-r", "-t", "-d", "/tmp/argent-android-devtools.apk"],
    ]);
  });

  it("uninstalls and retries a forced install the signing key blocks", async () => {
    installError = "adb: failed to install: INSTALL_FAILED_UPDATE_INCOMPATIBLE";

    await ensureAndroidDevtoolsInstalled(SERIAL, { force: true });

    expect(adbCalls.map((args) => args[2])).toEqual(["install", "uninstall", "install"]);
    expect(installs()[1]).toContain("-d");
  });
});
