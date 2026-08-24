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
   * Android only: mapped `android.permission.*` entries that did not take
   * effect — typically not declared in the app's manifest, or not a
   * runtime-changeable permission on this device. Present only when at least
   * one other mapped permission succeeded.
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
