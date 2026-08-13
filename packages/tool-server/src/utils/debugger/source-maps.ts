// Only http/https URLs whose host is a loopback name are allowed to be
// fetched by the source-map registry. The legitimate caller is Metro, which
// always emits absolute http://localhost:<port>/<bundle>.map URLs over CDP.
// Anything else (e.g., a malicious app's script setting //# sourceMappingURL
// to http://attacker.example/, or http://169.254.169.254/<cloud-metadata>)
// would otherwise turn the tool-server into a blind fetcher of attacker-
// chosen URLs from the host network.
const ALLOWED_SOURCE_MAP_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function isAllowedSourceMapURL(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  // Metro source-map URLs always end in `.map` (the query string, if any,
  // lives in parsed.search, not pathname). Requiring it shrinks the residual
  // loopback-to-loopback surface: an attacker-set sourceMapURL can at most
  // make us GET a *.map path on a loopback port, not an arbitrary endpoint
  // (e.g. another local dev tool's /shutdown or /json).
  if (!parsed.pathname.endsWith(".map")) return false;
  // Node's URL parser keeps the brackets on IPv6 hostnames ("[::1]"), strip
  // them before consulting the allowlist.
  const hostname =
    parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")
      ? parsed.hostname.slice(1, -1)
      : parsed.hostname;
  return ALLOWED_SOURCE_MAP_HOSTS.has(hostname);
}

// Source-map bodies are buffered into memory before JSON.parse. A malicious
// loopback responder (the residual SSRF target) could otherwise stream an
// unbounded body and OOM the tool-server. 64 MiB is well above any real RN
// bundle's source map (~tens of MiB at most).
const MAX_SOURCE_MAP_BYTES = 64 * 1024 * 1024;

export async function readCappedJson(
  res: { headers: { get(name: string): string | null }; body: unknown; json(): Promise<unknown> },
  maxBytes = MAX_SOURCE_MAP_BYTES
): Promise<unknown> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`source map body too large (content-length ${declared} > ${maxBytes})`);
  }
  const body = res.body as ReadableStream<Uint8Array> | null | undefined;
  if (!body || typeof body.getReader !== "function") {
    // No stream available (e.g. a test stub) — fall back to the plain parse.
    return res.json();
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
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
      chunks.push(value);
    }
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

/**
 * Fetches the source map a `Debugger.scriptParsed` event points at, so that
 * `waitForPending()` gives callers a defined moment when Metro has served every
 * map the session asked for — which is all `debugger-status` reports as
 * `sourceMapReady`.
 *
 * Nothing keeps the parsed map. The registry used to index them for
 * `toGeneratedPosition` / `findMatchingSource`, and both went with the sweep
 * that removed their last callers, so holding a `SourceMapConsumer` per script
 * only retained memory nothing could reach. The fetch itself stays, under the
 * loopback allowlist and the 64 MiB cap above.
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
      // `redirect: "error"` so a loopback URL that passes the allowlist
      // can't 302 us onto an internal/metadata host (the redirect target
      // is never re-validated otherwise). Metro never redirects .map URLs,
      // so this is behaviour-preserving for the legitimate path.
      const res = await fetch(sourceMapURL, { redirect: "error" });
      if (!res.ok) return;
      await readCappedJson(res);
    } catch {
      // Failed to fetch or parse source map — silently skip
    }
  }
}
