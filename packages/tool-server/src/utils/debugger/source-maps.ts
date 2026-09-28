// SSRF guard: an attacker-set //# sourceMappingURL must not turn the
// tool-server into a fetcher of arbitrary host-network URLs. Metro, the only
// legitimate caller, emits http://localhost:<port>/<bundle>.map over CDP.
const ALLOWED_SOURCE_MAP_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function isAllowedSourceMapURL(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  // Metro source-map URLs always end in `.map`; requiring it keeps an
  // attacker-set sourceMapURL off other loopback endpoints (/shutdown, /json).
  if (!parsed.pathname.endsWith(".map")) return false;
  // Node's URL parser keeps the brackets on IPv6 hostnames ("[::1]").
  const hostname =
    parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")
      ? parsed.hostname.slice(1, -1)
      : parsed.hostname;
  return ALLOWED_SOURCE_MAP_HOSTS.has(hostname);
}

// How many bytes of a source map this will sit through. A malicious loopback
// responder could otherwise stream an unbounded body and hold
// `waitForPending()` — and with it `debugger-connect` — open for as long as it
// keeps writing. 64 MiB is well above any real RN bundle's source map.
const MAX_SOURCE_MAP_BYTES = 64 * 1024 * 1024;

/**
 * Read a source-map response to completion under a byte cap, and throw the
 * bytes away.
 *
 * They are read rather than dropped unread because `waitForPending()` is only
 * a meaningful moment if the body has finished arriving. They are not parsed,
 * and not even accumulated, because nothing consumes a map any more (see
 * `SourceMapsRegistry` below) — counting the chunks is all the cap needs.
 * Measured against a loopback responder, three runs each: 9.2 ms to buffer and
 * parse a 9.4 MB map against 4.8 ms to drain it, and 64 ms against 22 ms at
 * 59 MB. That is spent inside the wait every `debugger-status` blocks on.
 */
export async function drainCappedBody(
  res: { headers: { get(name: string): string | null }; body: unknown },
  maxBytes = MAX_SOURCE_MAP_BYTES
): Promise<void> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`source map body too large (content-length ${declared} > ${maxBytes})`);
  }
  const body = res.body as ReadableStream<Uint8Array> | null | undefined;
  // No stream (a bodiless response, or a test stub) — nothing to wait for.
  if (!body || typeof body.getReader !== "function") return;
  const reader = body.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`source map body exceeded ${maxBytes} bytes`);
      }
    }
  }
}

/**
 * Fetches the source map a `Debugger.scriptParsed` event points at, so that
 * `waitForPending()` gives callers a defined moment: every fetch this session
 * started has settled. That is what `debugger-status` reports as
 * `sourceMapReady`, and it is weaker than it sounds — a map Metro answered 404
 * for has settled, and a `data:` or allowlist-rejected URL settles without a
 * fetch at all, so `sourceMapReady` is true in all three cases. The tool's own
 * description says as much ("always true").
 *
 * Nothing keeps the map, parsed or raw. The registry used to index them for
 * `toGeneratedPosition` / `findMatchingSource`, and both went with the sweep
 * that removed their last callers, so holding a `SourceMapConsumer` per script
 * only retained memory nothing could reach. The fetch itself stays, under the
 * loopback allowlist and the 64 MiB cap above; its body is drained, not read.
 */
export class SourceMapsRegistry {
  private pendingRegistrations: Promise<void>[] = [];

  /**
   * Begin fetching the source map a Debugger.scriptParsed event points at.
   * Takes the whole event shape, though only the URL is read now. Returns
   * immediately; use `waitForPending()` to block until every fetch has settled.
   */
  registerFromScriptParsed(
    scriptUrl: string,
    scriptId: string,
    sourceMapURL: string | undefined
  ): void {
    if (!sourceMapURL) return;
    const p = this.doRegister(sourceMapURL);
    this.pendingRegistrations.push(p);
  }

  async waitForPending(): Promise<void> {
    await Promise.allSettled(this.pendingRegistrations);
    this.pendingRegistrations = [];
  }

  private async doRegister(sourceMapURL: string): Promise<void> {
    try {
      // An inline `data:` map carries its payload in the URL. There is no fetch
      // to wait for and no allowlist to apply, so this returns at once. Decoding
      // and parsing it kept nothing: the result was discarded, this `catch`
      // swallowed any throw, and a malformed payload reached the same return as
      // a well-formed one. The only cost was time inside `waitForPending()`,
      // which `debugger-connect` and every `debugger-status` block on — ~25 ms
      // for a 20 MiB map, and with no size cap, unlike the fetch below.
      //
      // This test belongs INSIDE the `try`, and it is the first thing to touch
      // `sourceMapURL`. The value is a bare cast over socket JSON — `params
      // .sourceMapURL as string | undefined` in `cdp-client.ts`, forwarded
      // unchecked — and `registerFromScriptParsed` only rejects falsy, so a CDP
      // peer that sends a number reaches `.startsWith` and throws. In here that
      // is skipped like any other malformed map. Outside, the throw escapes as
      // a rejected promise nothing awaits before the next tick, which
      // `index.ts` turns into `crashShutdown` — the whole tool-server and every
      // device session it owns, for one bad field.
      if (sourceMapURL.startsWith("data:")) return;
      if (!isAllowedSourceMapURL(sourceMapURL)) return;
      // The redirect target is never re-validated, so without
      // `redirect: "error"` an allowlisted loopback URL could 302 us onto
      // an internal host. Metro never redirects .map URLs.
      const res = await fetch(sourceMapURL, { redirect: "error" });
      if (!res.ok) return;
      await drainCappedBody(res);
    } catch {
      // unusable source map — skip
    }
  }
}
