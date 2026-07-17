/**
 * A bounded settle window ended without a single successful read from the
 * flow's full-hierarchy tree source.
 *
 * Snapshots may handle this one failure specially because they can establish
 * stability from pixels alone. Other settling failures must continue to
 * propagate: treating an arbitrary exception as a tree outage could let a
 * snapshot pass (or update a baseline) after an internal bug.
 */
export class FlowTreeSourceUnavailableError extends Error {
  constructor(source: Error) {
    // Keep the source message as the top-level message so existing flow reports
    // remain actionable, and retain the complete original error/cause chain.
    super(source.message, { cause: source });
    this.name = "FlowTreeSourceUnavailableError";

    // Registry/tool failures can carry structured fields such as status codes
    // and failure details. Preserve those own properties on the typed wrapper
    // as well as on `cause`, without replacing the wrapper's identity/stack.
    for (const key of Reflect.ownKeys(source)) {
      if (key === "name" || key === "message" || key === "stack" || key === "cause") continue;
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      if (descriptor) Object.defineProperty(this, key, descriptor);
    }
  }
}
