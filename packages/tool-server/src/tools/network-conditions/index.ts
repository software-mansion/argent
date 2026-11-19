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
  description: `Throttle the network: add latency, limit download and upload speed, or go offline.
Use to test loading states, timeouts, retries and offline handling. Each call replaces the previous conditions. Call it with no condition (only udid, plus bundleId on iOS) to remove the throttle.
Returns { scope, conditions }. scope names what was shaped:
- "app" on an iOS simulator: only the app named by bundleId, a non-Apple app with native devtools connected. Shapes its http/https URLSession requests, except WebSockets and requests to the Metro port (port). The server gets each request at once: Argent delays what the app receives. Argent applies the conditions again when the app restarts and reconnects; the app drops them when the tool-server stops. If status is restart_required, service_stale, connect_pending or init_failed, follow the message as for native-network-logs.
- "device" on an Android emulator: the http/https requests and WebSockets of apps that use the system proxy. Argent sets the emulator's global HTTP proxy to its own proxy on the host, which adds latencyMs to every round trip (a new HTTPS connection pays it several times) and caps the total speed. Not shaped: requests to the Metro port (port), traffic that is not HTTP through the proxy (raw sockets, UDP, QUIC, DNS), apps that ignore the system proxy (such as Flutter dart:io), and connections opened before the call until they close; restart the app to shape all of them. While throttled, a request to a localhost port without adb reverse fails with 502. Fails when the emulator already has a proxy that Argent did not set. The tool-server removes its proxy at a reset and when it stops; after a crash apps cannot connect until a reset. offline removes the proxy and turns Wi-Fi and mobile data off; adb reverse ports stay reachable and an app that reaches Metro at 10.0.2.2 loses it. A call with latency or speed conditions, or a reset, turns both radios on and waits for a network.
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
