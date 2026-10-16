import { createHash } from "node:crypto";

/**
 * The per-device part of a `/tmp/<prefix>-<tag>.sock` path.
 *
 * A plain UDID keeps its first 8 characters, the name these sockets have
 * always had. Any other id (an external provider's `ext:<provider>:<udid>`)
 * would collapse to its shared prefix that way, so every device of a provider
 * got one socket; it gets 12 hex characters of its SHA-256 instead, which
 * keeps the path short (macOS caps `sun_path` at 104 bytes) and can never
 * equal an 8-character UDID tag.
 */
export function socketTag(deviceId: string): string {
  if (/^[A-Za-z0-9-]+$/.test(deviceId)) return deviceId.slice(0, 8);
  return createHash("sha256").update(deviceId).digest("hex").slice(0, 12);
}
