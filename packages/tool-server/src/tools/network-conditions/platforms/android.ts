import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { adbShell, runAdb } from "../../../utils/adb";
import { requestedConditions, type NetworkConditionsParams } from "../schema";
import type { AndroidServices, NetworkConditionsResult } from "../types";

const NETWORK_UP_TIMEOUT_MS = 15_000;
const NETWORK_DOWN_TIMEOUT_MS = 15_000;
const NETWORK_POLL_MS = 500;

function onlyOfflineSupported(): FailureError {
  return new FailureError(
    "On an Android emulator network-conditions supports only `offline`. The emulator console's " +
      "speed and delay settings do not shape the Wi-Fi network that current system images use.",
    {
      error_code: FAILURE_CODES.TOOL_INPUT_INVALID,
      failure_stage: "network_conditions_params",
      failure_area: "tool_server",
      error_kind: "unsupported",
    }
  );
}

function networkDidNotReturn(serial: string): FailureError {
  return new FailureError(
    `Turned Wi-Fi and mobile data back on for ${serial}, but no network came up within ` +
      `${NETWORK_UP_TIMEOUT_MS / 1000} s. Check the emulator's network, then call ` +
      "network-conditions again with no conditions.",
    {
      error_code: FAILURE_CODES.ANDROID_NETWORK_RESTORE_TIMEOUT,
      failure_stage: "network_conditions_reset",
      failure_area: "tool_server",
      error_kind: "timeout",
    }
  );
}

function networkStayedUp(serial: string): FailureError {
  return new FailureError(
    `${serial} still has a network with Wi-Fi and mobile data off, so network-conditions cannot ` +
      "take it offline. An Android TV emulator connects over Ethernet, which Argent cannot turn off. " +
      "Wi-Fi and mobile data are back on.",
    {
      error_code: FAILURE_CODES.ANDROID_OFFLINE_UNSUPPORTED,
      failure_stage: "network_conditions_offline",
      failure_area: "tool_server",
      error_kind: "unsupported",
    }
  );
}

function networkDidNotDrop(serial: string): FailureError {
  return new FailureError(
    `Turned Wi-Fi and mobile data off for ${serial}, but could not confirm it was offline after ` +
      `${NETWORK_DOWN_TIMEOUT_MS / 1000} s. Check the adb connection and call network-conditions ` +
      "again. Wi-Fi and mobile data are back on.",
    {
      error_code: FAILURE_CODES.ANDROID_OFFLINE_TIMEOUT,
      failure_stage: "network_conditions_offline",
      failure_area: "tool_server",
      error_kind: "timeout",
    }
  );
}

async function setRadios(serial: string, enabled: boolean): Promise<void> {
  const state = enabled ? "enable" : "disable";
  await runAdb(["-s", serial, "shell", "svc", "wifi", state]);
  await runAdb(["-s", serial, "shell", "svc", "data", state]).catch((err: unknown) => {
    if (!String(err).includes("Can't find service")) throw err;
  });
}

type NetworkState = "online" | "offline" | "unknown";

async function readNetworkState(serial: string): Promise<NetworkState> {
  const out = await adbShell(
    serial,
    "dumpsys connectivity | grep -m1 'Active default network'"
  ).catch(() => "");
  const value = /^\s*Active default network:\s*(none|\d+)\s*$/m.exec(out)?.[1];
  if (!value) return "unknown";
  return value === "none" ? "offline" : "online";
}

async function defaultNetworkIsEthernet(serial: string): Promise<boolean> {
  const out = await adbShell(serial, "dumpsys connectivity");
  const id = /Active default network: (\d+)/.exec(out)?.[1];
  const agent = out.split("\n").find((line) => line.includes(`NetworkAgentInfo{network{${id}}`));
  return /Transports: [A-Z|]*ETHERNET/.test(agent ?? "");
}

async function waitForNetworkState(
  serial: string,
  expected: "online" | "offline",
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await readNetworkState(serial)) === expected) return true;
    await new Promise((resolve) => setTimeout(resolve, NETWORK_POLL_MS));
  }
  return false;
}

async function waitForNetwork(serial: string): Promise<void> {
  const up = await waitForNetworkState(serial, "online", NETWORK_UP_TIMEOUT_MS);
  if (!up) throw networkDidNotReturn(serial);
}

async function goOffline(serial: string): Promise<void> {
  await setRadios(serial, false);
  const down = await waitForNetworkState(serial, "offline", NETWORK_DOWN_TIMEOUT_MS);
  if (down) return;
  const ethernet = await defaultNetworkIsEthernet(serial).catch(() => false);
  await setRadios(serial, true);
  throw ethernet ? networkStayedUp(serial) : networkDidNotDrop(serial);
}

export const androidImpl: PlatformImpl<
  AndroidServices,
  NetworkConditionsParams,
  NetworkConditionsResult
> = {
  requires: ["adb"],
  async handler(_services, params) {
    const serial = params.udid;
    const conditions = requestedConditions(params);
    const offlineOnly = conditions?.offline === true && Object.keys(conditions).length === 1;
    if (conditions && !offlineOnly) throw onlyOfflineSupported();

    if (conditions) {
      await goOffline(serial);
    } else if ((await readNetworkState(serial)) !== "online") {
      await setRadios(serial, true);
      await waitForNetwork(serial);
    }
    return { scope: "device", conditions };
  },
};
