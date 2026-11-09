import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";

const SERIAL = "emulator-5554";

// A fake device behind the real runAdb/adbShell: only execFile is stubbed, so
// the handler's whole adb conversation runs against it.
const device = {
  installed: new Set<string>(),
  // System apps: `adb uninstall` fails and the package stays.
  system: new Set<string>(),
  // Updated system apps: `adb uninstall` removes the update, says Success, and the package stays.
  updatedSystem: new Set<string>(),
  // Hidden, or uninstalled for the current user only: listed by `pm list packages` only with -u.
  hidden: new Set<string>(),
  // Before API 24: a failed `adb uninstall` exits 0, and `adb shell` output ends lines with \r\n.
  legacy: false,
  // `pm list packages` fails, e.g. the package manager is restarting.
  pmFails: false,
  // `pm list packages` never returns, so runAdb kills it at its deadline.
  pmHangs: false,
  // The deadline the hung `pm list packages` was killed at.
  pmKilledAfter: undefined as number | undefined,
  // adb cannot be resolved, so no adb command runs.
  noAdb: false,
  apkPackage: "",
  calls: [] as string[][],
};

type AdbResult = { stdout: string; stderr: string };

function failure(command: string, stdout: string): Error & AdbResult {
  return Object.assign(new Error(`Command failed: adb ${command}`), {
    code: 1,
    stdout,
    stderr: "",
  });
}

function fakeAdb(
  args: readonly string[],
  { timeout, killSignal }: { timeout?: number; killSignal?: string }
): AdbResult | Error {
  if (args[0] !== "-s" || args[1] !== SERIAL) throw new Error(`no -s ${SERIAL}: ${args.join(" ")}`);
  const argv = args.slice(2);
  device.calls.push(argv);
  const [command, ...rest] = argv;
  const eol = device.legacy ? "\r\n" : "\n";
  if (command === "shell") {
    const match = /^pm list packages (-u )?'(.+)'$/.exec(rest[0]!);
    if (!match) throw new Error(`unexpected shell command: ${rest[0]}`);
    const [, all, filter] = match;
    if (device.pmFails) return failure(`shell ${rest[0]}`, "cmd: Can't find service: package\n");
    if (device.pmHangs) {
      device.pmKilledAfter = timeout;
      // As execFile reports a child it killed at its `timeout`.
      return Object.assign(new Error(`Command failed: adb shell ${rest[0]}\n`), {
        killed: true,
        signal: killSignal ?? "SIGTERM",
        code: null,
        stdout: "",
        stderr: "",
      });
    }
    const lines = [...device.installed].filter(
      (pkg) => pkg.includes(filter!) && (all !== undefined || !device.hidden.has(pkg))
    );
    return { stdout: lines.map((pkg) => `package:${pkg}${eol}`).join(""), stderr: "" };
  }
  if (command === "uninstall") {
    const pkg = rest[0]!;
    if (device.updatedSystem.has(pkg)) {
      device.updatedSystem.delete(pkg);
      return { stdout: "Success\n", stderr: "" };
    }
    if (!device.installed.has(pkg) || device.system.has(pkg)) {
      const stdout = "Failure [DELETE_FAILED_INTERNAL_ERROR]\n";
      return device.legacy ? { stdout, stderr: "" } : failure(`uninstall ${pkg}`, stdout);
    }
    device.installed.delete(pkg);
    return { stdout: "Success\n", stderr: "" };
  }
  if (command === "install") {
    device.installed.add(device.apkPackage);
    return { stdout: "Performing Streamed Install\nSuccess\n", stderr: "" };
  }
  throw new Error(`unexpected adb call: ${argv.join(" ")}`);
}

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (
      _cmd: string,
      args: readonly string[],
      opts: unknown,
      cb?: (err: Error | null, out: AdbResult) => void
    ) => {
      const callback = typeof opts === "function" ? opts : cb!;
      const result = fakeAdb(args, opts as { timeout?: number; killSignal?: string });
      if (result instanceof Error) {
        const e = result as Error & AdbResult;
        callback(e, { stdout: e.stdout, stderr: e.stderr });
      } else callback(null, result);
    },
  };
});

vi.mock("../src/utils/apk-package", () => ({
  readApkPackageName: vi.fn(async () => device.apkPackage),
}));

vi.mock("../src/utils/android-binary", () => ({
  resolveAndroidBinary: vi.fn(async (name: "adb" | "emulator") => (device.noAdb ? null : name)),
  __resetAndroidBinaryCacheForTesting: () => {},
}));

import type { DeviceInfo } from "@argent/registry";
import { getFailureSignal } from "@argent/registry";
import { androidImpl } from "../src/tools/reinstall-app/platforms/android";

const androidDevice = { id: SERIAL, platform: "android", kind: "emulator" } as DeviceInfo;

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "reinstall-android-"));
  writeFileSync(join(dir, "app-debug.apk"), "");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function reinstall(bundleId: string) {
  device.apkPackage = bundleId;
  const appPath = join(dir, "app-debug.apk");
  return androidImpl.handler({}, { udid: SERIAL, bundleId, appPath }, androidDevice);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the reinstall to fail");
    },
    (err: unknown) => err
  );
}

