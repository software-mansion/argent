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
   * The platform-level identifiers the action was actually applied to: the
   * `simctl privacy` service(s) on iOS, the `android.permission.*` names on
   * Android. Lets the caller see exactly what changed — one abstract
   * permission can fan out to several concrete ones on either platform
   * (fine/coarse location and per-media reads on Android; `photos` +
   * best-effort `photos-add` on iOS, where a secondary service the runtime
   * doesn't model is simply absent from this list rather than an error).
   */
  applied: string[];
  /**
   * Android only: mapped `android.permission.*` entries the package manager
   * rejected (typically not declared in the app's manifest, or gated by the
   * device's API level). Present only when at least one other mapped
   * permission succeeded — if all of them fail, the tool errors instead.
   */
  skipped?: string[];
}

export type SettingsPermissionsServices = Record<string, never>;
