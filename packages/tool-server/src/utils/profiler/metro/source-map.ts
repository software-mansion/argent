/**
 * Source map resolution for CPU hotspot de-anonymization.
 *
 * Tries to load source-map-js (CJS, pure JS) then source-map as fallback.
 * Returns null from resolvePosition() if neither package is installed — the
 * caller should treat source location as unavailable and not crash.
 *
 * Usage: call resolvePosition() per anonymous callFrame after stop_profiling.
 */
interface OriginalPosition {
  source: string | null;
  line: number | null;
  column: number | null;
  name: string | null;
}

interface SourceMapConsumerLike {
  originalPositionFor(pos: { line: number; column: number }): OriginalPosition;
}

type SourceMapConsumerCtor = new (rawSourceMap: string | object) => SourceMapConsumerLike;

interface SourceMapLib {
  SourceMapConsumer: SourceMapConsumerCtor;
}

let lib: SourceMapLib | null = null;
let libLoadAttempted = false;

function tryLoadLib(): SourceMapLib | null {
  if (libLoadAttempted) return lib;
  libLoadAttempted = true;
  for (const pkg of ['source-map-js', 'source-map']) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      lib = require(pkg) as SourceMapLib;
      return lib;
    } catch {
      // try next
    }
  }
  return null;
}

// Cache one consumer per sourceMapURL to avoid re-parsing on every call
const consumerCache = new Map<string, SourceMapConsumerLike>();

export async function resolvePosition(
  scriptId: string,
  lineNumber: number,   // 0-based (Hermes callFrame)
  columnNumber: number, // 0-based
  scriptSources: Map<string, { url: string; sourceMapURL: string }>,
  metroBaseUrl: string, // e.g. 'http://localhost:8081'
): Promise<{ source: string; line: number; name: string | null } | null> {
  const loaded = tryLoadLib();
  if (!loaded) return null;

  // Find the source map entry — prefer exact scriptId match, fall back to bundle URL heuristic
  const entry =
    scriptSources.get(scriptId) ??
    [...scriptSources.values()].find((e) => e.url.includes('.bundle'));

  if (!entry?.sourceMapURL) return null;

  const mapUrl = entry.sourceMapURL.startsWith('http')
    ? entry.sourceMapURL
    : `${metroBaseUrl}${entry.sourceMapURL}`;

  let consumer = consumerCache.get(mapUrl);
  if (!consumer) {
    try {
      const resp = await fetch(mapUrl);
      if (!resp.ok) return null;
      const raw: unknown = await resp.json();
      if (typeof raw !== 'object' || raw === null) return null;
      consumer = new loaded.SourceMapConsumer(raw as object);
      consumerCache.set(mapUrl, consumer);
    } catch {
      return null;
    }
  }

  try {
    // source-map-js uses 1-based lines; Hermes callFrame is 0-based
    const pos = consumer.originalPositionFor({ line: lineNumber + 1, column: columnNumber });
    if (!pos.source || pos.line === null) return null;
    return { source: pos.source, line: pos.line, name: pos.name };
  } catch {
    return null;
  }
}

/** Clear the consumer cache (e.g. after a new profiling session starts). */
export function clearSourceMapCache(): void {
  consumerCache.clear();
}
