/**
 * Tool-call event bus for the preview UI.
 *
 * Emits rich, replayable events around every `/tools/:name` invocation so the
 * preview overlay can visualize what the agent is doing in real time. Kept
 * separate from the registry's own `toolInvoked`/`toolCompleted` events
 * because those don't carry args or results — and because subscribing to
 * the bus from a long-lived SSE stream shouldn't risk leaking listeners
 * onto the registry itself.
 */

export type ActionPhase = "start" | "end" | "error";

export interface ActionEvent {
  /** Unique id for this invocation (matches across start/end/error). */
  id: string;
  /** Tool name, e.g. "gesture-tap". */
  name: string;
  phase: ActionPhase;
  /** Wall-clock timestamp in ms since epoch. */
  ts: number;
  /** Present on "start". The validated params passed to the tool. */
  args?: unknown;
  /** Present on "end". May be large — UI is responsible for trimming. */
  result?: unknown;
  /** Present on "error". A short, human-readable message. */
  error?: string;
  /** Present on "end" and "error". Milliseconds from start to end. */
  durationMs?: number;
}

export type ActionListener = (event: ActionEvent) => void;

export class ActionEventBus {
  private listeners = new Set<ActionListener>();
  private nextId = 1;

  /** Returns a fresh invocation id. Monotonic per-process. */
  newId(): string {
    return `${Date.now().toString(36)}-${(this.nextId++).toString(36)}`;
  }

  publish(event: ActionEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // A bad listener must not break sibling subscribers or the request path.
      }
    }
  }

  subscribe(listener: ActionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}
