import { FAILURE_CODES, FailureError } from "@argent/registry";
import { adbShell, runAdb } from "./adb";

/** The host's loopback as an Android emulator sees it. */
export const EMULATOR_HOST_ALIAS = "10.0.2.2";

/**
 * The proxy Argent set, kept on the device so that a tool-server started after
 * a crash can tell its own leftover proxy from one the user set.
 */
const MARKER_PATH = "/data/local/tmp/argent-network-proxy";

const PROXY_KEYS = [
  "http_proxy",
  "global_http_proxy_host",
  "global_http_proxy_port",
  "global_http_proxy_exclusion_list",
];

const READ_STATE =
  "settings get global global_http_proxy_host; settings get global global_http_proxy_port; " +
  `cat ${MARKER_PATH} 2>/dev/null; true`;

interface GlobalProxyState {
  /** `host:port` of the proxy in effect, or `null` for none. */
  active: string | null;
  /** The proxy Argent last set, or `null`. */
  argent: string | null;
}

export function parseGlobalProxyState(output: string): GlobalProxyState {
  const [host = "", port = "", marker = ""] = output.split(/\r?\n/).map((line) => line.trim());
  const hasProxy = host !== "" && host !== "null" && port !== "" && port !== "null" && port !== "0";
  return { active: hasProxy ? `${host}:${port}` : null, argent: marker || null };
}

async function readGlobalProxyState(serial: string): Promise<GlobalProxyState> {
  return parseGlobalProxyState(await adbShell(serial, READ_STATE));
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

/** Points the emulator's global HTTP proxy at `port` on the host. */
export async function setArgentProxy(serial: string, port: number): Promise<void> {
  const proxy = `${EMULATOR_HOST_ALIAS}:${port}`;
  const state = await readGlobalProxyState(serial);
  if (state.active === proxy) return;
  if (state.active && state.active !== state.argent) throw foreignProxy(state.active);
  await adbShell(serial, `echo ${proxy} > ${MARKER_PATH}`);
  await runAdb(["-s", serial, "shell", "settings", "put", "global", "http_proxy", proxy]);
}

/**
 * Removes the proxy Argent set, also one a crashed tool-server left. A proxy
 * the user set stays.
 */
export async function clearArgentProxy(serial: string): Promise<void> {
  const state = await readGlobalProxyState(serial);
  if (state.active && state.active === state.argent) {
    await runAdb(["-s", serial, "shell", "settings", "put", "global", "http_proxy", ":0"]);
    const deletes = PROXY_KEYS.map((key) => `settings delete global ${key}`).join("; ");
    await adbShell(serial, deletes);
  }
  if (state.argent) await adbShell(serial, `rm -f ${MARKER_PATH}`);
}

/** Device port to host port, from `adb reverse --list` lines such as `host-15 tcp:8081 tcp:8081`. */
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
