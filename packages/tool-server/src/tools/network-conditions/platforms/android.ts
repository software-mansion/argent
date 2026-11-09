import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { runAdb } from "../../../utils/adb";
import { runEmuConsole } from "../../../utils/emulator-console";
import type { NetworkConditions } from "../../../utils/network-conditions";
import { requestedConditions, type NetworkConditionsParams } from "../schema";
import type { AndroidServices, NetworkConditionsResult } from "../types";

/** Emulator console `network speed`: `<up>:<down>` in kbps, where 0 means no limit. */
function emulatorSpeed(conditions: NetworkConditions | null): string {
  if (conditions?.uploadKbps === undefined && conditions?.downloadKbps === undefined) {
    return "full";
  }
  return `${conditions.uploadKbps ?? 0}:${conditions.downloadKbps ?? 0}`;
}

function emulatorDelay(conditions: NetworkConditions | null): string {
  return conditions?.latencyMs ? String(conditions.latencyMs) : "none";
}

const offlineSerials = new Set<string>();

async function setRadios(serial: string, enabled: boolean): Promise<void> {
  const state = enabled ? "enable" : "disable";
  await runAdb(["-s", serial, "shell", "svc", "wifi", state]);
  await runAdb(["-s", serial, "shell", "svc", "data", state]);
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
    await runEmuConsole(serial, ["network", "speed", emulatorSpeed(conditions)]);
    await runEmuConsole(serial, ["network", "delay", emulatorDelay(conditions)]);
    if (conditions?.offline) {
      await setRadios(serial, false);
      offlineSerials.add(serial);
    } else if (conditions === null || offlineSerials.has(serial)) {
      await setRadios(serial, true);
      offlineSerials.delete(serial);
    }
    return { scope: "device", conditions };
  },
};
