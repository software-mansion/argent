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

/** Test-only: clear all learned aliases. */
export function resetDeviceAliases(): void {
  logicalIdToConnectId.clear();
}
