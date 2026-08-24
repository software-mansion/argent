/** Splits on the first colon only; the payload keeps any remaining colons. */
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
