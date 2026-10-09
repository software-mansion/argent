import { describe, it, expect, vi, beforeEach } from "vitest";

// A fake device behind the real runAdb/adbShell: only execFile is stubbed, so
// the handler's whole adb conversation runs against it.
const device = {
  installed: new Set<string>(),
  undeletable: new Set<string>(),
  apkPackage: "",
  calls: [] as string[][],
};

function fakeAdb(args: readonly string[]): { stdout: string; stderr: string } | Error {
  const argv = args.slice(2); // drop `-s <serial>`
  device.calls.push(argv);
  const [command, ...rest] = argv;
  if (command === "shell") {
    const filter = /^pm list packages '(.+)'$/.exec(rest[0]!)?.[1];
    if (filter === undefined) throw new Error(`unexpected shell command: ${rest[0]}`);
    const lines = [...device.installed].filter((pkg) => pkg.includes(filter));
    return { stdout: lines.map((pkg) => `package:${pkg}\n`).join(""), stderr: "" };
  }
  if (command === "uninstall") {
    const pkg = rest[0]!;
    if (!device.installed.has(pkg) || device.undeletable.has(pkg)) {
      return Object.assign(new Error(`Command failed: adb uninstall ${pkg}`), {
        code: 1,
        stdout: "Failure [DELETE_FAILED_INTERNAL_ERROR]\n",
        stderr: "",
      });
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
      cb?: (err: Error | null, out: { stdout: string; stderr: string }) => void
    ) => {
      const callback = typeof opts === "function" ? opts : cb!;
      const result = fakeAdb(args);
      if (result instanceof Error) {
        const e = result as Error & { stdout: string; stderr: string };
        callback(e, { stdout: e.stdout, stderr: e.stderr });
      } else callback(null, result);
    },
  };
});

vi.mock("../src/utils/android-binary", () => ({
  resolveAndroidBinary: vi.fn(async (name: "adb" | "emulator") => name),
  __resetAndroidBinaryCacheForTesting: () => {},
}));

import type { DeviceInfo } from "@argent/registry";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import { androidImpl } from "../src/tools/reinstall-app/platforms/android";

const SERIAL = "emulator-5554";
const androidDevice = { id: SERIAL, platform: "android", kind: "emulator" } as DeviceInfo;
const APK = "/builds/app-debug.apk";

function reinstall(bundleId: string) {
  return androidImpl.handler({}, { udid: SERIAL, bundleId, appPath: APK }, androidDevice);
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

beforeEach(() => {
  device.installed = new Set(["com.android.settings"]);
  device.undeletable = new Set(["com.android.settings"]);
  device.apkPackage = "com.example.app";
  device.calls = [];
});

describe("reinstall-app on Android", () => {
  it("uninstalls the installed package, then installs the APK", async () => {
    device.installed.add("com.example.app");

    await expect(reinstall("com.example.app")).resolves.toEqual({
      reinstalled: true,
      bundleId: "com.example.app",
    });
    expect(ran("uninstall")).toEqual([["uninstall", "com.example.app"]]);
    expect(ran("install")).toHaveLength(1);
  });

  it("installs an app that is not installed yet", async () => {
    await expect(reinstall("com.example.app")).resolves.toEqual({
      reinstalled: true,
      bundleId: "com.example.app",
    });
    expect(device.installed.has("com.example.app")).toBe(true);
  });

  it("fails when the APK is a different package than bundleId", async () => {
    device.installed.add("com.example.app");

    const err = await rejection(reinstall("com.wrong.pkg"));

    expect(getFailureSignal(err)).toMatchObject({
      error_code: FAILURE_CODES.ANDROID_REINSTALL_INSTALL_FAILED,
      failure_stage: "android_reinstall_package_mismatch",
    });
    expect((err as Error).message).toContain("com.wrong.pkg is not on the device");
  });

  it("fails without installing when the installed package cannot be uninstalled", async () => {
    device.apkPackage = "com.android.settings";

    const err = await rejection(reinstall("com.android.settings"));

    expect(getFailureSignal(err)).toMatchObject({
      error_code: FAILURE_CODES.ANDROID_REINSTALL_INSTALL_FAILED,
      failure_stage: "android_reinstall_adb_uninstall",
    });
    expect((err as Error).message).toContain("DELETE_FAILED_INTERNAL_ERROR");
    expect(ran("install")).toEqual([]);
  });

  it("does not mistake a package whose name contains bundleId for bundleId", async () => {
    device.installed.add("com.example.app.debug");
    device.apkPackage = "com.example.app.debug";

    const err = await rejection(reinstall("com.example.app"));

    expect(getFailureSignal(err)?.failure_stage).toBe("android_reinstall_package_mismatch");
  });
});
