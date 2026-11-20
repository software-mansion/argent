import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every adb call answers like a successful `am start -W`, and each is logged so
// a test can tell whether the attach ran after the app started.
const shellCalls: string[] = [];
vi.mock("../src/utils/adb", async (importActual) => {
  const actual = await importActual<typeof import("../src/utils/adb")>();
  return {
    ...actual,
    adbShell: vi.fn(async (_serial: string, cmd: string) => {
      shellCalls.push(cmd);
      return "Status: ok\n";
    }),
  };
});

// Shell calls made before the attach ran, per call.
const shellCallsAtAttach: string[][] = [];
const attach = vi.fn<(deviceId: string, packageName: string) => Promise<string | undefined>>();
vi.mock("../src/blueprints/android-network-inspector", async (importActual) => ({
  ...(await importActual<typeof import("../src/blueprints/android-network-inspector")>()),
  attachAndroidNetworkInspectorToLaunch: (deviceId: string, packageName: string) => {
    shellCallsAtAttach.push([...shellCalls]);
    return attach(deviceId, packageName);
  },
}));

import { androidImpl as launchAndroid } from "../src/tools/launch-app/platforms/android";
import { androidImpl as restartAndroid } from "../src/tools/restart-app/platforms/android";

const SERIAL = "emulator-5554";
const PKG = "com.example.networktest";
const NOTE = "native network capture is attached to com.example.networktest";

const tools = [
  {
    name: "launch-app",
    run: () =>
      launchAndroid.handler(
        {} as never,
        { udid: SERIAL, bundleId: PKG, activity: ".MainActivity" },
        {} as never
      ),
    ok: { launched: true, bundleId: PKG },
  },
  {
    name: "restart-app",
    run: () =>
      restartAndroid.handler(
        {} as never,
        { udid: SERIAL, bundleId: PKG, activity: ".MainActivity" },
        {} as never
      ),
    ok: { restarted: true, bundleId: PKG },
  },
] as const;

let stderr: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  shellCalls.length = 0;
  shellCallsAtAttach.length = 0;
  attach.mockReset();
  stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  stderr.mockRestore();
});

describe.each(tools)("$name on Android follows native network capture", ({ run, ok }) => {
  it("attaches capture to the launched app after it started and returns the note", async () => {
    attach.mockResolvedValue(NOTE);

    const result = await run();

    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledWith(SERIAL, PKG);
    expect(shellCallsAtAttach[0]!.some((cmd) => cmd.includes("am start -W"))).toBe(true);
    expect(result).toEqual({ ...ok, networkCapture: NOTE });
  });

  it("returns no networkCapture field when capture is not live for the app", async () => {
    attach.mockResolvedValue(undefined);

    const result = await run();

    expect(attach).toHaveBeenCalledTimes(1);
    expect(result).toEqual(ok);
    expect(result).not.toHaveProperty("networkCapture");
  });

  it("still succeeds when the attach rejects", async () => {
    attach.mockRejectedValue(new Error("adb went away"));

    const result = await run();

    expect(result).toEqual(ok);
    expect(String(stderr.mock.calls.at(-1)?.[0])).toContain("adb went away");
  });

  it("still succeeds when the attach throws before it returns a promise", async () => {
    attach.mockImplementation(() => {
      throw new Error("synchronous failure");
    });

    const result = await run();

    expect(result).toEqual(ok);
    expect(String(stderr.mock.calls.at(-1)?.[0])).toContain("synchronous failure");
  });
});
