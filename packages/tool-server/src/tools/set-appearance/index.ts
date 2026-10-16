import type { ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { setAppearanceZodSchema } from "./schema";
import type { SetAppearanceParams, SetAppearanceResult, SetAppearanceServices } from "./types";
import { iosImpl } from "./platforms/ios";
import { androidImpl } from "./platforms/android";

const capability: ToolCapability = {
  // `simctl ui` acts on simulators only; a physical iPhone has no host-side
  // switch for it.
  apple: { simulator: true },
  // `cmd uimode` runs from the adb shell on emulators and devices alike.
  android: { emulator: true, device: true, unknown: true },
  // No `appleRemote` block: `sim-remote simctl` would need to forward the `ui`
  // verb, which has not been verified, so a remote simulator is rejected by the
  // capability gate rather than failing halfway.
};

export const setAppearanceTool: ToolDefinition<SetAppearanceParams, SetAppearanceResult> = {
  id: "set-appearance",
  interaction: {
    startedMsg: ({ params }) => `Switching device to ${params.appearance} appearance`,
    completedMsg: ({ params }) => `Switched device to ${params.appearance} appearance`,
    failedMsg: ({ failureSignal }) => `Failed to set appearance: ${failureSignal.error_code}`,
  },
  description: `Switch the device's system appearance between light and dark (dark mode).
Use to check a screen in both appearances, or to put the device back in the one a test expects. Apps that follow the system appearance re-render without a relaunch; take a screenshot or \`describe\` afterwards.
iOS: the simulator-wide setting (Settings ▸ Developer ▸ Dark Appearance), via \`simctl ui\`. Needs iOS 13 or later.
Android: the system dark theme, via \`cmd uimode night\`.
Returns { appearance, previous }, where \`previous\` is the appearance before the call (null when Android reported \`auto\` or \`custom\`), so you can restore it.`,
  searchHint: "dark mode light mode appearance theme night mode color scheme",
  zodSchema: setAppearanceZodSchema,
  capability,
  // No simulator-server is resolved: `simctl`/`adb` are called directly.
  services: () => ({}),
  execute: dispatchByPlatform<
    SetAppearanceServices,
    SetAppearanceServices,
    SetAppearanceParams,
    SetAppearanceResult
  >({
    toolId: "set-appearance",
    capability,
    ios: iosImpl,
    android: androidImpl,
  }),
};