const ran = (command: string) => device.calls.filter((argv) => argv[0] === command);

function expectUninstallFailure(err: unknown) {
  expect(getFailureSignal(err)).toMatchObject({
    error_code: "ANDROID_REINSTALL_UNINSTALL_FAILED",
    failure_stage: "android_reinstall_adb_uninstall",
  });
  expect(ran("install")).toEqual([]);
}

beforeEach(() => {
  device.installed = new Set();
  device.system = new Set();
  device.updatedSystem = new Set();
  device.hidden = new Set();
  device.legacy = false;
  device.pmFails = false;
  device.pmHangs = false;
  device.pmKilledAfter = undefined;
  device.noAdb = false;
  device.calls = [];
});

describe("reinstall-app on Android", () => {
  it("uninstalls the installed package, then installs the APK", async () => {
    device.installed.add("com.example.app");

    await expect(reinstall("com.example.app")).resolves.toEqual({
      reinstalled: true,
      bundleId: "com.example.app",
    });
    expect(device.calls.map((argv) => argv[0])).toEqual(["uninstall", "shell", "install"]);
    expect(ran("uninstall")).toEqual([["uninstall", "com.example.app"]]);
  });

  it("installs an app that is not installed yet", async () => {
    await expect(reinstall("com.example.app")).resolves.toEqual({
      reinstalled: true,
      bundleId: "com.example.app",
    });
    expect(device.installed.has("com.example.app")).toBe(true);
  });

  it("uninstalls a package that pm list packages does not show", async () => {
    device.installed.add("com.example.app");
    device.hidden.add("com.example.app");

    await expect(reinstall("com.example.app")).resolves.toEqual({
      reinstalled: true,
      bundleId: "com.example.app",
    });
    expect(ran("uninstall")).toEqual([["uninstall", "com.example.app"]]);
  });

  it("fails without installing when the package cannot be uninstalled", async () => {
    device.installed.add("com.android.settings");
    device.system.add("com.android.settings");

    const err = await rejection(reinstall("com.android.settings"));

    expectUninstallFailure(err);
    expect((err as Error).message).toContain("DELETE_FAILED_INTERNAL_ERROR");
  });

  it("fails without installing when the package that cannot be uninstalled is hidden", async () => {
    device.installed.add("com.android.egg");
    device.system.add("com.android.egg");
    device.hidden.add("com.android.egg");

    expectUninstallFailure(await rejection(reinstall("com.android.egg")));
  });

  it("fails without installing when the uninstall only removes a system app's update", async () => {
    device.installed.add("com.android.chrome");
    device.system.add("com.android.chrome");
    device.updatedSystem.add("com.android.chrome");

    expectUninstallFailure(await rejection(reinstall("com.android.chrome")));
  });

  it("fails without installing when a failed uninstall exits 0 (before API 24)", async () => {
    device.legacy = true;
    device.installed.add("com.android.settings");
    device.system.add("com.android.settings");

    expectUninstallFailure(await rejection(reinstall("com.android.settings")));
  });

  it("fails without installing, saying the app may be gone, when the check after the uninstall fails", async () => {
    device.installed.add("com.example.app");
    device.pmFails = true;

    const err = await rejection(reinstall("com.example.app"));

    expect(getFailureSignal(err)).toMatchObject({
      error_code: "ANDROID_REINSTALL_UNINSTALL_FAILED",
      failure_stage: "android_reinstall_check_uninstall",
      error_kind: "subprocess",
      failure_command: "adb",
      failure_exit_code: 1,
    });
    expect((err as Error).message).toContain("the app may be gone");
    expect(ran("install")).toEqual([]);
  });

  it("fails with a timeout, without installing, when the check after the uninstall hangs for 15 s", async () => {
    device.installed.add("com.example.app");
    device.pmHangs = true;

    const err = await rejection(reinstall("com.example.app"));

    expect(device.pmKilledAfter).toBe(15_000);
    expect(getFailureSignal(err)).toMatchObject({
      error_code: "ANDROID_REINSTALL_UNINSTALL_FAILED",
      failure_stage: "android_reinstall_check_uninstall",
      error_kind: "timeout",
      failure_signal: "SIGKILL",
    });
    expect((err as Error).message).toContain("the app may be gone");
    expect(ran("install")).toEqual([]);
  });

  it("passes the error through when adb never ran", async () => {
    device.installed.add("com.example.app");
    device.noAdb = true;

    const err = await rejection(reinstall("com.example.app"));

    expect(getFailureSignal(err)).toMatchObject({ error_code: "ANDROID_ADB_NOT_FOUND" });
    expect((err as Error).message).not.toContain("the app may be gone");
    expect(device.calls).toEqual([]);
  });

  it("does not mistake a package whose name contains bundleId for bundleId", async () => {
    device.installed.add("com.example.app");
    device.installed.add("com.example.app.debug");

    await expect(reinstall("com.example.app")).resolves.toEqual({
      reinstalled: true,
      bundleId: "com.example.app",
    });
  });
});
