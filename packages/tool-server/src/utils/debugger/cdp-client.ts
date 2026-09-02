import WebSocket from "ws";
import { FAILURE_CODES, FailureError, TypedEventEmitter } from "@argent/registry";
import * as crypto from "node:crypto";

export interface ScriptInfo {
  scriptId: string;
  url: string;
  sourceMapURL?: string;
  startLine: number;
  endLine: number;
}

export interface ConsoleCallArg {
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
  consoleAPICalled: (params: ConsoleAPICalledParams) => void;
};

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

    if (result.exceptionDetails) {
      throw new FailureError(formatExceptionDetails(result.exceptionDetails), {
        error_code: FAILURE_CODES.DEBUGGER_CDP_RUNTIME_EXCEPTION,
        failure_stage: "debugger_cdp_evaluate",
        failure_area: "tool_server",
        error_kind: "unknown",
      });
    }

    return result.result?.value;
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
          new FailureError(`Binding response for requestId=${id} timed out`, {
            error_code: FAILURE_CODES.DEBUGGER_CDP_BINDING_TIMEOUT,
            failure_stage: "debugger_cdp_binding",
            failure_area: "tool_server",
            error_kind: "timeout",
          })
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
      this.events.emit("paused", params);
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
