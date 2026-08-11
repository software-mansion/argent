/**
 * Collapses the two ids that name the SAME device onto one canonical id, so the
 * debugger service is cached once instead of twice.
 *
 * A device is reached through two different id namespaces:
 *   - the stable id the caller connects with — an iOS UDID / Android serial /
 *     Vega serial from `list-devices`;
 *   - the `logicalDeviceId` Metro's inspector-proxy echoes back for that
 *     connection, an opaque per-connection handle.
 *
 * These are different strings, and the debugger service is cached by its URN,
 * which embeds `device_id` verbatim (`JsRuntimeDebugger:<port>:<device_id>`).
 * Metro never sees the UDID, so the logicalDeviceId is not derivable from it —
 * there is nothing to join on synchronously. Without an alias, a caller that
 * connects with a UDID and then forwards the returned logicalDeviceId (as the
 * old docs told it to) would mint a second URN, and thus a second CDPClient, a
 * second console-log server, and a split log file, all for one device.
 *
 * The alias is learned as a side effect of a successful connect — the one place
 * both ids are known at once — and consumed synchronously when the next tool
 * builds its service ref. No Metro round-trip on the hot path, so the tools'
 * `services()` callbacks stay synchronous.
 *
 * A logicalDeviceId is unique per Metro connection, so the map is 1:1 and never
 * mis-collapses two distinct devices. A stale entry (device reconnected, Metro
 * issued a fresh logicalDeviceId) is harmless: the caller is handed the new
 * logicalDeviceId, so the old key is simply never looked up again — and it is
 * cleared on dispose anyway.
 */
const logicalIdToConnectId = new Map<string, string>();

/**
 * Record that `logicalDeviceId` names the same device the caller connected with
 * as `connectDeviceId`. No-op when the two are equal (e.g. Chromium, where the
 * logicalDeviceId IS the device id) or when there is no logicalDeviceId (Vega).
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
 * logicalDeviceId resolves to the already-open debugger instance. Unknown ids
 * (the stable connect id itself, Chromium ids, anything not aliased) pass
 * through unchanged, so this is safe to call at every URN-building site.
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
 * nothing to record, because the two ids are the same string.
 *
 * It happens whenever two or more devices share one Metro: `selectTarget`
 * refuses to guess which target a udid or serial means and tells the caller to
 * re-target with the logicalDeviceId, so that is what the debugger service ends
 * up keyed by. Nothing joins such an id back to a device — Metro never sees the
 * udid — so a teardown scoped to `list-devices` ids cannot reach the session,
 * and its serial still matches that device's other services, so the miss is
 * invisible. `stop-all-simulator-servers` reads this to say so.
 *
 * Recorded at connect, which is the only place the two ids are compared, and
 * dropped on dispose alongside the alias.
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
