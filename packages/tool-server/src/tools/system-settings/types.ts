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

const APPEARANCE_VALUES = ["light", "dark"] as const;

const ON_OFF_VALUES = ["on", "off"] as const;

// The Dynamic Type categories `simctl ui content_size` accepts, smallest first.
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

export const SETTING_VALUE_VOCABULARY = [
  ...APPEARANCE_VALUES,
  ...ON_OFF_VALUES,
  ...TEXT_SIZE_VALUES,
] as const;

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
  /** The platform-level change made, e.g. `content_size=large`, `night_mode=yes`. */
  applied: string;
}

export type SystemSettingsServices = Record<string, never>;
