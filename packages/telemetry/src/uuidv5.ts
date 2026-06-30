import * as crypto from "node:crypto";

// Node's crypto.randomUUID() is v4-only; there is no native v5. This is a tiny
// RFC 4122 §4.3 implementation (name-based, SHA-1) so we can derive a stable,
// deterministic UUID from the host fingerprint without pulling in the `uuid`
// package. Argument order mirrors the `uuid` package's `v5(name, namespace)`.

function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32 || /[^0-9a-fA-F]/.test(hex)) {
    throw new Error(`uuidv5: invalid namespace UUID "${uuid}"`);
  }
  return Buffer.from(hex, "hex");
}

function bytesToUuid(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  );
}

/**
 * RFC 4122 v5 (SHA-1, name-based) UUID. Deterministic: the same
 * (name, namespace) always yields the same UUID. `namespace` must be a UUID
 * string; `name` is hashed as UTF-8 bytes.
 */
export function uuidv5(name: string, namespace: string): string {
  const namespaceBytes = uuidToBytes(namespace);
  const nameBytes = Buffer.from(name, "utf8");

  const hash = crypto.createHash("sha1").update(namespaceBytes).update(nameBytes).digest();

  // Take the first 16 bytes; stamp the version (5) and RFC 4122 variant bits.
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx

  return bytesToUuid(bytes);
}
