import { SourceMapConsumer } from "source-map-js";

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

export interface GeneratedPosition {
  scriptUrl: string;
  scriptId: string;
  line1Based: number;
  column0Based: number;
}

/**
 * A position in an original source file, resolved from a generated (bundle) position.
 *
 * `ignoreListed` reports whether the owning map's ignore list marks this source as
 * third-party/runtime code. `ignoreListAvailable` distinguishes "the map declares no
 * ignore list at all" from "the map declares one and this source is not on it" —
 * callers pick a different policy for the two, so it must not be inferred from
 * `ignoreListed === false`.
 */
export interface OriginalLocation {
  source: string;
  line1Based: number;
  column0Based: number;
  name: string | null;
  ignoreListed: boolean;
  ignoreListAvailable: boolean;
}

export interface GeneratedFrame {
  scriptId?: string;
  scriptUrl?: string;
  /** CDP `Runtime.CallFrame.lineNumber` — 0-based. */
  line0Based: number;
  /** CDP `Runtime.CallFrame.columnNumber` — 0-based. */
  column0Based: number;
}

interface RegisteredMap {
  scriptUrl: string;
  scriptId: string;
  consumer: SourceMapConsumer;
  sources: string[];
  /**
   * Sources the map's ignore list marks as third-party, as resolved source strings
   * (the same form `originalPositionFor` returns). Empty when `hasIgnoreList` is false.
   */
  ignoreListedSources: Set<string>;
  hasIgnoreList: boolean;
}

// Parsing a map's mappings is lazy in source-map-js, but once paid it retains both the
// generated and original mapping arrays — on a large Metro bundle that is ~90 MB per map.
// Registrations accumulate across Fast Refresh reloads and lazy chunk loads, so keep only
// the most recent few; evicted maps are dropped so their consumers can be collected.
// Lookups miss for evicted scripts, which degrades to the caller's unmapped fallback.
const MAX_REGISTERED_MAPS = 4;

export class SourceMapsRegistry {
  private maps: RegisteredMap[] = [];
  private pendingRegistrations: Promise<void>[] = [];
  /** Empty on runtimes that report no project root (legacy Metro, Vega). */
  readonly projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  /**
   * Begin fetching and registering a source map from a Debugger.scriptParsed event.
   * Returns immediately; use `waitForPending()` to block until all maps are loaded.
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
   * `filePath` can be:
   *   - relative to project root, e.g. "App.tsx" or "src/components/Foo.tsx"
   *   - absolute, e.g. "/Users/.../App.tsx"
   *   - aliased, e.g. "/[metro-project]/App.tsx"
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

  /** True once at least one source map has been registered. O(1) guard for hot paths. */
  hasMaps(): boolean {
    return this.maps.length > 0;
  }

  /**
   * Resolve a generated (bundle) position back to its original source position.
   *
   * The inverse direction of `toGeneratedPosition`. Returns null when no registered map
   * owns the frame's script, or when the map has no mapping for that position — callers
   * must treat null as "unknown" and fall back, never as "line 0".
   */
  toOriginalPosition(frame: GeneratedFrame): OriginalLocation | null {
    const map = this.selectMap(frame.scriptId, frame.scriptUrl);
    if (!map) return null;

    try {
      // CDP lines are 0-based; source-map generated lines are 1-based.
      const line = frame.line0Based + 1;
      let pos = map.consumer.originalPositionFor({
        line,
        column: frame.column0Based,
      });
      if (pos.source === null || pos.line === null) {
        // The default (greatest-lower-bound) search finds nothing when the reported
        // column precedes the first mapping on that line — which is the common case for
        // indented bundle output. Retry upwards before giving up; the consumer still
        // refuses to cross onto a different generated line, so this cannot silently
        // attribute to a neighbouring statement.
        pos = map.consumer.originalPositionFor({
          line,
          column: frame.column0Based,
          bias: SourceMapConsumer.LEAST_UPPER_BOUND,
        });
      }
      if (pos.source === null || pos.line === null) return null;

      return {
        source: pos.source,
        line1Based: pos.line,
        column0Based: pos.column ?? 0,
        name: pos.name ?? null,
        ignoreListed: map.ignoreListedSources.has(pos.source),
        ignoreListAvailable: map.hasIgnoreList,
      };
    } catch {
      // Runs on the CDP event path — never throw into the caller's event handler.
      return null;
    }
  }

