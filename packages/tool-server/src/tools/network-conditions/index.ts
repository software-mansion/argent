import type { ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { resolveDevice } from "../../utils/device-info";
import { chromiumCdpRef } from "../../blueprints/chromium-cdp";
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
  description: `Throttle the network: add latency, limit download and upload speed, or go offline.
Use to test loading states, timeouts, retries and offline handling. Each call replaces the previous conditions. Call it with no condition (only udid, plus bundleId on iOS) to remove the throttle.
Returns { scope, conditions }. scope names what was shaped:
- "app" on an iOS simulator: only the app named by bundleId, a non-Apple app with native devtools connected. Shapes its http/https URLSession requests, except WebSockets and requests to the Metro port (port). The server gets each request at once: Argent delays what the app receives. Argent applies the conditions again when the app restarts and reconnects; the app drops them when the tool-server stops. If status is restart_required, service_stale, connect_pending or init_failed, follow the message as for native-network-logs.
- "device" on an Android emulator: offline only. offline turns Wi-Fi and mobile data off; a call without conditions turns both on and waits for a network. latencyMs, downloadKbps and uploadKbps fail there. While offline, requests through adb reverse still work, and an app that reaches Metro at 10.0.2.2 loses it, so the debugger tools cannot reach a React Native app that loads from there.
- "tab" on Chromium: requests of the active tab's page, not its workers, service workers or cross-site iframes. Argent applies the conditions again after a tab switch and before a tab opened by chromium-tabs loads.
conditions is null after a reset. Fails on a physical iOS or Android device.`,
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
