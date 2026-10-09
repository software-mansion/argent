import { describe, it, expect, vi, beforeEach } from "vitest";

// Stubbed below the real runAdb, so the handler's choice of adb helper (and
// which of adb's streams it reads) is what these tests exercise.
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
      callback(null, execFileMock(cmd, args));
    },
  };
});

vi.mock("../src/utils/android-binary", () => ({
  resolveAndroidBinary: vi.fn(async (name: "adb" | "emulator") => name),
  __resetAndroidBinaryCacheForTesting: () => {},
}));

import type { DeviceInfo } from "@argent/registry";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import { androidImpl } from "../src/tools/open-url/platforms/android";

const SERIAL = "emulator-5554";
const device = { id: SERIAL, platform: "android", kind: "emulator" } as DeviceInfo;

// Verbatim `adb shell am start -a android.intent.action.VIEW -d <url>` output
// from an API 34 emulator. adb exits 0 in every case.
const UNRESOLVED = {
  stdout: "Starting: Intent { act=android.intent.action.VIEW dat=nosuchscheme://x/... }\n",
  stderr:
    "Error: Activity not started, unable to resolve Intent { act=android.intent.action.VIEW dat=nosuchscheme://x/... flg=0x10000000 }\n",
};
const OPENED_DENIED_HOST = {
  stdout:
    "Starting: Intent { act=android.intent.action.VIEW dat=https://denied.example.com/... }\n",
  stderr: "",
};

function openUrl(url: string) {
  return androidImpl.handler({}, { udid: SERIAL, url }, device);
}

beforeEach(() => {
  execFileMock.mockReset();
});

describe("open-url on Android judges am start by both of adb's streams", () => {
  it("fails when no activity resolves the URL, which am start reports only on stderr", async () => {
    execFileMock.mockReturnValue(UNRESOLVED);

    const err = await openUrl("nosuchscheme://x").then(
      () => null,
      (e: unknown) => e
    );

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.ANDROID_OPEN_URL_FAILED);
    expect((err as Error).message).toBe(
      "open-url failed: Error: Activity not started, unable to resolve Intent { act=android.intent.action.VIEW dat=nosuchscheme://x/... flg=0x10000000 }"
    );
  });

  it("fails when an old device's shell merges the error into stdout", async () => {
    execFileMock.mockReturnValue({ stdout: UNRESOLVED.stdout + UNRESOLVED.stderr, stderr: "" });

    await expect(openUrl("nosuchscheme://x")).rejects.toThrow(/unable to resolve Intent/);
  });

  it("succeeds for a URL that names a failure word, since only am's verdict is matched", async () => {
    execFileMock.mockReturnValue(OPENED_DENIED_HOST);

    await expect(openUrl("https://denied.example.com/x")).resolves.toMatchObject({
      opened: true,
      url: "https://denied.example.com/x",
    });
  });

  it("succeeds when the intent was delivered to the running top activity", async () => {
    execFileMock.mockReturnValue({
      stdout: "Starting: Intent { act=android.intent.action.VIEW dat=myapp://home/... }\n",
      stderr:
        "Warning: Activity not started, intent has been delivered to currently running top-most instance.\n",
    });

    await expect(openUrl("myapp://home")).resolves.toMatchObject({ opened: true });
  });

  it("passes the URL single-quoted for the device shell", async () => {
    execFileMock.mockReturnValue({
      stdout: "Starting: Intent { act=android.intent.action.VIEW dat=https://x.test/... }\n",
      stderr: "",
    });

    await openUrl("https://x.test/?a=1&b='2'");

    expect(execFileMock).toHaveBeenCalledWith("adb", [
      "-s",
      SERIAL,
      "shell",
      `am start -a android.intent.action.VIEW -d 'https://x.test/?a=1&b='\\''2'\\'''`,
    ]);
  });
});
