/**
 * Error type raised when the in-process Perfetto trace-processor WASM engine the
 * Android profiler needs can't be loaded or initialized. Distinct from a generic
 * Error so callers (the tool-server analyze path) can branch on it and surface a
 * prominent, actionable banner — instead of folding the failure into the
 * per-query "Export warnings" list, where it would read like a SQL hiccup.
 *
 * Since the engine is now a single ~13 MB `.wasm` vendored into the package (no
 * per-platform binary, no download), this is a rare path: the only ways it fires
 * are a corrupt/missing vendored asset or an `ARGENT_TRACE_PROCESSOR_WASM`
 * override pointing at a bad file.
 */

export type TraceProcessorUnavailableKind = "wasm_load_failed" | "wasm_path_invalid";

export interface TraceProcessorUnavailableDetails {
  /** Pinned Perfetto version the engine is built against, when known. */
  version?: string;
  /** Offending path for the `wasm_path_invalid` case. */
  path?: string;
  /** Underlying error (e.g. an instantiation failure from emscripten). */
  cause?: unknown;
}

function buildMessage(
  kind: TraceProcessorUnavailableKind,
  details: TraceProcessorUnavailableDetails
): string {
  const version = details.version ? ` (Perfetto ${details.version})` : "";
  switch (kind) {
    case "wasm_load_failed": {
      const cause = details.cause instanceof Error ? `: ${details.cause.message}` : "";
      return (
        `The bundled Perfetto trace-processor WASM engine${version} required to ` +
        `analyze Android traces failed to load on this machine${cause}. This usually ` +
        `means the vendored \`trace_processor.wasm\` is missing or corrupt — reinstall ` +
        `Argent, or set ARGENT_TRACE_PROCESSOR_WASM to a known-good trace_processor.wasm.`
      );
    }
    case "wasm_path_invalid":
      return (
        `ARGENT_TRACE_PROCESSOR_WASM is set to "${details.path ?? ""}" but no file was ` +
        `found there. Fix the path or unset it to use the bundled trace_processor.wasm.`
      );
  }
}

export class TraceProcessorUnavailableError extends Error {
  readonly kind: TraceProcessorUnavailableKind;
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
    this.version = details.version;
    this.path = details.path;
    this.cause = details.cause;
    // Restore the prototype chain — `extends Error` + transpilation to ES5/CJS
    // otherwise breaks `instanceof`, which the tool-server analyze path relies on.
    Object.setPrototypeOf(this, TraceProcessorUnavailableError.prototype);
  }
}
