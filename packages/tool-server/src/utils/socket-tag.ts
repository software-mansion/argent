import { createHash } from "node:crypto";

/**
 * The per-device part of a `/tmp/<prefix>-<tag>.sock` path.
 *
 * A plain UDID gives its first 8 characters. Any other id, such as an external
 * provider's `ext:<provider>:<udid>`, gives 12 hex characters of its SHA-256:
 * the first 8 characters of such an id are `ext:` plus the first 4 of the
 * provider id, the same for every device of that provider and of any provider
 * whose id starts the same way. The hash keeps the path short (macOS
 * caps `sun_path` at 104 bytes) and can never equal an 8-character UDID tag.
 */
export function socketTag(deviceId: string): string {
  if (/^[A-Za-z0-9-]+$/.test(deviceId)) return deviceId.slice(0, 8);
  return createHash("sha256").update(deviceId).digest("hex").slice(0, 12);
}

/** The Unix socket the ax-service daemon of a device listens on. */
export function axServiceSocketPath(deviceId: string): string {
  return `/tmp/ax-${socketTag(deviceId)}.sock`;
}

/**
 * The Unix socket the native-devtools library of a device connects to. At most
 * 32 characters, well under the 104-byte macOS limit.
 */
export function nativeDevtoolsSocketPath(deviceId: string): string {
  return `/tmp/argent-nd-${socketTag(deviceId)}.sock`;
}
