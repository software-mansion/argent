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
      "Which system setting to change. Display / accessibility (both iOS simulator and Android): " +
        "`appearance` (light/dark theme), `text-size` (Dynamic Type / font size), " +
        "`increase-contrast` (high-contrast), `reduce-motion` (disable animations), " +
        "`invert-colors` (invert display colors). Android-only (radios / device state): " +
        "`wifi`, `cellular` (mobile data), `airplane-mode`, `location`, `auto-rotate`."
    ),
  // The union of all ten settings' value sets; `assertValidValue` narrows it to
  // the chosen setting. Enumerating here is what advertises the vocabulary to a
  // client that indexes the schema without loading the description, and it keeps
  // a caller's free-form string out of the 400 message, which echoes it.
  value: z
    .enum(SETTING_VALUE_VOCABULARY)
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
    // A value outside the chosen setting's own set is a caller input error, not
    // an internal fault — throw InvalidToolInputError so the HTTP layer maps it
    // to 400 (matching the keyboard backends' unknown-named-key rejections),
    // while the signal override keeps the granular SYSTEM_SETTING_UNSUPPORTED
    // telemetry bucket.
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
  description: `Set a device-wide system setting directly, without navigating the system Settings UI. Use when a test needs the device in a specific state — dark mode, a larger text size, airplane mode, location off — before or while exercising an app.
Settings and their values:
- \`appearance\`: \`light\` | \`dark\` — the system color theme.
- \`text-size\`: one of the 12 Dynamic Type categories from \`extra-small\` to \`accessibility-extra-extra-extra-large\` (\`large\` is the default).
- \`increase-contrast\`: \`on\` | \`off\` — iOS's Increase Contrast; on Android the nearest equivalent, high-contrast text.
- \`reduce-motion\`: \`on\` | \`off\` — reduce/disable UI animations.
- \`invert-colors\`: \`on\` | \`off\` — invert the display colors (Smart Invert on iOS). Confirm it from this result, not a \`screenshot\`: on Android the capture path skips the display-level color transform, and on iOS the inversion reaches the captured frame in \`dark\` appearance but not in \`light\`.
- \`wifi\`, \`cellular\`, \`airplane-mode\`, \`location\`, \`auto-rotate\`: \`on\` | \`off\` — Android only. A flow pins the status bar to a fixed demo state, so a screenshot taken inside one keeps showing full signal bars after a radio change — read this tool's result, not the bars.
Platforms:
- iOS simulator supports the first five (display / accessibility): \`appearance\`, \`text-size\`, and \`increase-contrast\` via \`simctl ui\`; \`reduce-motion\` and \`invert-colors\` via the accessibility preferences domain. The simulator must be booted. A setting the runtime doesn't model fails with the runtime's own refusal and a hint to try a newer one, and the five Android-only settings are rejected on iOS. Only a simulator \`simctl list\` reports as an available iOS one is accepted — an Apple TV simulator is rejected outright (neither mechanism reaches tvOS), and so is a UDID the listing cannot vouch for.
- Android supports all ten, on emulators and real devices, via \`adb\` (\`cmd uimode night\`, \`font_scale\`, accessibility flags, \`svc wifi/data\`, \`cmd connectivity airplane-mode\`, \`location_mode\`, \`accelerometer_rotation\`). A setting whose \`cmd\`/\`svc\` service this Android version doesn't implement fails instead of reporting a change it never made; the \`settings put\` ones accept any key at any version, so \`location\` carries its own floor — it needs Android 10 (API 29)+, where \`location_mode\` became the master switch, and is refused below it. Over a network transport — an mDNS serial, or \`host:port\` for anything but loopback — \`wifi\` off and \`airplane-mode\` on are refused, since they would switch off the link adb reaches the device over.
Re-run \`describe\` after \`text-size\` — every frame on screen moves with it.
This is a device-wide toggle, not per-app — no bundleId. Some apps only re-read a display/accessibility setting on next launch, so relaunch the app afterwards if the change doesn't appear live.
Returns { setting, value, applied }, where \`applied\` is the concrete platform-level change (e.g. \`content_size=large\`, \`night_mode=yes\`, \`ReduceMotionEnabled=YES\`, \`wifi=enabled\`). Fails if the value is invalid for the setting, the setting isn't available on the target platform or this Android version, the device isn't booted, or the platform command errors. A failed multi-part change (Android reduce-motion writes three animation scales) can leave part of it applied — run the same call again; every write is idempotent.`,
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
