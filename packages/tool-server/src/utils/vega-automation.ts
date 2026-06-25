import { runAdb } from "./adb";
import { discoverVegaConsolePort } from "./vega-vvd";

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
 * The actual `getPageSource` JSON-RPC fetch lives in `vega-inspect.ts`, which
 * `adb forward`s to port 8383 and talks to the toolkit directly. This module
 * derives the emulator serial (shared by the input/inspect paths) and sets the
 * enable flag.
 */

const TOOLKIT_ENABLE_FLAG = "/tmp/automation-toolkit.enable";

// adb's emulator console targets the single running VVD; we derive that serial
// from its console port the same way the screenshot path does. There is no
// `serial` argument because there is no per-device target to pass: v1 supports
// exactly one VVD and `discoverVegaConsolePort` errors if more than one is
// present, so the resolved `emulator-<port>` is unambiguous.
export async function emulatorSerial(): Promise<{ serial: string; consolePort: number }> {
  const consolePort = await discoverVegaConsolePort();
  return { serial: `emulator-${consolePort}`, consolePort };
}

/**
 * Idempotently create the toolkit enable flag on the device. The flag is read at
 * app launch, so callers wanting an already-running app introspectable must
 * relaunch it afterwards.
 *
 * `_serial` (the caller's Vega udid) is accepted for call-site symmetry with the
 * iOS/Android lifecycle tools but not used: the target is the single running VVD
 * resolved by `emulatorSerial` (see above), not a per-device serial.
 */
export async function ensureAutomationToolkitEnabled(_serial: string): Promise<void> {
  const { serial } = await emulatorSerial();
  await runAdb(["-s", serial, "shell", "touch", TOOLKIT_ENABLE_FLAG], { timeoutMs: 15_000 });
}
