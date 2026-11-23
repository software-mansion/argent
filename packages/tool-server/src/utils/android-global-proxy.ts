import { FAILURE_CODES, FailureError } from "@argent/registry";
import { adbShell, runAdb } from "./adb";

export const EMULATOR_HOST_ALIAS = "10.0.2.2";

/** Records the proxies Argent set, so a later tool-server tells its leftover from a user's proxy. */
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

const READ_APPLIED =
  "settings get global global_http_proxy_host; settings get global global_http_proxy_port";

const APPLY_TIMEOUT_MS = 5_000;
const APPLY_POLL_MS = 100;

interface GlobalProxyState {
  active: string | null;
  argent: string[];
}

export function parseGlobalProxyState(output: string): GlobalProxyState {
  const [setting = "", host = "", port = "", marker = ""] = output
    .split(/\r?\n/)
    .map((line) => line.trim());
  const requested = /^[^:\s]+:[1-9]\d*$/.test(setting) ? setting : null;
  const hasProxy = host !== "" && host !== "null" && port !== "" && port !== "null" && port !== "0";
  return {
    active: requested ?? (hasProxy ? `${host}:${port}` : null),
    argent: marker.split(/\s+/).filter(Boolean),
  };
}

async function readGlobalProxyState(serial: string): Promise<GlobalProxyState> {
  return parseGlobalProxyState(await adbShell(serial, READ_STATE));
}

function writeMarker(serial: string, proxies: (string | null)[]) {
  return adbShell(serial, `echo ${proxies.filter(Boolean).join(" ")} > ${MARKER_PATH}`);
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

function installNotApplied(serial: string): FailureError {
  return new FailureError(
    `Asked ${serial} to use Argent's HTTP proxy, but Android did not apply it within ` +
      `${APPLY_TIMEOUT_MS / 1000} s, so apps may bypass the network conditions. Call ` +
      "network-conditions again.",
    {
      error_code: FAILURE_CODES.ANDROID_NETWORK_PROXY_TIMEOUT,
      failure_stage: "network_conditions_proxy",
      failure_area: "tool_server",
      error_kind: "timeout",
    }
  );
}

function removalNotApplied(serial: string): FailureError {
  return new FailureError(
    `Asked ${serial} to drop Argent's HTTP proxy, but Android did not apply it within ` +
      `${APPLY_TIMEOUT_MS / 1000} s, so apps may still use the proxy. Call network-conditions ` +
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
  const replaced = state.active === proxy ? null : state.active;
  if (state.active !== proxy) {
    if (replaced && !state.argent.includes(replaced)) throw foreignProxy(replaced);
    await writeMarker(serial, [replaced, proxy]);
    await putHttpProxy(serial, proxy);
  }
  const applied = await proxyApplied(serial, (host, port) => `${host}:${port}` === proxy);
  if (!applied) throw installNotApplied(serial);
  const inTransition = state.argent.includes(proxy) && state.argent.length > 1;
  if (replaced || inTransition) await writeMarker(serial, [proxy]);
}

/** Removes the proxy Argent set, also one a crashed tool-server left, and keeps a user's proxy. */
export async function clearArgentProxy(serial: string): Promise<void> {
  const state = await readGlobalProxyState(serial);
  if (state.active && state.argent.includes(state.active)) {
    await putHttpProxy(serial, ":0");
    if (!(await proxyApplied(serial, (_host, port) => port === "0")))
      throw removalNotApplied(serial);
    await adbShell(serial, PROXY_KEYS.map((key) => `settings delete global ${key}`).join("; "));
  }
  if (state.argent.length > 0) await adbShell(serial, `rm -f ${MARKER_PATH}`);
}

/**
 * Android applies a proxy change some time after the setting changes and ignores
 * a setting deleted before then. It writes the applied host and port, port 0 for a removal.
 */
async function proxyApplied(
  serial: string,
  isApplied: (host: string, port: string) => boolean
): Promise<boolean> {
  const deadline = Date.now() + APPLY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const [host = "", port = ""] = (await adbShell(serial, READ_APPLIED))
      .split(/\r?\n/)
      .map((line) => line.trim());
    if (isApplied(host, port)) return true;
    await new Promise((resolve) => setTimeout(resolve, APPLY_POLL_MS));
  }
  return false;
}
