import type { OriginalLocation, GeneratedFrame } from "./source-maps";

/**
 * The slice of `SourceMapsRegistry` log attribution needs.
 *
 * Declared structurally so the log writer stays free of any Metro-specific import: the
 * Chromium debugger builds a `LogFileWriter` with no mapper at all, and tests can supply
 * a plain object.
 */
export interface LogFrameMapper {
  hasMaps(): boolean;
  toOriginalPosition(frame: GeneratedFrame): OriginalLocation | null;
  /** Used to relativise absolute source paths; empty or absent when unknown. */
  readonly projectRoot?: string;
}

interface CallFrame {
  functionName?: string;
  scriptId?: string;
  url?: string;
  lineNumber: number;
  columnNumber: number;
}

interface StackTrace {
  callFrames?: CallFrame[];
}

/**
 * Where a log line came from. The file and line always travel together — a line number
 * with no file is authoritative-looking and useless, which is the failure this module
 * exists to prevent.
 */
export interface LogSource {
  file: string;
  /** 1-based, matching what an editor shows. */
  line: number;
}

// Console calls funnel through several layers of runtime plumbing before reaching app
// code (on React Native: the console polyfill, LogBox, and the devtools hook — see
// the walk below). Past this depth there is only bootstrap, so bound the search.
const MAX_ATTRIBUTION_FRAMES = 16;

// Files whose line numbers refer to something a user can open. HTML documents are
// included because an inline <script>'s frame reports its line within the document.
const SOURCE_EXT = /\.(tsx?|jsx?|mjs|cjs|html?)$/;
const NODE_MODULES = /(^|\/)node_modules\//;
const METRO_PROJECT_ALIAS = "/[metro-project]/";

/**
 * Attribute a console entry to the original source position of the app code that made
 * the call.
 *
 * Taking the top call frame does not work: every `console.*` call on React Native enters
 * through the same polyfill, so the top frame is a constant position inside the runtime
 * for every log ever emitted. Instead each frame is mapped back to its original source
 * and the first frame that is not runtime/third-party code wins.
 *
 * Returns null when nothing can be attributed — an entry with no stack, or one raised
 * entirely inside the runtime with no app frame at all. Callers render that as "unknown";
 * naming a runtime internal would just restate the bug in mapped form.
 *
 * Pure and synchronous: this runs inside the CDP console event handler.
 */
export function attributeLogSource(
  stackTrace: StackTrace | undefined,
  mapper?: LogFrameMapper
): LogSource | null {
  const frames = stackTrace?.callFrames;
  if (!frames || frames.length === 0) return null;

  const limit = Math.min(frames.length, MAX_ATTRIBUTION_FRAMES);

  if (mapper?.hasMaps()) {
    for (let i = 0; i < limit; i++) {
      const frame = frames[i];
      const pos = mapper.toOriginalPosition({
        scriptId: frame.scriptId,
        scriptUrl: frame.url,
        line0Based: frame.lineNumber,
        column0Based: frame.columnNumber,
      });
      // A frame that does not map is skipped, not fatal: lazily loaded chunks can leave
      // individual frames unresolvable while the rest of the stack still maps.
      if (!pos) continue;
      if (isAttributable(pos)) {
        return {
          file: normalizeMapSource(pos.source, mapper.projectRoot),
          line: pos.line1Based,
        };
      }
    }
    // Every mapped frame was runtime or third-party code. Fall through to the URL path,
    // which will also come up empty for a bundle URL — deliberately: there is no app
    // frame to point at.
  }

  return fromFrameUrl(frames[0]);
}

/**
 * Whether a mapped frame is the app's own code.
 *
 * When the map publishes an ignore list, it is authoritative — bundlers mark their own
 * runtime, polyfills and dependencies, so no hand-maintained list of framework internals
 * is needed. Without one, fall back to the convention every debugger uses: code under
 * `node_modules` is third-party.
 */
function isAttributable(pos: OriginalLocation): boolean {
  if (pos.ignoreListAvailable) return !pos.ignoreListed;
  return !NODE_MODULES.test(pos.source);
}

/** Legacy attribution for runtimes with no source map: read the frame's own script URL. */
function fromFrameUrl(frame: CallFrame): LogSource | null {
  const file = frame.url ? cleanSourceUrl(frame.url) : null;
  if (file === null) return null;
  // CDP line numbers are 0-based; report the 1-based line an editor shows.
  return { file, line: frame.lineNumber + 1 };
}

/**
 * A script URL reduced to a project-relative source path, or null when it does not name
 * one.
 *
 * Bundle URLs are rejected on purpose. Their line numbers refer to generated output, so
 * pairing one with a filename produces a plausible-looking reference to a position that
 * does not exist in any file the user can open.
 */
export function cleanSourceUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!SOURCE_EXT.test(parsed.pathname)) return null;
    // A served script's path is relative to the server root, so the leading slash is
    // noise. A file:// path is absolute on disk and needs its leading slash to resolve.
    return parsed.protocol === "file:"
      ? decodeURIComponent(parsed.pathname)
      : parsed.pathname.replace(/^\//, "");
  } catch {
    return null;
  }
}

/**
 * Reduce a source map `sources` entry to the path a user can act on.
 *
 * Metro emits either its `/[metro-project]/` alias or absolute host paths depending on
 * bundle configuration, so both are handled. A path that matches neither is left exactly
 * as-is: an unrecognised absolute path is still openable, whereas one with its leading
 * slash stripped resolves nowhere.
 */
export function normalizeMapSource(source: string, projectRoot?: string): string {
  if (source.startsWith(METRO_PROJECT_ALIAS)) {
    return source.slice(METRO_PROJECT_ALIAS.length);
  }
  if (projectRoot) {
    const prefix = projectRoot.endsWith("/") ? projectRoot : `${projectRoot}/`;
    if (source.startsWith(prefix)) return source.slice(prefix.length);
  }
  if (source.startsWith("file://")) {
    try {
      return new URL(source).pathname;
    } catch {
      return source;
    }
  }
  return source;
}

/** The `<source>` column of a flat log line: `path:line`, or `-` when unattributed. */
export function toFlatSourceToken(source: LogSource | null): string {
  return source ? `${source.file}:${source.line}` : "-";
}
