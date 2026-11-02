import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRotateTool } from "../src/tools/rotate";
import { UnsupportedOperationError } from "../src/utils/capability";

vi.mock("../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/adb")>()),
  isAndroidTv: vi.fn(async () => false),
}));
vi.mock("../src/utils/simulator-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/simulator-client")>()),
  sendCommand: vi.fn(async () => ({})),
}));

import { ADB_DEVICES_TIMEOUT_MS, isAndroidTv } from "../src/utils/adb";
import { sendCommand } from "../src/utils/simulator-client";

const IOS_UDID = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEFFFF0000";
const REMOTE_IOS_UDID = `remote:${IOS_UDID}`;
const ANDROID_SERIAL = "emulator-5554";

const api = { id: "simulator-server-api" };
const resolveService = vi.fn(async () => api);
const rotateTool = createRotateTool({ resolveService } as never);

beforeEach(() => {
  vi.mocked(isAndroidTv).mockClear();
  vi.mocked(sendCommand).mockClear();
  resolveService.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("rotate tool", () => {
  it("refuses an Android TV without starting a simulator-server or sending a rotate", async () => {
    vi.mocked(isAndroidTv).mockResolvedValueOnce(true);

    const run = rotateTool.execute({}, { udid: ANDROID_SERIAL, orientation: "LandscapeLeft" });
    await expect(run).rejects.toBeInstanceOf(UnsupportedOperationError);
    await expect(run).rejects.toThrow(
      "Tool 'rotate' is not supported on android emulator (Android TV has a fixed orientation)."
    );
    expect(isAndroidTv).toHaveBeenCalledWith(ANDROID_SERIAL, {
      devicesTimeoutMs: ADB_DEVICES_TIMEOUT_MS,
    });
    expect(sendCommand).not.toHaveBeenCalled();
    expect(resolveService).not.toHaveBeenCalled();
    expect(rotateTool.services({ udid: ANDROID_SERIAL, orientation: "LandscapeLeft" })).toEqual({});
  });

  it("rotates when the TV probe fails", async () => {
    vi.mocked(isAndroidTv).mockRejectedValueOnce(new Error("adb devices failed"));

    await expect(
      rotateTool.execute({}, { udid: ANDROID_SERIAL, orientation: "LandscapeLeft" })
    ).resolves.toEqual({ orientation: "LandscapeLeft" });
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });

  it("refuses an Android TV whose probe answers only after 10 s", async () => {
    vi.useFakeTimers();
    vi.mocked(isAndroidTv).mockReturnValueOnce(
      new Promise((resolve) => setTimeout(() => resolve(true), 10_000))
    );

    const run = rotateTool.execute({}, { udid: ANDROID_SERIAL, orientation: "LandscapeLeft" });
    const settled = expect(run).rejects.toBeInstanceOf(UnsupportedOperationError);
    await vi.advanceTimersByTimeAsync(10_000);
    await settled;
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("rotates an Android phone", async () => {
    await expect(
      rotateTool.execute({}, { udid: ANDROID_SERIAL, orientation: "LandscapeLeft" })
    ).resolves.toEqual({ orientation: "LandscapeLeft" });
    expect(resolveService).toHaveBeenCalledTimes(1);
    expect(sendCommand).toHaveBeenCalledWith(api, { cmd: "rotate", direction: "LandscapeLeft" });
  });

  it.each([IOS_UDID, REMOTE_IOS_UDID])("rotates %s without probing adb", async (udid) => {
    await expect(rotateTool.execute({}, { udid, orientation: "Portrait" })).resolves.toEqual({
      orientation: "Portrait",
    });
    expect(isAndroidTv).not.toHaveBeenCalled();
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });
});
