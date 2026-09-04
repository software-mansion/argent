import type { DescribeNode } from "../describe/contract";

/**
 * The portable subset of a selector the `ui` facade exposes to a script:
 * `text` / `identifier` match as the engine's shared semantics do (see
 * `utils/ui-tree-match`), and `role` values differ per platform (Android
 * class-derived vs iOS AX*), so `text` and `identifier` are the fields that
 * carry across both. The relational / flow-only extensions are deliberately not
 * surfaced — a script expresses those with its own control flow instead.
 */
export interface FacadeSelector {
  text?: string;
  identifier?: string;
  role?: string;
}

export type ScrollDirection = "down" | "up" | "left" | "right";

export interface FacadePoint {
  x: number;
  y: number;
}

/**
 * The device-control surface injected into the run-script child process as the global
 * `ui`. Every method is async and honours the run's deadline: a call made after
 * the deadline (or an external cancel) rejects instead of touching the device.
 * The full typed signature is mirrored in the `argent-device-interact` skill so
 * an authoring agent has it without reading source.
 */
export interface Ui {
  /** The accessibility / DOM tree for the target, same source as `describe`. */
  describe(): Promise<DescribeNode>;
  /** Best-ranked visible match for the selector, or null when none matches. */
  find(selector: FacadeSelector): Promise<DescribeNode | null>;
  /** Every node matching the selector, in tree order. */
  findAll(selector: FacadeSelector): Promise<DescribeNode[]>;
  /** True when the selector matches any node (never throws). */
  exists(selector: FacadeSelector): Promise<boolean>;
  /** True when the selector matches an on-screen (non-zero-area) node. */
  visible(selector: FacadeSelector): Promise<boolean>;
  /** Settle, resolve the selector to a frame, tap its centre, verify an effect. */
  tap(selector: FacadeSelector): Promise<void>;
  /** Raw normalized tap with no settle/verify — the escape hatch. */
  tapPoint(x: number, y: number): Promise<void>;
  /** Tap the field, wait for focus, then type (or paste with `mode:'paste'`). */
  fill(selector: FacadeSelector, text: string, opts?: { mode?: "type" | "paste" }): Promise<void>;
  /** Press a named key (e.g. "enter", "backspace") via the keyboard tool. */
  pressKey(key: string): Promise<void>;
  /** Press a hardware button (e.g. "home", "back") via the button tool. */
  button(name: string): Promise<void>;
  /** Swipe between two normalized points; `momentum:false` by default. */
  swipe(from: FacadePoint, to: FacadePoint, opts?: { durationMs?: number; momentum?: boolean }): Promise<void>;
  /** Swipe repeatedly until the selector is visible or scrolling stops. */
  scrollUntilVisible(
    selector: FacadeSelector,
    opts?: { maxScrolls?: number; direction?: ScrollDirection }
  ): Promise<boolean>;
  /** Wait for a UI condition via await-ui-element; throws if it is not met. */
  await(
    condition: "exists" | "visible" | "hidden" | "text",
    selector: FacadeSelector,
    opts?: { timeoutMs?: number; expectedText?: string; textMatch?: "contains" | "equals" }
  ): Promise<void>;
  /** Wait for the screen to stop changing via await-screen-idle. */
  awaitIdle(opts?: { timeoutMs?: number; minStableMs?: number }): Promise<void>;
  /** Launch an app by bundle id / package name. */
  launchApp(bundleId: string): Promise<void>;
  /** Open a URL or URL scheme on the device. */
  openUrl(url: string): Promise<void>;
  /** Sleep, cancellable by the run's deadline. */
  sleep(ms: number): Promise<void>;
}

export interface RunScriptResult {
  completed: true;
  logs: string;
  steps: number;
  /**
   * Set when the script forwarded a `{{secret:…}}` placeholder to a text-entry
   * step. The MCP auto-capture layer reads it to skip the screenshot and element
   * tree that would otherwise render the resolved secret back into context.
   * Omitted (rather than `false`) when no secret was used.
   */
  secretsUsed?: boolean;
}

/**
 * Raised inside the facade when a sub-tool it invoked failed, so the runtime can
 * classify the run as `RUN_SCRIPT_STEP_FAILED` and name the offending step —
 * distinct from an error the script's own logic threw.
 */
export class StepFailedError extends Error {
  constructor(
    readonly step: string,
    readonly cause: unknown
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`ui.${step} failed: ${detail}`);
    this.name = "StepFailedError";
  }
}

/**
 * Raised inside the facade when the run's deadline signal is already aborted, so
 * no further device work is dispatched once a run has timed out or the client
 * has disconnected.
 */
export class ScriptAbortError extends Error {
  constructor() {
    super("run-script was aborted before the script finished");
    this.name = "ScriptAbortError";
  }
}
