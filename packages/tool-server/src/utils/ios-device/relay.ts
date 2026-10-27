import { externalClaimForAnyId, externalNativeId } from "../external-devices";

/**
 * A physical iPhone reached through someone else's usbmuxd.
 *
 * A device provider (another Mac, a shared device pool) can offer a phone that
 * is cabled elsewhere by relaying its usbmuxd socket to a local endpoint and
 * declaring it with the `usbmuxd` capability. Everything Argent does on the
 * phone then goes through that endpoint: lockdown and the on-device runner over
 * the usbmux protocol, app install and launch over go-ios, which speaks the
 * same protocol. CoreDevice (`devicectl`) never sees such a phone, so nothing
 * on this path may call it.
 */
export interface IosRelay {
  /** The phone's hardware UDID, as usbmuxd reports it. */
  udid: string;
  /** `host:port` or an absolute unix socket path; see the provider contract. */
  endpoint: string;
  /** Who offered the phone, for error messages. */
  providerName: string;
}

/**
 * The relay behind `id`, under either of its spellings (the `ext:` id or the
 * raw UDID), or `undefined` for a phone on this Mac's own usbmuxd.
 *
 * Re-reads the provider's file every time, like every other claim lookup, so a
 * withdrawn phone is noticed on the next call rather than after a cache window.
 */
export function iosRelayFor(id: string): IosRelay | undefined {
  const claim = externalClaimForAnyId(id);

  if (!claim || claim.platform !== "ios" || !claim.usbmuxd) {
    return undefined;
  }

  if (!claim.capabilities.has("usbmuxd")) {
    return undefined;
  }

  return {
    udid: externalNativeId(id),
    endpoint: claim.usbmuxd,
    providerName: claim.provider.name,
  };
}

/** True when `id` names a relayed phone. */
export function isRelayedIosDevice(id: string): boolean {
  return iosRelayFor(id) !== undefined;
}

/** A usbmuxd endpoint as `net.connect` wants it. */
export type UsbmuxTarget = { path: string } | { host: string; port: number };

/**
 * Split a usbmuxd endpoint into a unix socket path or a TCP host and port.
 * The provider contract validated the shape; this only reads it.
 */
export function parseUsbmuxEndpoint(endpoint: string): UsbmuxTarget {
  if (endpoint.startsWith("/")) {
    return { path: endpoint };
  }

  const separator = endpoint.lastIndexOf(":");
  const host = endpoint.slice(0, separator);
  const port = Number.parseInt(endpoint.slice(separator + 1), 10);

  return {
    host: host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host,
    port,
  };
}
