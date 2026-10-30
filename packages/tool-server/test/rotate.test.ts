import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rotateTool } from "../src/tools/rotate";
import { ANDROID_TV_PROBE_BUDGET_MS } from "../src/tools/screenshot";
import { UnsupportedOperationError } from "../src/utils/capability";

vi.mock("../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/adb")>()),
  isAndroidTv: vi.fn(async () => false),
}));
vi.mock("../src/utils/simulator-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/simulator-client")>()),
  sendCommand: vi.fn(async () => ({})),
}));

import { isAndroidTv } from "../src/utils/adb";
import { sendCommand } from "../src/utils/simulator-client";

const IOS_UDID = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEFFFF0000";
const REMOTE_IOS_UDID = `remote:${IOS_UDID}`;
const ANDROID_SERIAL = "emulator-5554";

beforeEach(() => {
  vi.mocked(isAndroidTv).mockClear();
  vi.mocked(sendCommand).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("rotate tool", () => {
  it("refuses an Android TV without sending a rotate", async () => {
    vi.mocked(isAndroidTv).mockResolvedValueOnce(true);

    const run = rotateTool.execute(
      { simulatorServer: {} },
      { udid: ANDROID_SERIAL, orientation: "LandscapeLeft" }
    );
    await expect(run).rejects.toBeInstanceOf(UnsupportedOperationError);
    await expect(run).rejects.toThrow(
      "Tool 'rotate' is not supported on android emulator (Android TV has a fixed orientation)."
    );
    expect(isAndroidTv).toHaveBeenCalledWith(ANDROID_SERIAL);
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("rotates when the TV probe fails", async () => {
    vi.mocked(isAndroidTv).mockRejectedValueOnce(new Error("adb devices failed"));

    await expect(
      rotateTool.execute(
        { simulatorServer: {} },
        { udid: ANDROID_SERIAL, orientation: "LandscapeLeft" }
      )
    ).resolves.toEqual({ orientation: "LandscapeLeft" });
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });

  it("rotates once the TV probe overruns its budget", async () => {
    vi.useFakeTimers();
    vi.mocked(isAndroidTv).mockReturnValueOnce(new Promise(() => {}));

    const run = rotateTool.execute(
      { simulatorServer: {} },
      { udid: ANDROID_SERIAL, orientation: "LandscapeLeft" }
    );
    await vi.advanceTimersByTimeAsync(ANDROID_TV_PROBE_BUDGET_MS - 1);
    expect(sendCommand).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(run).resolves.toEqual({ orientation: "LandscapeLeft" });
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });

  it("rotates an Android phone and leaves no probe timer behind", async () => {
    vi.useFakeTimers();

    await expect(
      rotateTool.execute(
        { simulatorServer: {} },
        { udid: ANDROID_SERIAL, orientation: "LandscapeLeft" }
      )
    ).resolves.toEqual({ orientation: "LandscapeLeft" });
    expect(sendCommand).toHaveBeenCalledWith({}, { cmd: "rotate", direction: "LandscapeLeft" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([IOS_UDID, REMOTE_IOS_UDID])("rotates %s without probing adb", async (udid) => {
    await expect(
      rotateTool.execute({ simulatorServer: {} }, { udid, orientation: "Portrait" })
    ).resolves.toEqual({ orientation: "Portrait" });
    expect(isAndroidTv).not.toHaveBeenCalled();
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });
});
