/**
 * Error type raised when the Perfetto `trace_processor_shell` binary the Android
 * profiler needs can't be located or executed. Distinct from a generic Error so
 * callers (the tool-server analyze path) can branch on it and surface a
 * prominent, actionable banner pointing the user/agent at
 * `argent init --download-dependencies` — instead of folding the failure into
 * the per-query "Export warnings" list, where it reads like a SQL hiccup.
 */

export type TraceProcessorUnavailableKind =
  | "missing"
  | "wrong_arch"
  | "env_path_invalid"
  | "unsupported_platform";

export interface TraceProcessorUnavailableDetails {
  /** Detected host platform tuple (e.g. "linux-amd64"), when known. */
  platform?: string;
  /** Pinned Perfetto version the cache/binary is keyed to, when known. */
  version?: string;
  /** Offending path for the `env_path_invalid` case. */
  path?: string;
  /** Underlying error (e.g. the ENOEXEC from a wrong-arch exec). */
  cause?: unknown;
}

const DOWNLOAD_HINT =
  "Run `argent init --download-dependencies` to fetch the correct " +
  "trace_processor_shell for this machine into the ~/.argent cache " +
  "(or `argent download-deps`).";

function buildMessage(
  kind: TraceProcessorUnavailableKind,
  details: TraceProcessorUnavailableDetails
): string {
  const platform = details.platform ? ` for ${details.platform}` : "";
  const version = details.version ? ` (Perfetto ${details.version})` : "";
  switch (kind) {
    case "missing":
      return (
        `The Perfetto trace_processor_shell binary${platform}${version} required to ` +
        `analyze Android traces is not installed. ${DOWNLOAD_HINT}`
      );
    case "wrong_arch":
      return (
        `The bundled trace_processor_shell binary is built for a different CPU ` +
        `architecture than this host${platform} and cannot run here. ${DOWNLOAD_HINT}`
      );
    case "env_path_invalid":
      return (
        `ARGENT_TRACE_PROCESSOR_PATH is set to "${details.path ?? ""}" but no ` +
        `executable was found there. Fix the path or unset it to use the bundled / ` +
        `downloaded binary.`
      );
    case "unsupported_platform":
      return (
        `The Android profiler's trace_processor_shell is not available for this ` +
        `host platform${platform}. Supported platforms: mac-arm64, mac-amd64, ` +
        `linux-amd64, linux-arm64.`
      );
  }
}

export class TraceProcessorUnavailableError extends Error {
  readonly kind: TraceProcessorUnavailableKind;
  readonly platform?: string;
  readonly version?: string;
  readonly path?: string;
  override readonly cause?: unknown;

  constructor(
    kind: TraceProcessorUnavailableKind,
    details: TraceProcessorUnavailableDetails = {}
  ) {
    super(buildMessage(kind, details));
    this.name = "TraceProcessorUnavailableError";
    this.kind = kind;
    this.platform = details.platform;
    this.version = details.version;
    this.path = details.path;
    this.cause = details.cause;
    // Restore the prototype chain — `extends Error` + transpilation to ES5/CJS
    // otherwise breaks `instanceof`, which the tool-server analyze path relies on.
    Object.setPrototypeOf(this, TraceProcessorUnavailableError.prototype);
  }
}

/**
 * True when an error from `child_process.execFile`/`spawn` indicates the OS
 * refused to exec the binary because it's the wrong architecture/format
 * ("exec format error" / ENOEXEC). This is the signal that a wrong-arch binary
 * (e.g. a Linux ELF shipped to a macOS host) reached the runtime.
 */
export function isExecFormatError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as NodeJS.ErrnoException;
  if (e.code === "ENOEXEC") return true;
  return /exec format error/i.test(String(e.message ?? ""));
}
