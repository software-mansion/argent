/**
 * Parse a URN into namespace and payload (split on first colon only).
 * Payload may contain colons (e.g. "app:device1:session2" → namespace "app", payload "device1:session2").
 */
export function parseURN(urn: string): { namespace: string; payload: string } {
  const idx = urn.indexOf(":");
  if (idx < 0) {
    throw new Error(`Invalid URN: missing ':' (${urn})`);
  }
  return {
    namespace: urn.slice(0, idx),
    payload: urn.slice(idx + 1),
  };
}
