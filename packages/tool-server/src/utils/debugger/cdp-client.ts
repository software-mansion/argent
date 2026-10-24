import WebSocket from "ws";
import {
  FAILURE_CODES,
  FailureError,
  TypedEventEmitter,
  failureSignal,
  getFailureSignal,
  type FailureCode,
  type FailureKind,
} from "@argent/registry";
import * as crypto from "node:crypto";
import { sleep } from "../timing";
import {
  readBoxError,
  readBoxValue,
  readIfNotThenable,
  watchThenable,
  type RemoteVerdict,
  type SettleBox,
} from "./scripts/evaluate-awaited";

export interface ScriptInfo {
  scriptId: string;
  url: string;
  sourceMapURL?: string;
  startLine: number;
  endLine: number;
}

interface ConsoleCallArg {
  type: string;
  value?: unknown;
  description?: string;
  className?: string;
}

export interface ConsoleAPICalledParams {
  type: string;
  args: ConsoleCallArg[];
  timestamp: number;
  stackTrace?: Record<string, unknown>;
}

export type CDPClientEvents = {
  connected: () => void;
  disconnected: (error?: Error) => void;
  event: (method: string, params: Record<string, unknown>) => void;
  bindingCalled: (name: string, payload: string) => void;
  scriptParsed: (script: ScriptInfo) => void;
  paused: (params: Record<string, unknown>) => void;
  resumed: () => void;
  consoleAPICalled: (params: ConsoleAPICalledParams) => void;
};

/**
 * Where a `Debugger.paused` stopped the runtime, reduced to what an error needs.
 */
interface PausedState {
  /** First call frame's source location, when the event carried one. */
  location?: string;
  /** CDP's own word for why: `other` for a breakpoint, `exception`, … */
  reason: string;
}

/**
 * Methods that need the VM running. Everything else is answered while paused,
 * including `Debugger.resume`, so guarding more would break the calls that
 * recover the session.
 */
const BLOCKED_WHILE_PAUSED = new Set(["Runtime.evaluate", "Runtime.callFunctionOn"]);

/**
 * Drop the build configuration Metro appends to a bundle url, about 150
 * characters of `platform`, `dev` and `transform.*` that help nobody find
 * where their app stopped. Keeps the original if trimming leaves nothing.
 */
function trimBundleQuery(url: string): string {
  const trimmed = url.split(/[?&]/)[0]!.replace(/\/+$/, "");
  return trimmed || url;
}

interface CDPExceptionDetails {
  text?: string;
  exception?: { description?: string; value?: unknown };
  stackTrace?: {
    callFrames: Array<{
      functionName: string;
      url: string;
      lineNumber: number;
      columnNumber: number;
    }>;
  };
  lineNumber?: number;
  columnNumber?: number;
  url?: string;
}

