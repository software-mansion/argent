import { runAdb } from "./adb";
import { discoverVegaConsolePort } from "./vega-qmp";

/**
 * Helpers for the Vega (Fire TV) on-device **automation toolkit** — the same
 * accessibility/introspection server Amazon's Appium Vega driver uses.
 *
 * The toolkit listens on device TCP port 8383 but is DISABLED by default: it
 * only serves once the flag file `/tmp/automation-toolkit.enable` exists on the
 * device, and that flag is read at *app launch*. So the app-lifecycle tools
 * (`launch-app` / `restart-app`) call `ensureAutomationToolkitEnabled` before
 * launching, and the tree appears for argent-launched apps.
 *
 * The actual `getPageSource` fetch now goes through the on-device agent
 * (`vega-transport` → keep-alive HTTP, ~3ms), which proxies port 8383
 * in-process. This module only derives the emulator serial and sets the enable
 * flag; it no longer talks JSON-RPC to the toolkit directly.
 */

const TOOLKIT_ENABLE_FLAG = "/tmp/automation-toolkit.enable";

// The VVD CLI targets the single connected device, and so does adb's emulator
// console; we derive the emulator serial the same way the screenshot path does.
// `serial` (the Vega udid) is accepted for interface symmetry / future
// multi-device support but the console port is authoritative today.
export async function emulatorSerial(): Promise<{ serial: string; consolePort: number }> {
  const consolePort = await discoverVegaConsolePort();
  return { serial: `emulator-${consolePort}`, consolePort };
}

/**
 * Idempotently create the toolkit enable flag on the device. The flag is read at
 * app launch, so callers wanting an already-running app introspectable must
 * relaunch it afterwards.
 */
export async function ensureAutomationToolkitEnabled(_serial: string): Promise<void> {
  const { serial } = await emulatorSerial();
  await runAdb(["-s", serial, "shell", "touch", TOOLKIT_ENABLE_FLAG], { timeoutMs: 15_000 });
}
