import { SourceMapConsumer } from "source-map-js";

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

export interface GeneratedPosition {
  scriptUrl: string;
  scriptId: string;
  line1Based: number;
  column0Based: number;
}

interface RegisteredMap {
  scriptUrl: string;
  scriptId: string;
  consumer: SourceMapConsumer;
  sources: string[];
}

export class SourceMapsRegistry {
  private maps: RegisteredMap[] = [];
  private pendingRegistrations: Promise<void>[] = [];
  private projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  /**
   * Begin fetching and registering a source map from a Debugger.scriptParsed event.
   * Returns immediately; `waitForPending()` blocks until all maps are loaded.
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

  /**
   * Resolve an original source file + line to its generated position in the bundle.
   *
   * `filePath` may be project-relative ("src/Foo.tsx"), absolute, or aliased
   * ("/[metro-project]/App.tsx").
   */
  toGeneratedPosition(
    filePath: string,
    line1Based: number,
    column0Based: number = 0
  ): GeneratedPosition | null {
    const candidates = this.buildSourceCandidates(filePath);

    for (const map of this.maps) {
      for (const candidate of candidates) {
        if (!map.sources.some((s) => s === candidate)) continue;

        try {
          const pos = map.consumer.generatedPositionFor({
            source: candidate,
            line: line1Based,
            column: column0Based,
            bias: SourceMapConsumer.LEAST_UPPER_BOUND,
          });
          if (pos.line !== null) {
            return {
              scriptUrl: map.scriptUrl,
              scriptId: map.scriptId,
              line1Based: pos.line,
              column0Based: pos.column ?? 0,
            };
          }
        } catch {
          // try next candidate
        }
      }
    }

    return null;
  }

  /** Matching entry in a registered map's `sources`, or null. */
  findMatchingSource(filePath: string): string | null {
    const candidates = this.buildSourceCandidates(filePath);
    for (const map of this.maps) {
      for (const candidate of candidates) {
        if (map.sources.includes(candidate)) return candidate;
      }
    }
    return null;
  }

  private buildSourceCandidates(filePath: string): string[] {
    const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
    const candidates: string[] = [];

    if (normalized.startsWith("/")) {
      candidates.push(normalized);
    }

    candidates.push(`/[metro-project]/${normalized}`);

    if (this.projectRoot) {
      candidates.push(`${this.projectRoot}/${normalized}`);
    }

    const suffix = normalized.startsWith("/") ? normalized : `/${normalized}`;
    for (const map of this.maps) {
      for (const src of map.sources) {
        if (src.endsWith(suffix) && !candidates.includes(src)) {
          candidates.push(src);
        }
      }
    }

    return candidates;
  }

  private async doRegister(
    scriptUrl: string,
    scriptId: string,
    sourceMapURL: string
  ): Promise<void> {
    try {
      let rawData: unknown;

      if (sourceMapURL.startsWith("data:")) {
        const base64Part = sourceMapURL.split(",")[1];
        if (!base64Part) return;
        const decoded = Buffer.from(base64Part, "base64").toString("utf-8");
        rawData = JSON.parse(decoded);
      } else {
        if (!isAllowedSourceMapURL(sourceMapURL)) return;
        // The redirect target is never re-validated, so without
        // `redirect: "error"` an allowlisted loopback URL could 302 us onto
        // an internal host. Metro never redirects .map URLs.
        const res = await fetch(sourceMapURL, { redirect: "error" });
        if (!res.ok) return;
        rawData = await readCappedJson(res);
      }

      const consumer = new SourceMapConsumer(rawData as any);
      const consumerSources = (consumer as any).sources;
      const rawSources = (rawData as any)?.sources;
      const sources: string[] = Array.isArray(consumerSources)
        ? Array.from(consumerSources)
        : Array.isArray(rawSources)
          ? rawSources.slice()
          : [];

      this.maps.push({ scriptUrl, scriptId, consumer, sources });
    } catch {
      // unusable source map — skip
    }
  }
}
