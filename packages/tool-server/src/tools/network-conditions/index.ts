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
  description: `Add latency, cap speed or simulate an offline connection. Use when testing loading states, retries or timeouts. Each call replaces the previous conditions. Omit the conditions to reset after the test.
Returns the scope and applied conditions. A reset returns null for conditions.
On a local iOS simulator, Argent shapes one app's intercepted HTTP traffic. While online, Argent forwards requests immediately and delays delivery to the app. Native devtools must be connected. WebSockets and the Metro port are exempt. Follow message if the result includes a status.
On Android, Argent shapes traffic that uses the system proxy. Restart the app if existing connections bypass shaping. Throttling fails if the emulator has a proxy Argent did not set. Ethernet can prevent offline mode. Reset if a crash leaves the emulator unable to connect.
On Chromium, Argent shapes the active page. Workers and cross-site iframes are outside its scope.
Fails on physical devices and remote iOS simulators.`,
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
