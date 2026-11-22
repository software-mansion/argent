import { FAILURE_CODES, FailureError } from "@argent/registry";
import { adbShell, runAdb } from "./adb";

export const EMULATOR_HOST_ALIAS = "10.0.2.2";

/** Records the proxy Argent set, so a later tool-server tells its leftover from a user's proxy. */
const MARKER_PATH = "/data/local/tmp/argent-network-proxy";

const PROXY_KEYS = [
  "http_proxy",
  "global_http_proxy_host",
  "global_http_proxy_port",
  "global_http_proxy_exclusion_list",
];

const READ_STATE =
  "settings get global http_proxy; settings get global global_http_proxy_host; " +
  `settings get global global_http_proxy_port; cat ${MARKER_PATH} 2>/dev/null; true`;

const REMOVAL_TIMEOUT_MS = 5_000;
const REMOVAL_POLL_MS = 100;

interface GlobalProxyState {
  active: string | null;
  argent: string | null;
}

export function parseGlobalProxyState(output: string): GlobalProxyState {
  const [setting = "", host = "", port = "", marker = ""] = output
    .split(/\r?\n/)
    .map((line) => line.trim());
  const requested = /^[^:\s]+:[1-9]\d*$/.test(setting) ? setting : null;
  const hasProxy = host !== "" && host !== "null" && port !== "" && port !== "null" && port !== "0";
  return { active: requested ?? (hasProxy ? `${host}:${port}` : null), argent: marker || null };
}

async function readGlobalProxyState(serial: string): Promise<GlobalProxyState> {
  return parseGlobalProxyState(await adbShell(serial, READ_STATE));
}

function putHttpProxy(serial: string, value: string) {
  return runAdb(["-s", serial, "shell", "settings", "put", "global", "http_proxy", value]);
}

function foreignProxy(active: string): FailureError {
  return new FailureError(
    `The emulator already uses the HTTP proxy ${active}, which Argent did not set. ` +
      "network-conditions shapes the network through its own proxy and leaves this one in place. " +
      "Remove it (adb shell settings put global http_proxy :0) to throttle the emulator.",
    {
      error_code: FAILURE_CODES.TOOL_INPUT_INVALID,
      failure_stage: "network_conditions_proxy",
      failure_area: "tool_server",
      error_kind: "unsupported",
    }
  );
}

function removalNotApplied(serial: string): FailureError {
  return new FailureError(
    `Asked ${serial} to drop Argent's HTTP proxy, but Android did not apply it within ` +
      `${REMOVAL_TIMEOUT_MS / 1000} s, so apps may still use the proxy. Call network-conditions ` +
      "again with no conditions.",
    {
      error_code: FAILURE_CODES.ANDROID_NETWORK_RESTORE_TIMEOUT,
      failure_stage: "network_conditions_proxy",
      failure_area: "tool_server",
      error_kind: "timeout",
    }
  );
}

export async function setArgentProxy(serial: string, port: number): Promise<void> {
  const proxy = `${EMULATOR_HOST_ALIAS}:${port}`;
  const state = await readGlobalProxyState(serial);
  if (state.active === proxy) return;
  if (state.active && state.active !== state.argent) throw foreignProxy(state.active);
  await adbShell(serial, `echo ${proxy} > ${MARKER_PATH}`);
  await putHttpProxy(serial, proxy);
}

/** Removes the proxy Argent set, also one a crashed tool-server left, and keeps a user's proxy. */
export async function clearArgentProxy(serial: string): Promise<void> {
  const state = await readGlobalProxyState(serial);
  if (state.active && state.active === state.argent) {
    await putHttpProxy(serial, ":0");
    if (!(await deviceDroppedProxy(serial))) throw removalNotApplied(serial);
    await adbShell(serial, PROXY_KEYS.map((key) => `settings delete global ${key}`).join("; "));
  }
  if (state.argent) await adbShell(serial, `rm -f ${MARKER_PATH}`);
}

/**
 * Android applies a proxy change some time after the setting changes and ignores
 * a setting deleted before then. It writes port 0 once it has applied the removal.
 */
async function deviceDroppedProxy(serial: string): Promise<boolean> {
  const deadline = Date.now() + REMOVAL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const port = await adbShell(serial, "settings get global global_http_proxy_port");
    if (port.trim() === "0") return true;
    await new Promise((resolve) => setTimeout(resolve, REMOVAL_POLL_MS));
  }
  return false;
}

export function parseAdbReverses(output: string): Map<number, number> {
  const reverses = new Map<number, number>();
  for (const match of output.matchAll(/\btcp:(\d+)\s+tcp:(\d+)\b/g)) {
    reverses.set(Number(match[1]), Number(match[2]));
  }
  return reverses;
}

export async function listAdbReverses(serial: string): Promise<Map<number, number>> {
  const { stdout } = await runAdb(["-s", serial, "reverse", "--list"], { timeoutMs: 5_000 });
  return parseAdbReverses(stdout);
}
