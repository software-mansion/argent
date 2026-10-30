import { describe, expect, it, vi, beforeEach } from "vitest";

const runAdbMock = vi.fn();
const adbShellMock = vi.fn();
vi.mock("../src/utils/adb", () => ({
  runAdb: (args: string[]) => runAdbMock(args),
  adbShell: (serial: string, command: string) => adbShellMock(serial, command),
}));

import {
  readAutoRotate,
  removeScreenSharingReverses,
  restoreAutoRotate,
} from "../src/utils/android-device-controller-state";

beforeEach(() => {
  runAdbMock.mockReset();
  adbShellMock.mockReset();
});

describe("removeScreenSharingReverses", () => {
  it("removes every screen-sharing agent reverse and keeps the others", async () => {
    runAdbMock.mockResolvedValueOnce({
      stdout:
        "host-21 localabstract:screen-sharing-agent-54629 tcp:54629\n" +
        "host-21 tcp:8081 tcp:8081\n" +
        "host-21 localabstract:screen-sharing-agent-54716 tcp:54716\n",
      stderr: "",
    });
    runAdbMock.mockResolvedValue({ stdout: "", stderr: "" });

    await removeScreenSharingReverses("emulator-5554");

    expect(runAdbMock.mock.calls.map(([args]) => args)).toEqual([
      ["-s", "emulator-5554", "reverse", "--list"],
      ["-s", "emulator-5554", "reverse", "--remove", "localabstract:screen-sharing-agent-54629"],
      ["-s", "emulator-5554", "reverse", "--remove", "localabstract:screen-sharing-agent-54716"],
    ]);
  });
});

describe("auto-rotate", () => {
  it("reads the setting and ignores anything but 0 or 1", async () => {
    adbShellMock.mockResolvedValueOnce("1\n").mockResolvedValueOnce("null\n");

    expect(await readAutoRotate("emulator-5554")).toBe("1");
    expect(await readAutoRotate("emulator-5554")).toBeNull();
  });

  it("writes the setting back only when the controller changed it", async () => {
    adbShellMock.mockResolvedValueOnce("0\n").mockResolvedValueOnce("");
    await restoreAutoRotate("emulator-5554", "1");
    expect(adbShellMock).toHaveBeenLastCalledWith(
      "emulator-5554",
      "settings put system accelerometer_rotation 1"
    );

    adbShellMock.mockReset().mockResolvedValueOnce("1\n");
    await restoreAutoRotate("emulator-5554", "1");
    expect(adbShellMock.mock.calls).toEqual([
      ["emulator-5554", "settings get system accelerometer_rotation"],
    ]);
  });
});
