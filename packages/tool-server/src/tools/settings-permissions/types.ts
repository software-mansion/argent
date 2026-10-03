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
   * Android only: mapped `android.permission.*` entries that did not take
   * effect — typically not declared in the app's manifest, or not a
   * runtime-changeable permission on this device. When none take effect a
   * `grant` errors instead; a `deny`/`reset` whose every entry is undeclared is
   * already satisfied and returns them all here with an empty `applied`.
   *
   * On Android these are established by reading the package manager's own state
   * back, not by trusting the command's exit status: recent Android accepts a
   * request for a permission an app never declared and does nothing, so an exit
   * code alone would report it as applied.
   */
  skipped?: string[];
  /**
   * Android only: entries reported in `applied` that could NOT be confirmed
   * against the package manager's state — an older device, an unfamiliar dump
   * layout, or a read that failed. They are still listed in `applied`, because
   * the command itself reported success and refusing to believe it would break
   * every device whose state we cannot read; this field exists so the caller can
   * tell "confirmed" from "taken on trust".
   *
   * iOS never sets this: its permission commands fail loudly, so there is no
   * equivalent silent no-op to guard against.
   */
  unverified?: string[];
}

export type SettingsPermissionsServices = Record<string, never>;
