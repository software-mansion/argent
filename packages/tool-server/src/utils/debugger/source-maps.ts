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

// Bodies are buffered in memory before JSON.parse, so a malicious loopback
// responder could otherwise OOM the tool-server. 64 MiB is well above any
// real RN bundle's source map.
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
    // No stream (e.g. a test stub) — fall back to the plain parse.
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
    const p = this.doRegister(scriptUrl, scriptId, sourceMapURL);
    this.pendingRegistrations.push(p);
  }

  async waitForPending(): Promise<void> {
    await Promise.allSettled(this.pendingRegistrations);
    this.pendingRegistrations = [];
  }

  private async doRegister(
    scriptUrl: string,
    scriptId: string,
    sourceMapURL: string
  ): Promise<void> {
    try {
      if (sourceMapURL.startsWith("data:")) {
        const base64Part = sourceMapURL.split(",")[1];
        if (!base64Part) return;
        JSON.parse(Buffer.from(base64Part, "base64").toString("utf-8"));
        return;
      }
      if (!isAllowedSourceMapURL(sourceMapURL)) return;
      // The redirect target is never re-validated, so without
      // `redirect: "error"` an allowlisted loopback URL could 302 us onto
      // an internal host. Metro never redirects .map URLs.
      const res = await fetch(sourceMapURL, { redirect: "error" });
      if (!res.ok) return;
      await readCappedJson(res);
    } catch {
      // unusable source map — skip
    }
  }
}