function formatExceptionDetails(details: CDPExceptionDetails): string {
  const description =
    details.exception?.description ?? details.text ?? "Script evaluation threw an exception";

  // Append the CDP call frames only when the description lacks its own stack.
  if (description.includes("\n    at ") || description.includes("\n  at ")) {
    return description;
  }

  const frames = details.stackTrace?.callFrames ?? [];
  if (frames.length === 0) return description;

  const frameLines = frames
    .map((f) => {
      const loc = `${f.url || "<anonymous>"}:${f.lineNumber + 1}:${f.columnNumber + 1}`;
      return `  at ${f.functionName || "<anonymous>"} (${loc})`;
    })
    .join("\n");

  return `${description}\n${frameLines}`;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingBinding {
  resolve: (data: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

interface RemoteObjectLike {
  type?: string;
  subtype?: string;
  className?: string;
  objectId?: string;
  value?: unknown;
  description?: string;
}

interface RemoteResult {
  result?: RemoteObjectLike;
  exceptionDetails?: CDPExceptionDetails;
}

const PROMISE_POLL_INTERVAL_MS = 50;
/**
 * How long one poll waits for its answer. The legacy Hermes inspector (Vega)
 * can leave a `Runtime.getProperties` unanswered until some evaluate reaches
 * the runtime, so a poll that times out is nudged and repeated, not fatal.
 */
const POLL_REQUEST_TIMEOUT_MS = 1000;
/**
 * The least budget a read after the expression ran gets, so a Promise that
 * settles at the deadline is still read instead of reported as unsettled.
 */
const READ_GRACE_MS = 2000;

function evaluateError(
  message: string,
  errorCode: FailureCode,
  errorKind: FailureKind = "unknown",
  cause?: Error
): FailureError {
  return new FailureError(
    message,
    failureSignal(errorCode, "debugger_cdp_evaluate", "tool_server", errorKind),
    { cause }
  );
}

/** The expression ran; only the wait for its Promise was given up. */
function unsettled(timeout: number): FailureError {
  return evaluateError(
    `The expression ran, but the Promise it returned did not settle within ${timeout}ms. ` +
      `Do not run it again for its side effects; to skip the wait, evaluate ` +
      "`void (<expression>)` instead.",
    FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT,
    "timeout"
  );
}

/** A value with no JSON form; the call must not look like it returned one. */
function unserializable(kind: string): FailureError {
  return evaluateError(
    `The expression's result is a ${kind}, which has no JSON form. Return a value ` +
      `(for a function, call it or read a property) instead.`,
    FAILURE_CODES.DEBUGGER_CDP_PROTOCOL_ERROR,
    "validation"
  );
}

function runtimeException(details: CDPExceptionDetails): FailureError {
  return evaluateError(
    formatExceptionDetails(details),
    FAILURE_CODES.DEBUGGER_CDP_RUNTIME_EXCEPTION
  );
}

export class CDPClient {
  readonly events = new TypedEventEmitter<CDPClientEvents>();

  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private pendingBindings = new Map<string, PendingBinding>();
  /** Set by addBinding when the runtime ACKs the command but installs nothing. */
  private bindingUnavailable = false;
  private scripts = new Map<string, ScriptInfo>();
  private enabledDomains = new Set<string>();
  /**
   * Where the runtime is stopped, when it is. Argent sets no breakpoints, so a
   * value here means another debugger on this runtime put it there.
   *
   * @see {@linkcode pausedAt}
   */
  private paused: { callFrames: unknown; reason: string } | undefined;
  private wsUrl: string;
  private sendOrigin: boolean;

  constructor(wsUrl: string, options?: { sendOrigin?: boolean }) {
    this.wsUrl = wsUrl;
    // Default true matches Metro / Expo. Chromium's devtools target rejects an
    // upgrade carrying an Origin header, so those callers pass `sendOrigin: false`.
    this.sendOrigin = options?.sendOrigin !== false;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      // RN >= 0.85 Metro requires an Origin header; Expo matches it exactly
      // against its serverBaseUrl (127.0.0.1), hence the localhost rewrite.
      let headers: Record<string, string> | undefined;
      if (this.sendOrigin) {
        const { protocol, host } = new URL(this.wsUrl);
        const origin =
          (protocol === "wss:" ? "https://" : "http://") + host.replace("localhost", "127.0.0.1");
        headers = { Origin: origin };
      }
      const ws = new WebSocket(this.wsUrl, headers ? { headers } : undefined);
      this.ws = ws;

      const onOpen = () => {
        cleanup();
        this.events.emit("connected");
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(
          new FailureError(
            err.message,
            {
              error_code: FAILURE_CODES.DEBUGGER_CDP_CONNECT_FAILED,
              failure_stage: "debugger_cdp_connect",
              failure_area: "tool_server",
              error_kind: "network",
            },
            { cause: err }
          )
        );
      };
      const onClose = () => {
        cleanup();
        reject(
          new FailureError("WebSocket closed before open", {
            error_code: FAILURE_CODES.DEBUGGER_CDP_SOCKET_CLOSED_BEFORE_OPEN,
            failure_stage: "debugger_cdp_connect",
            failure_area: "tool_server",
            error_kind: "network",
          })
        );
      };
      const cleanup = () => {
        ws.removeListener("open", onOpen);
        ws.removeListener("error", onError);
        ws.removeListener("close", onClose);
      };

      ws.on("open", onOpen);
      ws.on("error", onError);
      ws.on("close", onClose);

      ws.on("message", (raw: WebSocket.RawData) => this.handleMessage(raw));
      ws.on("close", () => {
        this.cleanup();
        this.events.emit("disconnected");
      });
      ws.on("error", (err) => {
        this.cleanup();
        this.events.emit("disconnected", err as Error);
      });
    });
  }

  async disconnect(): Promise<void> {
    if (!this.ws) return;
    const ws = this.ws;
    this.ws = null;
    return new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
      ws.close();
      setTimeout(resolve, 1000);
    });
  }

  /**
   * Re-point this client at another CDP target (e.g. a new browser tab) without
   * emitting `disconnected`, which callers treat as a device loss. Object
   * identity is preserved, so existing references need no rewiring. In-flight
   * requests are rejected and per-connection state is reset, so the caller must
   * re-enable any domains it needs.
   */
  async reconnect(newWsUrl: string): Promise<void> {
    const old = this.ws;
    if (old) {
      // Drop our handlers before closing so the impending close/error does not
      // fire `disconnected`.
      old.removeAllListeners();
      this.ws = null;
      try {
        old.close();
      } catch {
        /* already closing */
      }
    }
    this.cleanup();
    this.wsUrl = newWsUrl;
    await this.connect();
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Where the runtime is stopped, or `undefined` when it is running. */
  pausedAt(): PausedState | undefined {
    if (!this.paused) return undefined;

    return {
      ...(this.locateFrames(this.paused.callFrames) ?? {}),
      reason: this.paused.reason,
    };
  }

  /**
   * The first call frame that names a place a person could open. Reading
   * `callFrames[0].url` is not enough, Hermes leaves `url` empty and
   * identifies scripts by `location.scriptId`. The top frame is often a
   * synthetic eval whose script nothing announced. Walking down lands in the
   * app's own bundle.
   */
  private locateFrames(callFrames: unknown): { location: string } | undefined {
    const frames = (callFrames ?? []) as {
      location?: { lineNumber?: number; scriptId?: string };
      url?: string;
    }[];

    for (const frame of frames) {
      const scriptId = frame.location?.scriptId;
      const url = frame.url || (scriptId ? this.scripts.get(scriptId)?.url : undefined);

      if (!url) continue;

      const line = frame.location?.lineNumber;
      const where = trimBundleQuery(url);

      return { location: line === undefined ? where : `${where}:${line + 1}` };
    }

    return undefined;
  }

  /**
   * Why a call cannot run, in terms of what the caller can do about it.
   * Without this the request simply times out, which reads as a broken app and
   * sends whoever is debugging to the wrong place.
   */
  private pausedError(method: string): FailureError {
    const paused = this.pausedAt()!;
    const where = paused.location ? ` at ${paused.location}` : "";
    const why = paused.reason === "exception" ? "on an exception" : "at a breakpoint";

    return new FailureError(
      `The JS runtime is paused ${why}${where}, so ${method} cannot run. Argent does not set ` +
        `breakpoints, so another debugger attached to this runtime stopped it. Resume it there ` +
        `(or clear the breakpoint) and retry.`,
      {
        error_code: FAILURE_CODES.JS_RUNTIME_PAUSED,
        error_kind: "unsupported",
        failure_area: "tool_server",
        failure_stage: "js_runtime_debugger_paused",
      }
    );
  }

  send(
    method: string,
    params?: Record<string, unknown>,
    timeout = DEFAULT_TIMEOUT_MS
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(
          new FailureError("CDP not connected", {
            error_code: FAILURE_CODES.DEBUGGER_CDP_NOT_CONNECTED,
            failure_stage: "debugger_cdp_send",
            failure_area: "tool_server",
            error_kind: "network",
          })
        );
      }

      if (this.paused && BLOCKED_WHILE_PAUSED.has(method)) {
        return reject(this.pausedError(method));
      }

      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          // The message carries its own recovery guidance: agents otherwise read
          // this state as transient and retry-loop, each pass waiting out the
          // full timeout.
          new FailureError(
            `CDP request ${method} (id=${id}) timed out — the runtime accepted the ` +
              `connection but did not answer; it may be frozen, or paused at a breakpoint. ` +
              `debugger-status can still report "connected" in this state (the socket is open). ` +
              `Do not retry in a loop — restart the app, then reconnect and retry once.`,
            {
              error_code: FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT,
              failure_stage: "debugger_cdp_send",
              failure_area: "tool_server",
              error_kind: "timeout",
            }
          )
        );
      }, timeout);

      this.pending.set(id, {
        resolve: (result) => {
          this.trackDomain(method);
          resolve(result);
        },
        reject,
        timer,
      });

      this.ws.send(JSON.stringify({ id, method, params: params ?? {} }));
    });
  }

  async evaluate(
    expression: string,
    options?: { timeout?: number; returnByValue?: boolean; awaitPromise?: boolean }
  ): Promise<unknown> {
    // Both default on: without returnByValue CDP answers a non-primitive with a
    // RemoteObject reference and leaves `result.value` undefined, and without
    // awaitPromise a Promise expression yields a bare Promise handle.
    const returnByValue = options?.returnByValue ?? true;
    const awaitPromise = options?.awaitPromise ?? true;
    const result = (await this.send(
      "Runtime.evaluate",
      { expression, returnByValue, awaitPromise },
      options?.timeout
    )) as {
      result?: { type?: string; value?: unknown; description?: string };
      exceptionDetails?: CDPExceptionDetails;
    };

    if (result.exceptionDetails) throw runtimeException(result.exceptionDetails);

    return result.result?.value;
  }

  /**
   * Evaluate and return the value, settling a Promise result first.
   *
   * `awaitPromise` is requested: V8 honours it and settles the Promise with
   * the reaction attached inside the engine, so the page never sees an
   * unhandled rejection. Hermes ignores it and answers with the Promise
   * object, so the expression runs once without serializing and, if the
   * result has a `then` method, its settle callbacks write the outcome into a
   * box object that is polled with `Runtime.getProperties`, which compiles no
   * script. Every handle belongs to one object group, released when the call
   * ends. `timeout` bounds the expression and the wait for the Promise; the
   * reads after it keep at least `READ_GRACE_MS`.
   */
  async evaluateAwaited(expression: string, options?: { timeout?: number }): Promise<unknown> {
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;
    const deadline = Date.now() + timeout;
    const objectGroup = `argent-await-${crypto.randomUUID()}`;
    let ran = false;
    try {
      const first = (await this.send(
        "Runtime.evaluate",
        { expression, objectGroup, returnByValue: false, awaitPromise: true },
        timeout
      )) as RemoteResult;
      ran = true;
      if (first.exceptionDetails) throw runtimeException(first.exceptionDetails);
      return await this.readRemote(first.result, objectGroup, deadline, timeout);
    } catch (err) {
      throw ran ? this.afterExpressionRan(err) : err;
    } finally {
      this.send("Runtime.releaseObjectGroup", { objectGroup }, 1000).catch(() => undefined);
    }
  }

  /**
   * Re-code a failure that came after the expression ran, so that neither
   * the registry's self-heal nor the agent runs the expression a second time.
   */
  private afterExpressionRan(err: unknown): unknown {
    const code = err instanceof Error ? getFailureSignal(err)?.error_code : undefined;
    if (code === FAILURE_CODES.DEBUGGER_CDP_NOT_CONNECTED) {
      return evaluateError(
        "The connection closed after the expression ran, before its result was read.",
        FAILURE_CODES.DEBUGGER_CDP_CONNECTION_CLOSED,
        "network",
        err as Error
      );
    }
    if (code === FAILURE_CODES.JS_RUNTIME_PAUSED) {
      const paused = this.pausedAt();
      const where = paused?.location ? ` at ${paused.location}` : "";
      const why = paused?.reason === "exception" ? "on an exception" : "at a breakpoint";
      return new FailureError(
        `The expression ran, but the JS runtime paused ${why}${where} before its result ` +
          `was read. Resume the runtime there; do not run the expression again.`,
        {
          error_code: FAILURE_CODES.JS_RUNTIME_PAUSED,
          error_kind: "unsupported",
          failure_area: "tool_server",
          failure_stage: "debugger_cdp_evaluate",
        },
        { cause: err as Error }
      );
    }
    return err;
  }

  /** The value of an evaluate result: as is when primitive, else read in the app. */
  private async readRemote(
    result: RemoteObjectLike | undefined,
    objectGroup: string,
    deadline: number,
    timeout: number
  ): Promise<unknown> {
    if (!result) return undefined;
    if (result.type === "symbol") return result.description;
    if (result.type === "function") throw unserializable("function");
    if (!result.objectId) return result.value;
    return this.settleRemote(result.objectId, objectGroup, deadline, timeout);
  }

  /**
   * Resolve a remote object to its value. A non-thenable is returned as is; a
   * thenable is watched through a box object (see `scripts/evaluate-awaited`)
   * that is polled until it settles or `deadline` passes.
   */
  private async settleRemote(
    objectId: string,
    objectGroup: string,
    deadline: number,
    timeout: number
  ): Promise<unknown> {
    const readBudget = () => Math.max(deadline - Date.now(), READ_GRACE_MS);
    const unwrap = (verdict: RemoteVerdict | undefined): unknown => {
      if (verdict && "unserializable" in verdict) throw unserializable(verdict.unserializable);
      return verdict && "value" in verdict ? verdict.value : undefined;
    };

    const verdict = (
      await this.callOn(objectId, objectGroup, readIfNotThenable, true, readBudget())
    ).value as RemoteVerdict | undefined;
    if (!verdict || !("pending" in verdict)) return unwrap(verdict);

    const box = (await this.callOn(objectId, objectGroup, watchThenable, false, readBudget()))
      .objectId;
    if (!box) {
      throw evaluateError(
        "The runtime returned no handle to wait on the Promise with.",
        FAILURE_CODES.DEBUGGER_CDP_PROTOCOL_ERROR
      );
    }

    // The box is read at least once: a Promise that settled while the
    // expression used up the budget is still a result.
    let state = await this.readBoxState(box, deadline, timeout);
    while (state === "pending") {
      if (Date.now() >= deadline) throw unsettled(timeout);
      await sleep(Math.min(PROMISE_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
      state = await this.readBoxState(box, deadline, timeout);
    }

    if (state === "fulfilled") {
      return unwrap(
        (await this.callOn(box, objectGroup, readBoxValue, true, readBudget())).value as
          RemoteVerdict | undefined
      );
    }
    const reason = (await this.callOn(box, objectGroup, readBoxError, true, readBudget())).value;
    throw evaluateError(
      `Promise rejected: ${String(reason)}`,
      FAILURE_CODES.DEBUGGER_CDP_RUNTIME_EXCEPTION
    );
  }

  /**
   * Read the box's `state` with `Runtime.getProperties`, which runs no script
   * in the app. A paused runtime would never run the callbacks, so it fails
   * fast. A poll that gets no answer in time is retried after a nudge: the
   * legacy Hermes inspector only wakes the runtime for an evaluate, and can
   * leave a `getProperties` queued behind other traffic until one arrives.
   */
  private async readBoxState(
    box: string,
    deadline: number,
    timeout: number
  ): Promise<SettleBox["state"]> {
    if (this.paused) throw this.pausedError("the Promise's callbacks");
    let props: { result?: { name: string; value?: RemoteObjectLike }[] };
    try {
      props = (await this.send(
        "Runtime.getProperties",
        { objectId: box, ownProperties: true },
        POLL_REQUEST_TIMEOUT_MS
      )) as typeof props;
    } catch (err) {
      const code = err instanceof Error ? getFailureSignal(err)?.error_code : undefined;
      if (code === FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT) {
        if (Date.now() >= deadline) throw unsettled(timeout);
        await this.send(
          "Runtime.evaluate",
          { expression: "0", returnByValue: true },
          POLL_REQUEST_TIMEOUT_MS
        ).catch(() => undefined);
        return "pending";
      }
      if (code !== FAILURE_CODES.DEBUGGER_CDP_PROTOCOL_ERROR) throw err;
      throw evaluateError(
        "Lost the Promise while waiting for it: the JS context was reloaded or replaced.",
        FAILURE_CODES.DEBUGGER_CDP_PROTOCOL_ERROR,
        "unknown",
        err as Error
      );
    }
    const state = props.result?.find((p) => p.name === "state")?.value?.value;
    if (state === "fulfilled" || state === "rejected") return state;
    return "pending";
  }

  /**
   * Run one of the `scripts/evaluate-awaited` functions in the app with `this`
   * bound to `objectId`. The function's source is what ships, so it must not
   * close over anything (see that module's header). The helpers catch their
   * own errors, so `exceptionDetails` here is a fault in the inspector, not
   * in the agent's expression, which has already run.
   */
  private async callOn(
    objectId: string,
    objectGroup: string,
    fn: (this: any) => unknown,
    returnByValue: boolean,
    timeout: number
  ): Promise<RemoteObjectLike> {
    const res = (await this.send(
      "Runtime.callFunctionOn",
      { objectId, objectGroup, functionDeclaration: fn.toString(), returnByValue },
      timeout
    )) as RemoteResult;
    if (res.exceptionDetails) {
      throw evaluateError(
        `The inspector failed while reading the expression's result, after the expression ` +
          `ran: ${formatExceptionDetails(res.exceptionDetails)}. Do not run the expression again.`,
        FAILURE_CODES.DEBUGGER_CDP_PROTOCOL_ERROR
      );
    }
    return res.result ?? {};
  }

  async addBinding(name: string): Promise<void> {
    await this.send("Runtime.addBinding", { name });

    // The legacy Hermes inspector ACKs Runtime.addBinding and never installs the
    // binding: no Runtime.bindingCalled fires, so waiters hang for the full
    // timeout. Probe once here so evaluateWithBinding can fail fast. Only a
    // positive observation of absence disables it — a probe that throws or
    // answers unexpectedly leaves the binding assumed working.
    const probe = await this.evaluate(`typeof ${name}`).catch(() => undefined);
    this.bindingUnavailable = probe === "undefined";
  }

  /**
   * Inject a script that pushes its result over the binding tagged with a
   * requestId; resolves with the payload of the matching binding call.
   */
  evaluateWithBinding(
    expression: string,
    requestId?: string,
    options?: { timeout?: number }
  ): Promise<Record<string, unknown>> {
    const id = requestId ?? crypto.randomUUID();
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;

    if (this.bindingUnavailable) {
      return Promise.reject(
        new FailureError(
          "This JS runtime acknowledges Runtime.addBinding but never installs the binding " +
            "(legacy Hermes, React Native <= 0.72), so it cannot deliver a result over the " +
            "binding channel. Tools that read the React tree this way are unavailable here; " +
            "use `describe` to read on-screen structure.",
          {
            error_code: FAILURE_CODES.DEBUGGER_CDP_BINDING_UNAVAILABLE,
            failure_stage: "debugger_cdp_binding",
            failure_area: "tool_server",
            error_kind: "unsupported",
          }
        )
      );
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingBindings.delete(id);
        reject(
          new FailureError(
            `Binding response for requestId=${id} timed out — the runtime took the script ` +
              `but never called back over the binding. It may be paused at a breakpoint ` +
              `(the script is dispatched without awaiting it, so a paused runtime still ` +
              `accepts it and never runs the callback), or frozen. Check the debugger and ` +
              `resume it; if nothing is paused, restart the app. Do not retry in a loop — ` +
              `each attempt waits out the full timeout.`,
            {
              error_code: FAILURE_CODES.DEBUGGER_CDP_BINDING_TIMEOUT,
              failure_stage: "debugger_cdp_binding",
              failure_area: "tool_server",
              error_kind: "timeout",
            }
          )
        );
      }, timeout);

      this.pendingBindings.set(id, { resolve, reject, timer });

      // The payload arrives over the binding, not as the evaluate result — keep
      // returnByValue/awaitPromise off so we neither serialize nor block on it.
      this.evaluate(expression, { timeout, returnByValue: false, awaitPromise: false }).catch(
        (err) => {
          this.pendingBindings.delete(id);
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      );
    });
  }

  getLoadedScripts(): Map<string, ScriptInfo> {
    return new Map(this.scripts);
  }

  getEnabledDomains(): ReadonlySet<string> {
    return this.enabledDomains;
  }

  private handleMessage(raw: WebSocket.RawData): void {
    const text = Buffer.isBuffer(raw)
      ? raw.toString()
      : Array.isArray(raw)
        ? Buffer.concat(raw).toString()
        : Buffer.from(raw).toString();
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }

    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const req = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(req.timer);
      if (msg.error) {
        req.reject(
          new FailureError(
            ((msg.error as Record<string, unknown>).message as string) ?? JSON.stringify(msg.error),
            {
              error_code: FAILURE_CODES.DEBUGGER_CDP_PROTOCOL_ERROR,
              failure_stage: "debugger_cdp_protocol",
              failure_area: "tool_server",
              error_kind: "unknown",
            }
          )
        );
      } else {
        req.resolve(msg.result);
      }
      return;
    }

    const method = msg.method as string | undefined;
    const params = (msg.params ?? {}) as Record<string, unknown>;

    if (!method) return;

    if (method === "Debugger.scriptParsed") {
      const script: ScriptInfo = {
        scriptId: params.scriptId as string,
        url: params.url as string,
        sourceMapURL: params.sourceMapURL as string | undefined,
        startLine: (params.startLine as number) ?? 0,
        endLine: (params.endLine as number) ?? 0,
      };
      this.scripts.set(script.scriptId, script);
      this.events.emit("scriptParsed", script);
    }

    if (method === "Runtime.bindingCalled") {
      const name = params.name as string;
      const payload = params.payload as string;

      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(payload);
      } catch {
        /* not JSON, emit raw */
      }

      if (parsed && typeof parsed.requestId === "string") {
        const pending = this.pendingBindings.get(parsed.requestId);
        if (pending) {
          this.pendingBindings.delete(parsed.requestId);
          clearTimeout(pending.timer);
          pending.resolve(parsed);
          return;
        }
      }

      this.events.emit("bindingCalled", name, payload);
    }

    if (method === "Runtime.consoleAPICalled") {
      this.events.emit("consoleAPICalled", {
        type: (params.type as string) ?? "log",
        args: (params.args as ConsoleCallArg[]) ?? [],
        timestamp: (params.timestamp as number) ?? Date.now(),
        stackTrace: params.stackTrace as Record<string, unknown> | undefined,
      });
    }

    if (method === "Debugger.paused") {
      /**
       * Kept raw and resolved on demand. A provider replaying this to a client
       * that attached mid-stop delivers it before `Debugger.enable` has
       * re-announced the scripts, so resolving now would find an empty map and
       * lose the location. By the time anyone asks, they have arrived.
       */
      this.paused = {
        callFrames: params.callFrames,
        reason: (params.reason as string) ?? "unknown",
      };

      this.events.emit("paused", params);
    }

    if (method === "Debugger.resumed") {
      this.paused = undefined;
      this.events.emit("resumed");
    }

    this.events.emit("event", method, params);
  }

  private trackDomain(method: string): void {
    const dotIdx = method.indexOf(".");
    if (dotIdx < 0) return;
    const domain = method.slice(0, dotIdx);
    const action = method.slice(dotIdx + 1);
    if (action === "enable") this.enabledDomains.add(domain);
    else if (action === "disable") this.enabledDomains.delete(domain);
  }

  private cleanup(): void {
    // Pause state belongs to the connection that observed it. A still-stopped
    // runtime re-announces itself on reconnect, so keeping the old value could
    // only make a resumed one look stuck.
    this.paused = undefined;

    // A request rejected here was already delivered and may have taken effect —
    // callers must not blindly retry side-effectful sends.
    const connectionClosed = () =>
      new FailureError("CDP connection closed", {
        error_code: FAILURE_CODES.DEBUGGER_CDP_CONNECTION_CLOSED,
        failure_stage: "debugger_cdp_lifecycle",
        failure_area: "tool_server",
        error_kind: "network",
      });
    for (const [, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(connectionClosed());
    }
    this.pending.clear();

    for (const [, binding] of this.pendingBindings) {
      clearTimeout(binding.timer);
      binding.reject(connectionClosed());
    }
    this.pendingBindings.clear();

    this.scripts.clear();
    this.enabledDomains.clear();
    this.ws = null;
  }
}
