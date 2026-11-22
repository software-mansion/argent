import type { ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import type { NativeDevtoolsApi } from "../../blueprints/native-devtools";
import type { NetworkConditions } from "../../utils/network-conditions";

export interface NetworkConditionsResult {
  /** What was shaped: one iOS app, the whole Android emulator, or one Chromium tab. */
  scope: "app" | "device" | "tab";
  /** `null` when the call reset the network to no throttling. */
  conditions: NetworkConditions | null;
}

export type IosServices = { nativeDevtools: NativeDevtoolsApi };
export type ChromiumServices = { chromium: ChromiumCdpApi };
export type AndroidServices = Record<string, never>;
