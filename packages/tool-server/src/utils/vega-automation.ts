import { runAdb } from "./adb";
import { discoverVegaConsolePort } from "./vega-vvd";

/**
 * Vega (Fire TV) on-device automation toolkit: an accessibility/introspection
 * server on device port 8383, disabled until the flag file
 * `/tmp/automation-toolkit.enable` exists — and that flag is read at *app
 * launch*, so `launch-app` / `restart-app` set it before launching.
 *
 * The `getPageSource` fetch itself lives in `vega-inspect.ts`; this module only
 * resolves the emulator serial and sets the flag.
 */

const TOOLKIT_ENABLE_FLAG = "/tmp/automation-toolkit.enable";

// No `serial` argument: v1 supports exactly one VVD (`discoverVegaConsolePort`
// errors if more than one runs), so `emulator-<consolePort>` is unambiguous.
export async function emulatorSerial(): Promise<{ serial: string; consolePort: number }> {
  const consolePort = await discoverVegaConsolePort();
  return { serial: `emulator-${consolePort}`, consolePort };
}

/**
 * Create the toolkit enable flag on the device. It is read at app launch, so an
 * already-running app must be relaunched to become introspectable.
 *
 * `_serial` (the caller's Vega udid) is unused — the target is the single
 * running VVD from `emulatorSerial` — and exists only for call-site symmetry
 * with the iOS/Android lifecycle tools.
 */
export async function ensureAutomationToolkitEnabled(_serial: string): Promise<void> {
  const { serial } = await emulatorSerial();
  await runAdb(["-s", serial, "shell", "touch", TOOLKIT_ENABLE_FLAG], { timeoutMs: 15_000 });
}
