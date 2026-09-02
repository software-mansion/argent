/**
 * Collapses the two ids that name the same device onto one canonical id, so its
 * debugger service is cached once instead of twice.
 *
 * A caller connects with a stable id from `list-devices` (iOS UDID, Android or
 * Vega serial); Metro's inspector-proxy echoes back an unrelated per-connection
 * `logicalDeviceId`. The service is cached by a URN embedding `device_id`
 * verbatim (`JsRuntimeDebugger:<port>:<device_id>`), and Metro never sees the
 * UDID, so there is nothing to join the two on synchronously. Without an alias,
 * a caller that forwards the returned logicalDeviceId mints a second URN, and so
 * a second CDPClient, console-log server and log file for one device.
 *
 * The alias is learned at connect — the one place both ids are known at once —
 * and read synchronously, so the tools' `services()` callbacks stay synchronous.
 *
 * A logicalDeviceId is unique per Metro connection, so the map is 1:1 and never
 * mis-collapses two devices. A stale entry (reconnect, fresh logicalDeviceId) is
 * harmless: the caller is handed the new id, so the old key is never looked up.
 */
const logicalIdToConnectId = new Map<string, string>();

/**
 * Record that `logicalDeviceId` names the same device as `connectDeviceId`.
 * No-op when the two are equal, or when there is no logicalDeviceId (Vega).
 */
export function rememberDeviceAlias(
  logicalDeviceId: string | undefined,
  connectDeviceId: string
): void {
  if (!logicalDeviceId || logicalDeviceId === connectDeviceId) return;
  logicalIdToConnectId.set(logicalDeviceId, connectDeviceId);
}

/**
 * Rewrite a `device_id` to the id its device was connected with, so a forwarded
 * logicalDeviceId resolves to the already-open debugger instance. Unaliased ids
 * pass through unchanged, so this is safe at every URN-building site.
 */
export function canonicalDeviceId(deviceId: string | undefined): string | undefined {
  if (!deviceId) return deviceId;
  return logicalIdToConnectId.get(deviceId) ?? deviceId;
}

/** Drop a learned alias when its debugger connection is disposed. */
export function forgetDeviceAlias(logicalDeviceId: string | undefined): void {
  if (logicalDeviceId) logicalIdToConnectId.delete(logicalDeviceId);
}

/**
 * Connect ids that ARE a Metro `logicalDeviceId` — the case the alias above has
 * nothing to record, the two ids being one string.
 *
 * It happens once two or more devices share one Metro: `selectTarget` refuses to
 * guess which target a udid or serial means and makes the caller re-target with
 * the logicalDeviceId, so that is what the debugger service ends up keyed by.
 * Nothing joins such an id back to a device, so a teardown scoped to
 * `list-devices` ids cannot reach the session, and the caller's serial still
 * matches that device's other services, so the miss is invisible.
 * `stop-all-simulator-servers` reads this to report it as `left_running`.
 */
const logicalKeyedConnectIds = new Set<string>();

/**
 * Note that `connectDeviceId` is itself the `logicalDeviceId` Metro echoed, so
 * no device-scoped teardown can name the session it keys. No-op otherwise.
 */
export function rememberLogicalKeyedDevice(
  logicalDeviceId: string | undefined,
  connectDeviceId: string
): void {
  if (logicalDeviceId && logicalDeviceId === connectDeviceId) {
    logicalKeyedConnectIds.add(connectDeviceId.toLowerCase());
  }
}

/** Whether `deviceId` keys a session only its logicalDeviceId can address. */
export function isLogicalKeyedDevice(deviceId: string | undefined): boolean {
  return deviceId !== undefined && logicalKeyedConnectIds.has(deviceId.toLowerCase());
}

/** Drop the logical-keyed marker when its debugger connection is disposed. */
export function forgetLogicalKeyedDevice(connectDeviceId: string): void {
  logicalKeyedConnectIds.delete(connectDeviceId.toLowerCase());
}

/** Test-only: clear all learned aliases. */
export function resetDeviceAliases(): void {
  logicalIdToConnectId.clear();
  logicalKeyedConnectIds.clear();
}
