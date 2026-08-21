import { describe, expect, it, vi, beforeEach } from "vitest";
import { isFlagEnabled } from "@argent/configuration-core";
import { InvalidToolInputError } from "../src/utils/capability";
import { resolveDevice } from "../src/utils/device-info";

// The physical-iOS operations that shell `devicectl` instead of going through a
// CoreDevice service — `launch-app` is covered in physical-ios-followups.test.ts,
// and physical-ios-capability-sweep.test.ts derives the whole set to check none
// of them can skip the opt-in gate. Isolated in their own file so the
// `node:child_process` mock can't reach the suites that run the real binary.
const execCalls: string[][] = [];
let execResult: () => Promise<{ stdout: string; stderr: string }> = () =>
  Promise.resolve({ stdout: "", stderr: "" });

vi.mock("node:child_process", () => ({
  execFile: Object.assign(() => undefined, {
    [Symbol.for("nodejs.util.promisify.custom")]: (file: string, args: string[]) => {
      execCalls.push([file, ...args]);
      return execResult();
    },
  }),
}));

vi.mock("@argent/configuration-core", () => ({ isFlagEnabled: vi.fn() }));

// Static imports are safe despite the mocks above: vitest hoists `vi.mock` calls
// above every import in the file, so both modules see the mocked
// `node:child_process`. (A top-level `await import` would also work at runtime
// but does not typecheck under the test tsconfig's module setting.)
import { iosImpl as openUrlIos } from "../src/tools/open-url/platforms/ios";
import { iosImpl as reinstallIos } from "../src/tools/reinstall-app/platforms/ios";
import { makeIosImpl as makeRestartAppIosImpl } from "../src/tools/restart-app/platforms/ios";

const PHYSICAL_UDID = "00008120-000E6D0C0ABBA01E";
const device = resolveDevice(PHYSICAL_UDID);
const restartIos = makeRestartAppIosImpl({} as never);
const mockFlag = vi.mocked(isFlagEnabled);

beforeEach(() => {
  execCalls.length = 0;
  execResult = () => Promise.resolve({ stdout: "", stderr: "" });
  mockFlag.mockReturnValue(true);
});

describe("open-url on a physical iPhone", () => {
  it("opens the URL through devicectl", async () => {
    const result = await openUrlIos.handler(
      {} as never,
      { udid: PHYSICAL_UDID, url: "https://example.com" } as never,
      device
    );

    expect(execCalls).toEqual([
      [
        "xcrun",
        "devicectl",
        "device",
        "process",
        "openURL",
        "--device",
        PHYSICAL_UDID,
        "https://example.com",
      ],
    ]);
    expect(result.opened).toBe(true);
    expect(result.url).toBe("https://example.com");
  });

  it("never reaches simctl, which cannot address hardware", async () => {
    await openUrlIos.handler(
      {} as never,
      { udid: PHYSICAL_UDID, url: "myapp://x" } as never,
      device
    );
    expect(execCalls.flat()).not.toContain("simctl");
  });

  it("is refused while the physical-iOS flag is off", async () => {
    mockFlag.mockReturnValue(false);
    await expect(
      openUrlIos.handler({} as never, { udid: PHYSICAL_UDID, url: "https://x" } as never, device)
    ).rejects.toBeInstanceOf(InvalidToolInputError);
    // The gate has to run before the subprocess, not after it.
    expect(execCalls).toEqual([]);
  });
});

describe("restart-app on a physical iPhone", () => {
  it("relaunches through devicectl, terminating the running instance first", async () => {
    const result = await restartIos.handler(
      {} as never,
      { udid: PHYSICAL_UDID, bundleId: "com.example.app" } as never,
      device
    );

    expect(execCalls).toEqual([
      [
        "xcrun",
        "devicectl",
        "device",
        "process",
        "launch",
        "--terminate-existing",
        "--device",
        PHYSICAL_UDID,
        "com.example.app",
      ],
    ]);
    // toMatchObject, not property access: the declared result type is a union
    // with the native-devtools init-failure shape, which has neither field.
    expect(result).toMatchObject({ restarted: true, bundleId: "com.example.app" });
  });

  it("reports a devicectl failure rather than claiming a restart", async () => {
    execResult = () => Promise.reject(new Error("app not installed"));
    await expect(
      restartIos.handler(
        {} as never,
        { udid: PHYSICAL_UDID, bundleId: "com.example.app" } as never,
        device
      )
    ).rejects.toThrow(/Failed to restart com\.example\.app/);
  });

  it("is refused while the physical-iOS flag is off", async () => {
    mockFlag.mockReturnValue(false);
    await expect(
      restartIos.handler({} as never, { udid: PHYSICAL_UDID, bundleId: "com.x" } as never, device)
    ).rejects.toBeInstanceOf(InvalidToolInputError);
    expect(execCalls).toEqual([]);
  });
});

