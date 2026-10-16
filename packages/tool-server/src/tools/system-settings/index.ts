import { z } from "zod";
import { FAILURE_CODES } from "@argent/registry";
import type { ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { InvalidToolInputError } from "../../utils/capability";
import { SETTING_VALUE_VOCABULARY, SETTING_VALUES, SYSTEM_SETTINGS } from "./types";
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
      "The setting to change. `wifi`, `cellular`, `airplane-mode`, `location` and `auto-rotate` are Android-only."
    ),
  value: z
    .enum(SETTING_VALUE_VOCABULARY)
    .describe(
      "`appearance`: light | dark. `text-size`: a Dynamic Type category (`large` is the default). Every other setting: on | off."
    ),
});

type Params = z.infer<typeof zodSchema>;

const capability: ToolCapability = {
  apple: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
};

function assertValidValue(params: SystemSettingsParams): void {
  const allowed = SETTING_VALUES[params.setting];
  if (!allowed.includes(params.value)) {
    throw new InvalidToolInputError(
      `'${params.value}' is not a valid value for '${params.setting}'. Valid values: ${allowed.join(", ")}.`,
      {
        error_code: FAILURE_CODES.SYSTEM_SETTING_UNSUPPORTED,
        failure_stage: "system_setting_validate_value",
        error_kind: "unsupported",
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
  description: `Set a device-wide system setting without navigating the Settings UI. Use when a test needs the device in a specific state - dark mode, a larger text size, airplane mode, location off - before exercising an app.
iOS simulator and Android: \`appearance\`, \`text-size\`, \`increase-contrast\`, \`reduce-motion\`, \`invert-colors\`. Android only: \`wifi\`, \`cellular\`, \`airplane-mode\`, \`location\` (Android 10+), \`auto-rotate\`.
Not per-app: for one app's permission use \`settings-permissions\`; to turn the screen use \`rotate\` (\`auto-rotate\` is the rotation lock).
Confirm the change from this result, not a screenshot: captures can miss \`invert-colors\`, and a flow pins the status bar. Some apps re-read appearance and text size only on launch, so relaunch if the change does not show. Re-run \`describe\` after \`text-size\`.
Returns { setting, value, applied }, where \`applied\` is the platform-level change (e.g. \`night_mode=yes\`). Fails if the value is invalid for the setting, the target cannot apply it (Android-only setting on iOS, an Apple TV simulator, too old an Android version, \`wifi\` off or \`airplane-mode\` on over wireless adb), the simulator is not booted, or the platform command refuses. A timeout can leave the change applied; every write is absolute, so retrying is safe.`,
  searchHint:
    "dark light mode appearance theme color scheme text size font dynamic type increase contrast reduce motion animations invert colors accessibility wifi cellular mobile data airplane mode flight mode location gps auto rotate orientation radios system settings toggle",
  zodSchema,
  capability,
  services: () => ({}),
  async execute(services, params, options) {
    assertValidValue(params);
    return dispatch(services, params, options);
  },
};
