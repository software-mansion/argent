// The device-wide settings this tool can toggle. Each maps to a platform
// command in `platforms/` — the abstract name here is the vocabulary the agent
// uses and the platform files own the translation. Some settings are
// cross-platform (display / accessibility), others are Android-only because the
// iOS simulator has no host-side control over them (radios, location, rotation);
// `IOS_SUPPORTED_SETTINGS` records which the iOS simulator can carry out.
export const SYSTEM_SETTINGS = [
  "appearance",
  "text-size",
  "increase-contrast",
  "reduce-motion",
  "invert-colors",
  "wifi",
  "cellular",
  "airplane-mode",
  "location",
  "auto-rotate",
] as const;

export type SystemSetting = (typeof SYSTEM_SETTINGS)[number];

// `appearance` is the only non-boolean, non-scale setting: a light/dark choice.
const APPEARANCE_VALUES = ["light", "dark"] as const;

// The shared value vocabulary for every boolean toggle (accessibility flags,
// radios, location, rotation). `on` turns the named setting on — e.g.
// `reduce-motion on` reduces motion, `airplane-mode on` enables airplane mode.
const ON_OFF_VALUES = ["on", "off"] as const;

// The 12 Dynamic Type content-size categories `simctl ui content_size` accepts,
// smallest to largest (the 5 `accessibility-*` sizes are the AX range). Kept in
// this order so a human reading the list sees a monotonic scale. On Android each
// maps to a `font_scale` float (see platforms/android.ts).
export const TEXT_SIZE_VALUES = [
  "extra-small",
  "small",
  "medium",
  "large",
  "extra-large",
  "extra-extra-large",
  "extra-extra-extra-large",
  "accessibility-medium",
  "accessibility-large",
  "accessibility-extra-large",
  "accessibility-extra-extra-large",
  "accessibility-extra-extra-extra-large",
] as const;

// The legal abstract values for each setting, used to validate `value` before
// dispatch (an out-of-range value fails with SYSTEM_SETTING_UNSUPPORTED and this
// list, rather than reaching a platform command with a bad argument).
export const SETTING_VALUES: Record<SystemSetting, readonly string[]> = {
  "appearance": APPEARANCE_VALUES,
  "text-size": TEXT_SIZE_VALUES,
  "increase-contrast": ON_OFF_VALUES,
  "reduce-motion": ON_OFF_VALUES,
  "invert-colors": ON_OFF_VALUES,
  "wifi": ON_OFF_VALUES,
  "cellular": ON_OFF_VALUES,
  "airplane-mode": ON_OFF_VALUES,
  "location": ON_OFF_VALUES,
  "auto-rotate": ON_OFF_VALUES,
};

// The settings the iOS simulator can change: the three `simctl ui` options plus
// the two accessibility toggles reachable through the `com.apple.Accessibility`
// defaults domain. The rest are radios / location / rotation, which the iOS
// simulator has no host-side control over — the iOS handler rejects them with a
// clear "Android-only" message rather than reaching for a command that can't
// exist.
export const IOS_SUPPORTED_SETTINGS: readonly SystemSetting[] = [
  "appearance",
  "text-size",
  "increase-contrast",
  "reduce-motion",
  "invert-colors",
];

export interface SystemSettingsParams {
  udid: string;
  setting: SystemSetting;
  value: string;
}

export interface SystemSettingsResult {
  setting: SystemSetting;
  value: string;
  /**
   * The concrete platform-level change that was applied, so the caller can see
   * exactly what the abstract (setting, value) translated to: on iOS the
   * `simctl ui` option or the accessibility default key (e.g. `content_size=large`,
   * `ReduceMotionEnabled=YES`), on Android the `adb` change (e.g. `night_mode=yes`,
   * `wifi=enabled`, `font_scale=1.0`).
   */
  applied: string;
}

export type SystemSettingsServices = Record<string, never>;
