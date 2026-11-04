// The helper's `setText` RPC as the blueprint exposes it: the request it sends,
// the verdict it passes on, and the failure when the installed helper predates
// the RPC.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FAILURE_CODES, FailureError, type DeviceInfo } from "@argent/registry";

class FakeProc extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => true);
}

// `am instrument` exits once the helper has answered `shutdown`.
let lastProc: FakeProc | undefined;

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: () => {
      const proc = new FakeProc();
      lastProc = proc;
      setImmediate(() => proc.stdout.write("INSTRUMENTATION_STATUS: port=41000\n"));
      return proc;
    },
  };
});

vi.mock("../../src/utils/adb", () => ({
  runAdb: vi.fn(async (args: string[]) =>
    args.includes("forward") ? { stdout: "45678\n", stderr: "" } : { stdout: "", stderr: "" }
  ),
  adbShell: vi.fn(async () => "package:com.argent.androiddevtools versionCode:3\n"),
}));

vi.mock("../../src/utils/android-binary", () => ({
  resolveAndroidBinary: vi.fn(async () => "/usr/bin/adb"),
}));

vi.mock("@argent/native-devtools-android", () => ({
  helperManifest: () => ({
    packageName: "com.argent.androiddevtools",
    instrumentationRunner: "com.argent.androiddevtools/.SnapshotInstrumentation",
    versionName: "0.3.0",
    versionCode: 3,
    installFlags: ["-r", "-t"],
  }),
  bundledHelperApkPath: () => "/tmp/argent-android-devtools.apk",
}));

let answerSetText: (params: Record<string, unknown>) => Promise<unknown> = async () => ({});
const requests: Array<{ method: string; params?: Record<string, unknown> }> = [];

vi.mock("../../src/utils/android-devtools-client", () => ({
  connectAndroidDevtoolsClient: vi.fn(async () => ({
    request: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      requests.push({ method, params });
      if (method === "setText") return answerSetText(params ?? {});
      if (method === "shutdown") {
        const proc = lastProc;
        setImmediate(() => proc?.emit("exit", 0, null));
      }
      return { ok: true };
    }),
    close: vi.fn(),
  })),
}));

import { androidDevtoolsBlueprint } from "../../src/blueprints/android-devtools";

const DEVICE: DeviceInfo = { id: "emulator-5554", platform: "android", kind: "emulator" };

const disposers: Array<() => Promise<void>> = [];

async function start() {
  const instance = await androidDevtoolsBlueprint.factory({}, DEVICE, { device: DEVICE });
  disposers.push(instance.dispose);
  return instance.api;
}

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
  requests.length = 0;
});

describe("android-devtools setText", () => {
  it("sends the text and answers the helper's verdict", async () => {
    answerSetText = async () => ({
      setTextVersion: 1,
      focused: true,
      performed: true,
      verified: true,
      password: false,
    });
    const api = await start();
    expect(await api.setText("text")).toEqual({
      focused: true,
      performed: true,
      verified: true,
      password: false,
    });
    expect(requests.at(-1)).toEqual({ method: "setText", params: { text: "text" } });
  });

  it("sends check only when asked", async () => {
    answerSetText = async () => ({ focused: true, verified: false });
    const api = await start();
    expect(await api.setText("", { check: true })).toEqual({
      focused: true,
      verified: false,
    });
    expect(requests.at(-1)).toEqual({ method: "setText", params: { text: "", check: true } });
  });

  it("answers focused: false when nothing editable has focus", async () => {
    answerSetText = async () => ({ focused: false });
    const api = await start();
    expect(await api.setText("x")).toEqual({ focused: false, verified: false });
  });

  it("fails, saying to update argent, on a helper that predates the RPC", async () => {
    answerSetText = async () => {
      throw new FailureError("java.lang.IllegalArgumentException: Unknown method: setText", {
        error_code: FAILURE_CODES.ANDROID_DEVTOOLS_RPC_ERROR,
        failure_stage: "android_devtools_rpc_response",
        failure_area: "tool_server",
        error_kind: "subprocess",
      });
    };
    const api = await start();
    await expect(api.setText("x")).rejects.toThrow(/predates `setText`; update argent/);
  });

  it.each([
    [
      "the RPC timed out",
      () =>
        new FailureError("AndroidDevtools RPC setText timed out after 14000ms", {
          error_code: FAILURE_CODES.ANDROID_DEVTOOLS_RPC_TIMEOUT,
          failure_stage: "android_devtools_rpc_request",
          failure_area: "tool_server",
          error_kind: "timeout",
        }),
    ],
    [
      "the helper's worker timed out",
      () =>
        new FailureError(
          "com.argent.androiddevtools.SnapshotInstrumentation$HelperTimeoutException: Helper worker timed out after 12000 ms for method: setText",
          {
            error_code: FAILURE_CODES.ANDROID_DEVTOOLS_RPC_ERROR,
            failure_stage: "android_devtools_rpc_response",
            failure_area: "tool_server",
            error_kind: "subprocess",
          }
        ),
    ],
  ])("answers timedOut when %s", async (_name, error) => {
    answerSetText = async () => {
      throw error();
    };
    const api = await start();
    expect(await api.setText("x")).toEqual({ focused: true, verified: false, timedOut: true });
  });

  it("passes singleLine on", async () => {
    answerSetText = async () => ({ focused: true, singleLine: true, verified: false });
    const api = await start();
    expect(await api.setText("a\nb")).toEqual({
      focused: true,
      verified: false,
      singleLine: true,
    });
  });

  it("fails on any other helper error", async () => {
    answerSetText = async () => {
      throw new Error("java.lang.IllegalStateException: UiAutomation not connected");
    };
    const api = await start();
    await expect(api.setText("x")).rejects.toThrow(/not connected/);
  });
});
