import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { adbShell, runAdb } from "../../../utils/adb";
import { externalClaimForAnyId } from "../../../utils/external-devices";
import { metroPort } from "../../../utils/debugger/metro-port";
import type { NetworkConditions } from "../../../utils/network-conditions";
import { requestedConditions, type NetworkConditionsParams } from "../schema";
import type { AndroidServices, NetworkConditionsResult } from "../types";

const NETWORK_UP_TIMEOUT_MS = 15_000;
const NETWORK_DOWN_TIMEOUT_MS = 15_000;
const NETWORK_POLL_MS = 500;

function providerEmulator(): FailureError {
  return new FailureError(
    "On an emulator from a device provider network-conditions supports only `offline`. " +
      "Argent throttles an emulator through a proxy on this machine, which a provider's emulator may not reach.",
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
    `Turned Wi-Fi and mobile data off for ${serial}, but its network was still up after ` +
      `${NETWORK_DOWN_TIMEOUT_MS / 1000} s. The emulator may be slow: call network-conditions ` +
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

async function hasDefaultNetwork(serial: string): Promise<boolean> {
  const out = await adbShell(serial, "dumpsys connectivity | grep -m1 'Active default network'");
  return /Active default network: \d+/.test(out);
}

async function defaultNetworkIsEthernet(serial: string): Promise<boolean> {
  const out = await adbShell(serial, "dumpsys connectivity");
  const id = /Active default network: (\d+)/.exec(out)?.[1];
  const agent = out.split("\n").find((line) => line.includes(`NetworkAgentInfo{network{${id}}`));
  return /Transports: [A-Z|]*ETHERNET/.test(agent ?? "");
}

const networkIsUp = (serial: string) => hasDefaultNetwork(serial).catch(() => false);
const networkIsDown = (serial: string) =>
  hasDefaultNetwork(serial).then(
    (up) => !up,
    () => false
  );

async function pollUntil(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, NETWORK_POLL_MS));
  }
  return false;
}

async function waitForNetwork(serial: string): Promise<void> {
  const up = await pollUntil(() => networkIsUp(serial), NETWORK_UP_TIMEOUT_MS);
  if (!up) throw networkDidNotReturn(serial);
}

async function goOffline(serial: string): Promise<void> {
  await setRadios(serial, false);
  const down = await pollUntil(() => networkIsDown(serial), NETWORK_DOWN_TIMEOUT_MS);
  if (down) return;
  const ethernet = await defaultNetworkIsEthernet(serial).catch(() => false);
  await setRadios(serial, true);
  throw ethernet ? networkStayedUp(serial) : networkDidNotDrop(serial);
}

const shapesTraffic = (conditions: NetworkConditions) =>
  Boolean(conditions.latencyMs || conditions.downloadKbps || conditions.uploadKbps);

async function turnRadiosOn(serial: string): Promise<void> {
  if (await networkIsUp(serial)) return;
  await setRadios(serial, true);
  await waitForNetwork(serial);
}

export const androidImpl: PlatformImpl<
  AndroidServices,
  NetworkConditionsParams,
  NetworkConditionsResult
> = {
  requires: ["adb"],
  async handler(services, params) {
    const serial = params.udid;
    const conditions = requestedConditions(params);
    const shaper = services.networkShaper;

    if (conditions?.offline) {
      await shaper.clear();
      await goOffline(serial);
    } else if (conditions && shapesTraffic(conditions)) {
      if (externalClaimForAnyId(serial)) throw providerEmulator();
      await turnRadiosOn(serial);
      await shaper.throttle(conditions, metroPort({ device_id: serial, port: params.port }));
    } else {
      await shaper.clear();
      await turnRadiosOn(serial);
    }
    return { scope: "device", conditions };
  },
};