describe("reinstall-app on a physical iPhone", () => {
  const params = {
    udid: PHYSICAL_UDID,
    bundleId: "com.example.app",
    appPath: "/tmp/build/MyApp.app",
  };

  it("uninstalls then installs through devicectl", async () => {
    const result = await reinstallIos.handler({} as never, params as never, device);

    expect(execCalls).toEqual([
      [
        "xcrun",
        "devicectl",
        "device",
        "uninstall",
        "app",
        "--device",
        PHYSICAL_UDID,
        "com.example.app",
      ],
      [
        "xcrun",
        "devicectl",
        "device",
        "install",
        "app",
        "--device",
        PHYSICAL_UDID,
        "/tmp/build/MyApp.app",
      ],
    ]);
    expect(result).toMatchObject({ reinstalled: true, bundleId: "com.example.app" });
  });

  it("installs anyway when the app was not previously installed", async () => {
    // devicectl exits non-zero when uninstalling something absent; that is the
    // ordinary first-install case, not a failure, so the install must still run.
    let call = 0;
    execResult = () => {
      call += 1;
      return call === 1
        ? Promise.reject(new Error("no such app"))
        : Promise.resolve({ stdout: "", stderr: "" });
    };

    const result = await reinstallIos.handler({} as never, params as never, device);

    expect(execCalls).toHaveLength(2);
    expect(execCalls[1]).toContain("install");
    expect(result).toMatchObject({ reinstalled: true });
  });

  it("reports an install failure rather than claiming a reinstall", async () => {
    let call = 0;
    execResult = () => {
      call += 1;
      return call === 1
        ? Promise.resolve({ stdout: "", stderr: "" })
        : Promise.reject(new Error("ApplicationVerificationFailed"));
    };

    await expect(reinstallIos.handler({} as never, params as never, device)).rejects.toThrow(
      /provisioning profile does not list this device/
    );
  });

  it("carries devicectl's own diagnosis, instead of asserting a signing failure", async () => {
    // `subprocessFailureMetadata` records only exit code and signal, and the
    // HTTP layer serialises `err.message`, so devicectl's own explanation
    // reaches the caller only if the message carries it. Without it a locked
    // phone reads as a signing problem, sending the caller to re-sign a bundle
    // that is fine.
    let call = 0;
    execResult = () => {
      call += 1;
      if (call === 1) return Promise.resolve({ stdout: "", stderr: "" });
      return Promise.reject(
        Object.assign(new Error("Command failed: xcrun devicectl"), {
          code: 1,
          stdout: "",
          stderr:
            "ERROR: The operation couldn't be completed. Unable to install the app.\n" +
            "  Underlying error: The device is locked. (com.apple.dt.CoreDeviceError error 3002)\n" +
            "  Recovery suggestion: Unlock the device and try again.\n",
        })
      );
    };

    const err = (await reinstallIos
      .handler({} as never, params as never, device)
      .catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/device is locked/i);
    expect(err.message).toMatch(/Unlock the device/i);
    // The signing hint stays, but as the likeliest cause rather than the verdict.
    expect(err.message).toMatch(/Most often/);
  });

  it("resolves a relative appPath before handing it to devicectl", async () => {
    await reinstallIos.handler(
      {} as never,
      { ...params, appPath: "./build/MyApp.app" } as never,
      device
    );
    expect(execCalls[1]!.at(-1)).toBe(`${process.cwd()}/build/MyApp.app`);
  });

  it("is refused while the physical-iOS flag is off", async () => {
    mockFlag.mockReturnValue(false);
    await expect(reinstallIos.handler({} as never, params as never, device)).rejects.toBeInstanceOf(
      InvalidToolInputError
    );
    expect(execCalls).toEqual([]);
  });
});
