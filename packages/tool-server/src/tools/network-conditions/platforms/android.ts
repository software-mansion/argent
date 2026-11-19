import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { adbShell, runAdb } from "../../../utils/adb";
import { externalClaimForAnyId } from "../../../utils/external-devices";
import { metroPort } from "../../../utils/debugger/metro-port";
import { requestedConditions, type NetworkConditionsParams } from "../schema";
import type { AndroidServices, NetworkConditionsResult } from "../types";

const NETWORK_UP_TIMEOUT_MS = 15_000;
const NETWORK_UP_POLL_MS = 500;

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

async function waitForNetwork(serial: string): Promise<void> {
  const deadline = Date.now() + NETWORK_UP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await hasDefaultNetwork(serial).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, NETWORK_UP_POLL_MS));
  }
}

async function turnRadiosOn(serial: string): Promise<void> {
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
      await setRadios(serial, false);
    } else if (conditions) {
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