  /**
   * Pick the registered map that owns a frame's script.
   *
   * Newest-first so a bundle re-registered after a reload wins over its predecessor.
   * Returns null rather than guessing: attributing a frame against some *other* script's
   * map yields a real-looking file and line that is simply wrong, which is worse than
   * reporting nothing.
   */
  private selectMap(scriptId?: string, scriptUrl?: string): RegisteredMap | null {
    for (let i = this.maps.length - 1; i >= 0; i--) {
      if (scriptId && this.maps[i].scriptId === scriptId) return this.maps[i];
    }
    if (!scriptUrl) return null;
    for (let i = this.maps.length - 1; i >= 0; i--) {
      if (this.maps[i].scriptUrl === scriptUrl) return this.maps[i];
    }
    // Covers bundlers that version a script via its query string. Metro is not one of
    // them — it appends its parameters to the path, so its URLs match exactly above.
    const bare = stripUrlQuery(scriptUrl);
    if (!bare) return null;
    for (let i = this.maps.length - 1; i >= 0; i--) {
      if (stripUrlQuery(this.maps[i].scriptUrl) === bare) return this.maps[i];
    }
    return null;
  }

  /**
   * Find which source map source path matches the given file path.
   * Returns the matched source string or null.
   */
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

    // If already aliased or absolute, try as-is first
    if (normalized.startsWith("/")) {
      candidates.push(normalized);
    }

    // Aliased: /[metro-project]/path
    candidates.push(`/[metro-project]/${normalized}`);

    // Absolute: projectRoot/path
    if (this.projectRoot) {
      candidates.push(`${this.projectRoot}/${normalized}`);
    }

    // Try suffix matching as last resort: find any source ending with /filePath
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
        // `redirect: "error"` so a loopback URL that passes the allowlist
        // can't 302 us onto an internal/metadata host (the redirect target
        // is never re-validated otherwise). Metro never redirects .map URLs,
        // so this is behaviour-preserving for the legitimate path.
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

      const { ignoreListedSources, hasIgnoreList } = buildIgnoreList(rawData, sources);

      this.maps.push({
        scriptUrl,
        scriptId,
        consumer,
        sources,
        ignoreListedSources,
        hasIgnoreList,
      });
      if (this.maps.length > MAX_REGISTERED_MAPS) {
        this.maps.splice(0, this.maps.length - MAX_REGISTERED_MAPS);
      }
    } catch {
      // Failed to fetch or parse source map — silently skip
    }
  }
}

/** Same URL with the query string and fragment removed, or null if it does not parse. */
function stripUrlQuery(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}

/**
 * Resolve a source map's ignore list (the standard `x_google_ignoreList`, or the
 * `ignoreList` spelling the spec settled on) into the set of source strings it marks as
 * third-party — the same strings `originalPositionFor` returns, so membership is a plain
 * lookup.
 *
 * `sources` may contain duplicates, and normalisation can collapse two raw entries onto
 * one string. When that happens an ignore-listed index and a non-ignore-listed index can
 * share a name; subtracting the non-ignore-listed strings makes that case fail *open*
 * (the frame stays attributable) rather than silently hiding real app code.
 *
 * Never throws: source maps are fetched from the app's own runtime and are untrusted input.
 */
function buildIgnoreList(
  rawData: unknown,
  sources: string[]
): { ignoreListedSources: Set<string>; hasIgnoreList: boolean } {
  const empty = { ignoreListedSources: new Set<string>(), hasIgnoreList: false };
  const raw = rawData as Record<string, unknown> | null | undefined;
  if (!raw || typeof raw !== "object") return empty;

  // Sectioned (indexed) maps carry their sources per section, so indices into a flat
  // `sources` array are meaningless. Treat them as declaring no ignore list.
  if (Array.isArray(raw.sections)) return empty;

  const list = Array.isArray(raw.x_google_ignoreList)
    ? raw.x_google_ignoreList
    : Array.isArray(raw.ignoreList)
      ? raw.ignoreList
      : null;
  if (!list) return empty;

  const ignored = new Set<string>();
  const kept = new Set<string>();
  const ignoredIndices = new Set<number>();
  for (const entry of list) {
    if (typeof entry !== "number" || !Number.isInteger(entry)) continue;
    if (entry < 0 || entry >= sources.length) continue;
    ignoredIndices.add(entry);
    ignored.add(sources[entry]);
  }
  for (let i = 0; i < sources.length; i++) {
    if (!ignoredIndices.has(i)) kept.add(sources[i]);
  }
  for (const name of kept) ignored.delete(name);

  return { ignoreListedSources: ignored, hasIgnoreList: true };
}
