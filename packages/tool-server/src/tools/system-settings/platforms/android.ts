import { FAILURE_CODES, FailureError, subprocessFailureMetadata } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { adbShell } from "../../../utils/adb";
import { TEXT_SIZE_VALUES } from "../types";
import type {
  SystemSetting,
  SystemSettingsParams,
  SystemSettingsResult,
  SystemSettingsServices,
} from "../types";

// appearance → `cmd uimode night <mode>` (the immediate, applies-now switch for
// the system dark/light theme; API 29+).
const NIGHT_MODE: Record<string, string> = { light: "no", dark: "yes" };

// text-size → a `system.font_scale` float. iOS names 12 Dynamic Type categories
// where Android takes a continuous multiplier, so each category maps to the
// scale factor of that category's body-text point size relative to `large`
// (17pt) — iOS body sizes 14/15/16/17/19/21/23 then the AX range 28/33/40/47/53.
// This keeps the visual step between categories close to what iOS renders.
const FONT_SCALE: Record<(typeof TEXT_SIZE_VALUES)[number], string> = {
  "extra-small": "0.82",
  "small": "0.88",
  "medium": "0.94",
  "large": "1.0",
  "extra-large": "1.12",
  "extra-extra-large": "1.24",
  "extra-extra-extra-large": "1.35",
  "accessibility-medium": "1.65",
  "accessibility-large": "1.94",
  "accessibility-extra-large": "2.35",
  "accessibility-extra-extra-large": "2.76",
  "accessibility-extra-extra-extra-large": "3.12",
};

interface AndroidChange {
  // The `adb shell` command string. Values here are tool-controlled constants
  // (mode strings, 0/1 flags, font-scale floats), never raw caller input, so no
  // shell-quoting is needed. Multiple `settings put` calls are chained with `&&`
  // so a failure short-circuits to a non-zero exit.
  shellCommand: string;
  // Human-readable description of the concrete platform-level change.
  applied: string;
}

// Translate an abstract (setting, value) into the concrete `adb` change. Central
// validation already guaranteed `value` is legal for `setting`, so every branch
// here has a well-defined mapping.
function androidChange(setting: SystemSetting, value: string): AndroidChange {
  const on = value === "on";
  switch (setting) {
    case "appearance": {
      const mode = NIGHT_MODE[value]!;
      return { shellCommand: `cmd uimode night ${mode}`, applied: `night_mode=${mode}` };
    }
    case "text-size": {
      const scale = FONT_SCALE[value as (typeof TEXT_SIZE_VALUES)[number]]!;
      return {
        shellCommand: `settings put system font_scale ${scale}`,
        applied: `font_scale=${scale}`,
      };
    }
    case "increase-contrast": {
      const flag = on ? "1" : "0";
      return {
        shellCommand: `settings put secure high_text_contrast_enabled ${flag}`,
        applied: `high_text_contrast_enabled=${flag}`,
      };
    }
    case "reduce-motion": {
      // Android has no single "reduce motion" flag; the analogue is turning the
      // three animation scales off. `on` (reduce motion) → 0, `off` → 1.
      const scale = on ? "0" : "1";
      return {
        shellCommand:
          `settings put global window_animation_scale ${scale} && ` +
          `settings put global transition_animation_scale ${scale} && ` +
          `settings put global animator_duration_scale ${scale}`,
        applied: `animation_scales=${scale}`,
      };
    }
    case "invert-colors": {
      const flag = on ? "1" : "0";
      return {
        shellCommand: `settings put secure accessibility_display_inversion_enabled ${flag}`,
        applied: `accessibility_display_inversion_enabled=${flag}`,
      };
    }
    case "wifi":
      return {
        shellCommand: `svc wifi ${on ? "enable" : "disable"}`,
        applied: `wifi=${on ? "enabled" : "disabled"}`,
      };
    case "cellular":
      return {
        shellCommand: `svc data ${on ? "enable" : "disable"}`,
        applied: `mobile_data=${on ? "enabled" : "disabled"}`,
      };
    case "airplane-mode":
      return {
        shellCommand: `cmd connectivity airplane-mode ${on ? "enable" : "disable"}`,
        applied: `airplane_mode=${on ? "enabled" : "disabled"}`,
      };
    case "location": {
      // location_mode 3 = high accuracy (on), 0 = off. `cmd location
      // is-location-enabled` tracks this value, so it's the authoritative toggle.
      const mode = on ? "3" : "0";
      return {
        shellCommand: `settings put secure location_mode ${mode}`,
        applied: `location_mode=${mode}`,
      };
    }
    case "auto-rotate": {
      const flag = on ? "1" : "0";
      return {
        shellCommand: `settings put system accelerometer_rotation ${flag}`,
        applied: `accelerometer_rotation=${flag}`,
      };
    }
  }
}

export const androidImpl: PlatformImpl<
  SystemSettingsServices,
  SystemSettingsParams,
  SystemSettingsResult
> = {
  requires: ["adb"],
  handler: async (_services, params) => {
    const { udid, setting, value } = params;
    const { shellCommand, applied } = androidChange(setting, value);

    try {
      // `settings put` / `svc` / `cmd` are silent on success and exit non-zero
      // (→ adbShell throws) on a real failure, so the exit code — not the
      // output — is the success signal.
      await adbShell(udid, shellCommand, { timeoutMs: 15_000 });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new FailureError(
        `Failed to set '${setting}' to '${value}' on ${udid}: ${detail.trim()}`,
        {
          error_code: FAILURE_CODES.ANDROID_SYSTEM_SETTING_FAILED,
          failure_stage: "android_system_setting_adb",
          failure_area: "tool_server",
          error_kind: "subprocess",
          ...subprocessFailureMetadata(err, "adb"),
        },
        { cause: err instanceof Error ? err : new Error(String(err)) }
      );
    }

    return { setting, value, applied };
  },
};
