import type { ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { resolveDevice } from "../../utils/device-info";
import { chromiumCdpRef } from "../../blueprints/chromium-cdp";
import { androidNetworkShaperRef } from "../../blueprints/android-network-shaper";
import {
  nativeDevtoolsRef,
  type NativeDevtoolsPrecheckBlock,
} from "../../blueprints/native-devtools";
import { networkConditionsZodSchema, type NetworkConditionsParams } from "./schema";
import type {
  AndroidServices,
  ChromiumServices,
  IosServices,
  NetworkConditionsResult,
} from "./types";
import { iosImpl } from "./platforms/ios";
import { androidImpl } from "./platforms/android";
import { chromiumImpl } from "./platforms/chromium";

type Result = NetworkConditionsResult | NativeDevtoolsPrecheckBlock;

const capability: ToolCapability = {
  apple: { simulator: true },
  android: { emulator: true },
  chromium: { app: true },
};

export const networkConditionsTool: ToolDefinition<NetworkConditionsParams, Result> = {
  id: "network-conditions",
  description: `Add latency, throttle bandwidth, or simulate offline mode on iOS simulators (per-app via native devtools, Metro/WS exempt), Android emulators (system proxy — restart app if existing connections bypass shaping; Ethernet can prevent offline mode; reset if a crash leaves the emulator unable to connect), or Chromium (active page). Omit all condition fields to reset.
Use when testing loading states, retries, or timeouts (each call replaces previous conditions).
Returns the scope and applied conditions (or null on reset), or on iOS a \`{ status, message }\` precheck block (follow \`message\` if \`status\` is present). Fails on physical devices, remote iOS simulators, or if Android has an unmanaged proxy.`,
  zodSchema: networkConditionsZodSchema,
  searchHint: "network throttle latency slow offline bandwidth 3g conditions emulate",
  interaction: {
    startedMsg: () => "Setting network conditions",
    completedMsg: () => "Set network conditions",
    failedMsg: ({ failureSignal }) =>
      `Failed to set network conditions: ${failureSignal.error_code}`,
  },
  capability,
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.udid);
    if (device.platform === "chromium") return { chromium: chromiumCdpRef(device) };
    if (device.platform === "ios" && device.kind === "simulator")
      return { nativeDevtools: nativeDevtoolsRef(device) };
    if (device.platform === "android" && device.kind === "emulator")
      return { networkShaper: androidNetworkShaperRef(device.id) };
    return {};
  },
  execute: dispatchByPlatform<
    IosServices,
    AndroidServices,
    NetworkConditionsParams,
    Result,
    ChromiumServices
  >({
    toolId: "network-conditions",
    capability,
    ios: iosImpl,
    android: androidImpl,
    chromium: chromiumImpl,
  }),
};
