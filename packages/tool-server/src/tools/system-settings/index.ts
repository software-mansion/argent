import { z } from "zod";
import { FAILURE_CODES } from "@argent/registry";
import type { ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { InvalidToolInputError } from "../../utils/capability";
import { SETTING_VALUES, SYSTEM_SETTINGS } from "./types";
import type { SystemSettingsParams, SystemSettingsResult, SystemSettingsServices } from "./types";
import { iosImpl } from "./platforms/ios";
import { androidImpl } from "./platforms/android";

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe("Target device id from `list-devices` (iOS simulator UDID or Android serial)."),
  setting: z
    .enum(SYSTEM_SETTINGS)
    .describe(
      "Which system setting to change. Display / accessibility (both iOS simulator and Android): " +
        "`appearance` (light/dark theme), `text-size` (Dynamic Type / font size), " +
        "`increase-contrast` (high-contrast), `reduce-motion` (disable animations), " +
        "`invert-colors` (invert display colors). Android-only (radios / device state): " +
        "`wifi`, `cellular` (mobile data), `airplane-mode`, `location`, `auto-rotate`."
    ),
  value: z
    .string()
    .min(1)
    .describe(
      "The value to set — valid values depend on `setting`: " +
        "`appearance` → light | dark; " +
        "`text-size` → extra-small | small | medium | large | extra-large | extra-extra-large | extra-extra-extra-large | accessibility-medium | accessibility-large | accessibility-extra-large | accessibility-extra-extra-large | accessibility-extra-extra-extra-large (smallest to largest; `large` is the default); " +
        "every other setting → on | off (`on` turns the named setting on — e.g. `reduce-motion` on reduces motion, `airplane-mode` on enables airplane mode)."
    ),
});

type Params = z.infer<typeof zodSchema>;

const capability: ToolCapability = {
  // `simctl ui` edits the simulator's UI settings — physical iPhones have no
  // host-side equivalent, so no `device: true` on apple.
  apple: { simulator: true },
  // No `appleRemote`, unlike the sibling settings-permissions: sim-remote
  // forwards a fixed set of simctl verbs and `ui` is not among them, so three
  // of the five iOS settings have no remote path. Claiming the capability would
  // accept `appearance` on a remote sim and then fail inside the handler.
  // `adb shell cmd uimode` / `settings put` work on emulators and real Android
  // devices alike.
  android: { emulator: true, device: true, unknown: true },
};

// Reject a `value` that isn't legal for the chosen `setting` before dispatch, so
// a bad argument never reaches a platform command. Runs for every platform, so
// it lives here rather than duplicated in each handler.
function assertValidValue(params: SystemSettingsParams): void {
  const allowed = SETTING_VALUES[params.setting];
  if (!allowed.includes(params.value)) {
    // An out-of-set value is a caller input error, not an internal fault — throw
    // InvalidToolInputError so the HTTP layer maps it to 400 (matching the
    // keyboard backends' un-typeable-character rejections), while the signal
    // override keeps the granular SYSTEM_SETTING_UNSUPPORTED telemetry bucket.
    throw new InvalidToolInputError(
      `'${params.value}' is not a valid value for '${params.setting}'. Valid values: ${allowed.join(", ")}.`,
      {
        error_code: FAILURE_CODES.SYSTEM_SETTING_UNSUPPORTED,
        failure_stage: "system_setting_validate_value",
      }
    );
  }
}

const dispatch = dispatchByPlatform<
  SystemSettingsServices,
  SystemSettingsServices,
  Params,
  SystemSettingsResult
>({
  toolId: "system-settings",
  capability,
  ios: iosImpl,
  android: androidImpl,
});

export const systemSettingsTool: ToolDefinition<Params, SystemSettingsResult> = {
  id: "system-settings",
  interaction: {
    startedMsg: ({ params }) => `Setting ${params.setting} to ${params.value}`,
    completedMsg: ({ params }) => `Set ${params.setting} to ${params.value}`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to set ${params.setting} to ${params.value}: ${failureSignal.error_code}`,
  },
  description: `Set a device-wide system setting directly, without navigating the system Settings UI. Use when a test needs the device in a specific state — dark mode, a larger text size, airplane mode, location off — before or while exercising an app.
Settings and their values:
- \`appearance\`: \`light\` | \`dark\` — the system color theme.
- \`text-size\`: one of the 12 Dynamic Type categories from \`extra-small\` to \`accessibility-extra-extra-extra-large\` (\`large\` is the default).
- \`increase-contrast\`: \`on\` | \`off\` — accessibility high-contrast mode.
- \`reduce-motion\`: \`on\` | \`off\` — reduce/disable UI animations.
- \`invert-colors\`: \`on\` | \`off\` — invert the display colors. The capture path skips the display-level color transform, so \`screenshot\` comes back in the original colors on both platforms even while the device is inverted — don't read one back to confirm this setting.
- \`wifi\`, \`cellular\`, \`airplane-mode\`, \`location\`, \`auto-rotate\`: \`on\` | \`off\` — Android only.
Platforms:
- iOS simulator supports the first five (display / accessibility): \`appearance\`, \`text-size\`, and \`increase-contrast\` via \`simctl ui\`; \`reduce-motion\` and \`invert-colors\` via the accessibility preferences domain. The simulator must be booted. A setting a given iOS runtime doesn't model returns an unsupported error, and the five Android-only settings are rejected on iOS.
- Android supports all ten, on emulators and real devices, via \`adb\` (\`cmd uimode night\`, \`font_scale\`, accessibility flags, \`svc wifi/data\`, \`cmd connectivity airplane-mode\`, \`location_mode\`, \`accelerometer_rotation\`). Dark mode needs Android 10 (API 29)+.
This is a device-wide toggle, not per-app — no bundleId. Some apps only re-read a display/accessibility setting on next launch, so relaunch the app afterwards if the change doesn't appear live.
Returns { setting, value, applied }, where \`applied\` is the concrete platform-level change (e.g. \`content_size=large\`, \`night_mode=yes\`, \`ReduceMotionEnabled=YES\`, \`wifi=enabled\`). Fails if the value is invalid for the setting, the setting isn't available on the target platform, the device isn't booted, or the platform command errors.`,
  searchHint:
    "dark light mode appearance theme color scheme text size font dynamic type increase contrast accessibility system settings toggle",
  zodSchema,
  capability,
  services: () => ({}),
  async execute(services, params, options) {
    assertValidValue(params);
    return dispatch(services, params, options);
  },
};
