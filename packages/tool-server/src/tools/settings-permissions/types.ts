export const PERMISSION_ACTIONS = ["grant", "deny", "reset"] as const;

export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

export const PERMISSION_NAMES = [
  "camera",
  "microphone",
  "photos",
  "contacts",
  "notifications",
  "calendar",
  "location",
  "location-always",
  "media-library",
  "motion",
  "reminders",
] as const;

export type PermissionName = (typeof PERMISSION_NAMES)[number];

export interface SettingsPermissionsParams {
  udid: string;
  action: PermissionAction;
  permission: PermissionName;
  bundleId: string;
}

export interface SettingsPermissionsResult {
  action: PermissionAction;
  permission: PermissionName;
  bundleId: string;
  /**
   * Platform-level ids actually changed: `simctl privacy` services on iOS,
   * `android.permission.*` names on Android. One tool permission can fan out to
   * several; an iOS secondary service the runtime doesn't model is absent here
   * rather than an error.
   */
  applied: string[];
  /**
   * Android only: mapped `android.permission.*` entries the package manager
   * rejected (undeclared in the manifest, or gated by API level). Absent when
   * all of them fail — the tool errors instead.
   */
  skipped?: string[];
}

export type SettingsPermissionsServices = Record<string, never>;
