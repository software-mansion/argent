import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolve as resolvePath } from "node:path";

const execFileMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (
      cmd: string,
      args: readonly string[],
      opts: unknown,
      cb?: (err: Error | null, out: { stdout: string; stderr: string }) => void
    ) => {
      const callback = typeof opts === "function" ? opts : cb!;
      const options = typeof opts === "function" ? undefined : opts;
      const result = execFileMock(cmd, args, options);
      if (result instanceof Error) callback(result, { stdout: "", stderr: "" });
      else callback(null, result ?? { stdout: "", stderr: "" });
    },
  };
});

import { reinstallAppTool } from "../src/tools/simulator/reinstall-app";

const iosUdid = "11111111-2222-3333-4444-555555555555";
const androidSerial = "emulator-5554";

beforeEach(() => {
  execFileMock.mockReset().mockReturnValue({ stdout: "", stderr: "" });
});

describe("reinstall-app — iOS path (unchanged semantics)", () => {
  it("uninstalls then installs — order matters so the app data is wiped", async () => {
    await reinstallAppTool.execute!(
      {},
      { udid: iosUdid, bundleId: "com.example.MyApp", appPath: "/abs/MyApp.app" }
    );
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(execFileMock.mock.calls[0]![0]).toBe("xcrun");
    expect(execFileMock.mock.calls[0]![1]).toEqual([
      "simctl",
      "uninstall",
      iosUdid,
      "com.example.MyApp",
    ]);
    expect(execFileMock.mock.calls[1]![1]).toEqual([
      "simctl",
      "install",
      iosUdid,
      "/abs/MyApp.app",
    ]);
  });

  it("keeps going when uninstall fails — first-install scenario must not error", async () => {
    let call = 0;
    execFileMock.mockImplementation(() => {
      call += 1;
      if (call === 1) return new Error("simctl uninstall: app not installed");
      return { stdout: "", stderr: "" };
    });

    const result = await reinstallAppTool.execute!(
      {},
      { udid: iosUdid, bundleId: "com.new.App", appPath: "/abs/NewApp.app" }
    );
    expect(result).toEqual({ reinstalled: true, bundleId: "com.new.App" });
    expect(execFileMock).toHaveBeenCalledTimes(2); // uninstall+install still both attempted
  });

  it("resolves relative iOS paths to absolute before handing them to simctl", async () => {
    // This was added because Android's `adb install` needs an absolute path —
    // we apply `resolvePath` outside the platform branch. Semantically iOS is
    // unchanged because execFile already inherits `process.cwd()`, but the
    // argument simctl sees is now the absolute form. Regressing this to a
    // relative path would be fine for iOS but break Android, so we pin it.
    await reinstallAppTool.execute!(
      {},
      { udid: iosUdid, bundleId: "com.example.MyApp", appPath: "./build/MyApp.app" }
    );
    const installCall = execFileMock.mock.calls[1]![1] as string[];
    expect(installCall[3]).toBe(resolvePath("./build/MyApp.app"));
    expect(installCall[3]!.startsWith("/")).toBe(true);
  });

  it("ignores Android-only options — `grantPermissions` and `allowDowngrade` must not leak into simctl", async () => {
    await reinstallAppTool.execute!(
      {},
      {
        udid: iosUdid,
        bundleId: "com.example.MyApp",
        appPath: "/abs/MyApp.app",
        grantPermissions: true,
        allowDowngrade: true,
      }
    );
    const installArgs = execFileMock.mock.calls[1]![1] as string[];
    expect(installArgs).toEqual(["simctl", "install", iosUdid, "/abs/MyApp.app"]);
    expect(installArgs).not.toContain("-g");
    expect(installArgs).not.toContain("-d");
  });
});

describe("reinstall-app — Android path", () => {
  it("runs `adb -s <serial> install -r <absolute-apk>` and reports success", async () => {
    execFileMock.mockReturnValue({ stdout: "Success\n", stderr: "" });

    const result = await reinstallAppTool.execute!(
      {},
      { udid: androidSerial, bundleId: "com.example.app", appPath: "/abs/app.apk" }
    );

    expect(result).toEqual({ reinstalled: true, bundleId: "com.example.app" });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledWith(
      "adb",
      ["-s", androidSerial, "install", "-r", "/abs/app.apk"],
      expect.any(Object)
    );
    // Specifically no xcrun — iOS tooling would fail fast on a non-UUID udid.
    expect(execFileMock).not.toHaveBeenCalledWith("xcrun", expect.anything(), expect.anything());
  });

  it("appends `-g` when grantPermissions is set (runtime perms auto-granted)", async () => {
    execFileMock.mockReturnValue({ stdout: "Success\n", stderr: "" });
    await reinstallAppTool.execute!(
      {},
      {
        udid: androidSerial,
        bundleId: "com.example.app",
        appPath: "/abs/app.apk",
        grantPermissions: true,
      }
    );
    expect(execFileMock.mock.calls[0]![1]).toEqual([
      "-s",
      androidSerial,
      "install",
      "-r",
      "-g",
      "/abs/app.apk",
    ]);
  });

  it("appends `-d` when allowDowngrade is set", async () => {
    execFileMock.mockReturnValue({ stdout: "Success\n", stderr: "" });
    await reinstallAppTool.execute!(
      {},
      {
        udid: androidSerial,
        bundleId: "com.example.app",
        appPath: "/abs/app.apk",
        allowDowngrade: true,
      }
    );
    expect(execFileMock.mock.calls[0]![1]).toEqual([
      "-s",
      androidSerial,
      "install",
      "-r",
      "-d",
      "/abs/app.apk",
    ]);
  });

  it("orders flags as -d then -g when both are set (matches adb's expected order)", async () => {
    execFileMock.mockReturnValue({ stdout: "Success\n", stderr: "" });
    await reinstallAppTool.execute!(
      {},
      {
        udid: androidSerial,
        bundleId: "com.example.app",
        appPath: "/abs/app.apk",
        grantPermissions: true,
        allowDowngrade: true,
      }
    );
    const args = execFileMock.mock.calls[0]![1] as string[];
    const dIdx = args.indexOf("-d");
    const gIdx = args.indexOf("-g");
    expect(dIdx).toBeGreaterThan(-1);
    expect(gIdx).toBeGreaterThan(-1);
    expect(dIdx).toBeLessThan(gIdx);
  });

  it("throws when the install output does not contain `Success`", async () => {
    execFileMock.mockReturnValue({
      stdout: "Failure [INSTALL_FAILED_VERSION_DOWNGRADE]",
      stderr: "",
    });
    await expect(
      reinstallAppTool.execute!(
        {},
        { udid: androidSerial, bundleId: "com.example.app", appPath: "/abs/app.apk" }
      )
    ).rejects.toThrow(/adb install failed/);
  });
});
