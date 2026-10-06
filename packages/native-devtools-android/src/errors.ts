/**
 * Raised when the in-process Perfetto trace-processor WASM engine can't be
 * loaded. Distinct from a generic Error so the tool-server analyze path can
 * branch on it and render a prominent banner, instead of folding the failure
 * into the per-query "Export warnings" list.
 */

export type TraceProcessorUnavailableKind = "wasm_load_failed" | "wasm_path_invalid";

export interface TraceProcessorUnavailableDetails {
  /** Perfetto version of the engine, when known. */
  version?: string;
  /** Offending path for the `wasm_path_invalid` case. */
  path?: string;
  /** Underlying failure that was wrapped. */
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

  constructor(kind: TraceProcessorUnavailableKind, details: TraceProcessorUnavailableDetails = {}) {
    super(buildMessage(kind, details));
    this.name = "TraceProcessorUnavailableError";
    this.kind = kind;
    this.version = details.version;
    this.path = details.path;
    this.cause = details.cause;
    Object.setPrototypeOf(this, TraceProcessorUnavailableError.prototype);
  }
}
