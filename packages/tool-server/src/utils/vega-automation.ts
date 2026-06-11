import { runAdb } from "./adb";
import { discoverVegaConsolePort } from "./vega-qmp";

/**
 * Talk to the Vega (Fire TV) on-device **automation toolkit** — the same
 * accessibility/introspection server Amazon's Appium Vega driver uses — directly
 * over JSON-RPC, without running Appium.
 *
 * Transport: the toolkit listens on device TCP port 8383. The VVD is an
 * Android-emulator-derived QEMU reachable over adb as `emulator-<consolePort>`
 * (the same serial the screenshot path derives), so we `adb forward` a host port
 * to 8383 and `POST` JSON-RPC at `http://127.0.0.1:<hostPort>/jsonrpc`.
 *
 * Gotcha: the toolkit is DISABLED by default. It only serves once the flag file
 * `/tmp/automation-toolkit.enable` exists on the device — until then it accepts
 * the TCP connection and closes it with an empty reply (`fetch` rejects). The
 * flag is read at app launch, so an app must be (re)launched after the flag is
 * set for its tree to appear. `ensureAutomationToolkitEnabled` writes the flag;
 * the app-lifecycle tools call it before launching so argent-launched apps are
 * introspectable, and a closed/empty reply is surfaced as a "relaunch" hint.
 */

const DEVICE_JSONRPC_PORT = 8383;
const TOOLKIT_ENABLE_FLAG = "/tmp/automation-toolkit.enable";
// A served `getPageSource` is multi-KB; anything shorter than this is an empty
// root (app not attached) and is treated the same as a closed connection.
const PAGE_SOURCE_EMPTY_LENGTH = 50;

/** Thrown when the toolkit server is unreachable/closed — i.e. not enabled or
 * the app was not relaunched after enabling. Distinct from an adb/device error. */
export class VegaToolkitUnavailableError extends Error {
  constructor(method: string, cause?: unknown) {
    super(
      `Vega automation toolkit did not respond to "${method}" (not enabled, or app not relaunched).`
    );
    this.name = "VegaToolkitUnavailableError";
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: string;
  result?: unknown;
  error?: { code: number; message: string };
}

// The VVD CLI targets the single connected device, and so does adb's emulator
// console; we derive the emulator serial the same way the screenshot path does.
// `serial` (the Vega udid) is accepted for interface symmetry / future
// multi-device support but the console port is authoritative today.
async function emulatorSerial(): Promise<{ serial: string; consolePort: number }> {
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

/**
 * Send one JSON-RPC call to the toolkit. Ensures the adb port-forward exists
 * (idempotent; a deterministic host port derived from the console port so it is
 * stable across calls and unique per device), then POSTs. A network-level
 * failure after a successful forward means the server closed the socket → the
 * toolkit isn't serving, raised as `VegaToolkitUnavailableError`.
 */
export async function vegaJsonRpc(
  _serial: string,
  method: string,
  params: Record<string, unknown> = {},
  options: { timeoutMs?: number } = {}
): Promise<unknown> {
  const { serial, consolePort } = await emulatorSerial();
  const hostPort = consolePort + 10_000;
  await runAdb(["-s", serial, "forward", `tcp:${hostPort}`, `tcp:${DEVICE_JSONRPC_PORT}`], {
    timeoutMs: 15_000,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${hostPort}/jsonrpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "0", method, params }),
      signal: controller.signal,
    });
  } catch (err) {
    // ECONNRESET / "socket hang up" / abort — the forward succeeded but the
    // on-device server didn't answer: toolkit off or app not relaunched.
    throw new VegaToolkitUnavailableError(method, err);
  } finally {
    clearTimeout(timer);
  }

  const body = (await res.json()) as JsonRpcResponse;
  if (body.error) {
    throw new Error(`Vega JSON-RPC "${method}" failed: ${body.error.code} ${body.error.message}`);
  }
  return body.result;
}

export type VegaPageSourceResult =
  | { ok: true; xml: string }
  | { ok: false; reason: "toolkit-unavailable" };

/**
 * Fetch the current screen's accessibility XML via `getPageSource`. Returns a
 * typed unavailable result (rather than throwing) when the toolkit is closed or
 * returns an empty root, so the describe adapter can hint the user to relaunch.
 */
export async function fetchVegaPageSource(serial: string): Promise<VegaPageSourceResult> {
  try {
    const result = await vegaJsonRpc(serial, "getPageSource", {}, { timeoutMs: 15_000 });
    if (typeof result !== "string" || result.length < PAGE_SOURCE_EMPTY_LENGTH) {
      return { ok: false, reason: "toolkit-unavailable" };
    }
    return { ok: true, xml: result };
  } catch (err) {
    if (err instanceof VegaToolkitUnavailableError)
      return { ok: false, reason: "toolkit-unavailable" };
    throw err;
  }
}
