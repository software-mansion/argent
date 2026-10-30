import { adbShell, runAdb } from "./adb";

const SCREEN_SHARING_REVERSE = /\blocalabstract:(screen-sharing-agent-\d+)\b/g;

/**
 * Each phone controller start adds an `adb reverse` for its agent socket and removes
 * it on a clean exit, but a killed controller leaves it behind. A new start
 * replaces every running agent anyway, so all of them are stale by then.
 */
export async function removeScreenSharingReverses(serial: string): Promise<void> {
  const { stdout } = await runAdb(["-s", serial, "reverse", "--list"]);
  for (const [, socket] of stdout.matchAll(SCREEN_SHARING_REVERSE)) {
    await runAdb(["-s", serial, "reverse", "--remove", `localabstract:${socket}`]);
  }
}

/**
 * On an emulator, the phone controller turns auto-rotate off on its first touch
 * or `rotate` and never turns it back on.
 */
export async function readAutoRotate(serial: string): Promise<string | null> {
  const value = (await adbShell(serial, "settings get system accelerometer_rotation")).trim();
  return value === "0" || value === "1" ? value : null;
}

export async function restoreAutoRotate(serial: string, value: string): Promise<void> {
  if ((await readAutoRotate(serial)) === value) return;
  await adbShell(serial, `settings put system accelerometer_rotation ${value}`);
}
