import { describe, it, expect, vi, beforeEach } from "vitest";

// One ordered log for both calls: the reverse only helps if it is in place
// before the process starts, so ordering is the property under test, not the
// mere fact that it ran.
const calls: string[] = [];

vi.mock("../src/utils/adb", async (importActual) => {
  const actual = await importActual<typeof import("../src/utils/adb")>();
  return {
    ...actual,
    ensureMetroReverse: vi.fn(async (serial: string) => {
      calls.push(`reverse ${serial}`);
      return 8081;
    }),
    adbShell: vi.fn(async (_s: string, cmd: string) => {
      calls.push(cmd);
      return "Status: ok\n";
    }),
  };
});

import { androidImpl as launchAndroid } from "../src/tools/launch-app/platforms/android";
import { androidImpl as restartAndroid } from "../src/tools/restart-app/platforms/android";

const UDID = "emulator-5554";
const B = "com.example.app";

beforeEach(() => {
  calls.length = 0;
});

describe("android launch asserts the Metro reverse before the app starts", () => {
  it("launch-app reverses before `am start`", async () => {
    await launchAndroid.handler(
      {} as never,
      { udid: UDID, bundleId: B, activity: ".MainActivity" },
      {} as never
    );
    const reverseAt = calls.indexOf(`reverse ${UDID}`);
    const startAt = calls.findIndex((c) => c.includes("am start"));
    expect(reverseAt).toBeGreaterThanOrEqual(0);
    expect(startAt).toBeGreaterThanOrEqual(0);
    expect(reverseAt).toBeLessThan(startAt);
  });

  it("restart-app reverses before it stops the old process", async () => {
    await restartAndroid.handler(
      {} as never,
      { udid: UDID, bundleId: B, activity: ".MainActivity" },
      {} as never
    );
    const reverseAt = calls.indexOf(`reverse ${UDID}`);
    const stopAt = calls.findIndex((c) => c.includes("am force-stop"));
    const startAt = calls.findIndex((c) => c.includes("am start"));
    expect(reverseAt).toBeGreaterThanOrEqual(0);
    expect(reverseAt).toBeLessThan(stopAt);
    expect(stopAt).toBeLessThan(startAt);
  });

  it("passes the target serial through, not a default", async () => {
    await launchAndroid.handler(
      {} as never,
      { udid: "192.168.1.7:5555", bundleId: B, activity: ".MainActivity" },
      {} as never
    );
    expect(calls).toContain("reverse 192.168.1.7:5555");
  });
});
