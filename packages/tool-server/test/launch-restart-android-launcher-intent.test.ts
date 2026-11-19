import { describe, it, expect, vi, beforeEach } from "vitest";

const shellCalls: string[] = [];
let tv = false;
vi.mock("../src/utils/adb", async (importActual) => {
  const actual = await importActual<typeof import("../src/utils/adb")>();
  return {
    ...actual,
    isAndroidTv: vi.fn(async () => tv),
    adbShell: vi.fn(async (_s: string, cmd: string) => {
      shellCalls.push(cmd);
      if (cmd.startsWith("cmd package resolve-activity")) {
        if (cmd.includes("LEANBACK_LAUNCHER")) {
          return cmd.includes("com.example.tv") ? "com.example.tv/.TvActivity\n" : "";
        }
        return "priority=0 preferredOrder=0 match=0x108000\ncom.example.app/.MainActivity\n";
      }
      return "Status: ok\n";
    }),
  };
});

import { androidImpl as launchAndroid } from "../src/tools/launch-app/platforms/android";
import { androidImpl as restartAndroid } from "../src/tools/restart-app/platforms/android";

const MAIN = "-a android.intent.action.MAIN";

function startCommand(): string | undefined {
  return shellCalls.find((c) => c.startsWith("am start"));
}

const tools = [
  ["launch-app", launchAndroid],
  ["restart-app", restartAndroid],
] as const;

describe("android launch of the resolved launcher activity", () => {
  beforeEach(() => {
    shellCalls.length = 0;
    tv = false;
  });

  for (const [name, impl] of tools) {
    it(`${name} starts a phone app's launcher activity with MAIN and LAUNCHER`, async () => {
      await impl.handler(
        {} as never,
        { udid: "emulator-5554", bundleId: "com.example.app" },
        {} as never
      );
      expect(startCommand()).toBe(
        `am start -W ${MAIN} -c 'android.intent.category.LAUNCHER' -n 'com.example.app/.MainActivity'`
      );
    });

    it(`${name} starts a TV app's leanback activity with MAIN and LEANBACK_LAUNCHER`, async () => {
      tv = true;
      await impl.handler(
        {} as never,
        { udid: "emulator-5556", bundleId: "com.example.tv" },
        {} as never
      );
      expect(startCommand()).toBe(
        `am start -W ${MAIN} -c 'android.intent.category.LEANBACK_LAUNCHER' -n 'com.example.tv/.TvActivity'`
      );
    });

    it(`${name} uses LAUNCHER on a TV when the app has no leanback activity`, async () => {
      tv = true;
      await impl.handler(
        {} as never,
        { udid: "emulator-5556", bundleId: "com.example.app" },
        {} as never
      );
      expect(startCommand()).toBe(
        `am start -W ${MAIN} -c 'android.intent.category.LAUNCHER' -n 'com.example.app/.MainActivity'`
      );
    });

    it(`${name} starts an explicit activity without an action or category`, async () => {
      await impl.handler(
        {} as never,
        { udid: "emulator-5554", bundleId: "com.example.app", activity: ".SettingsActivity" },
        {} as never
      );
      expect(startCommand()).toBe("am start -W -n 'com.example.app/.SettingsActivity'");
    });
  }
});
