import { describe, it, expect, vi, beforeEach } from "vitest";
const shellCalls: string[] = [];
vi.mock("../src/utils/adb", async (importActual) => {
  const actual = await importActual<typeof import("../src/utils/adb")>();
  return {
    ...actual,
    adbShell: vi.fn(async (_s: string, cmd: string) => {
      shellCalls.push(cmd);
      return "Status: ok\n";
    }),
  };
});
import { androidImpl as restartAndroid } from "../src/tools/restart-app/platforms/android";
import { androidImpl as launchAndroid } from "../src/tools/launch-app/platforms/android";
function startComponent(): string | undefined {
  const cmd = shellCalls.find((c) => c.includes("am start -W -n"));
  return cmd?.match(/am start -W -n '([^']+)'/)?.[1];
}
const B = "com.example.app";
const cases: Array<[string, string]> = [
  ["MainActivity", `${B}/.MainActivity`],
  [".MainActivity", `${B}/.MainActivity`],
  ["com.fully.Qualified", `${B}/com.fully.Qualified`],
  [`${B}/.X`, `${B}/.X`],
];
describe("restart-app android activity component", () => {
  beforeEach(() => {
    shellCalls.length = 0;
  });
  for (const [activity, expected] of cases) {
    it(`restart-app builds ${expected} for "${activity}"`, async () => {
      await restartAndroid.handler({} as never, { udid: "emulator-5554", bundleId: B, activity });
      expect(startComponent()).toBe(expected);
    });
    it(`restart-app matches launch-app for "${activity}"`, async () => {
      await launchAndroid.handler({} as never, { udid: "emulator-5554", bundleId: B, activity });
      const launch = startComponent();
      shellCalls.length = 0;
      await restartAndroid.handler({} as never, { udid: "emulator-5554", bundleId: B, activity });
      expect(startComponent()).toBe(launch);
    });
  }
});
