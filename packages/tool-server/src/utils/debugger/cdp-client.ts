import WebSocket from "ws";
import { TypedEventEmitter } from "@argent/registry";
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
  executionContextCreated: (params: Record<string, unknown>) => void;
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
  // exception.description already contains the JS Error message + its own JS stack
  const description =
    details.exception?.description ?? details.text ?? "Script evaluation threw an exception";

  // If the description already embeds a stack trace (Error: msg\n  at ...) use it as-is.
  // Otherwise append the CDP-reported call frames.
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
  private scripts = new Map<string, ScriptInfo>();
  private enabledDomains = new Set<string>();
  private wsUrl: string;

  constructor(wsUrl: string) {
    this.wsUrl = wsUrl;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      // RN >= 0.85 Metro requires an Origin header. Expo's dev server does an
      // exact match against its serverBaseUrl (127.0.0.1), so we normalize
      // localhost → 127.0.0.1 in the Origin to satisfy both servers.
      const { protocol, host } = new URL(this.wsUrl);
      const origin =
        (protocol === "wss:" ? "https://" : "http://") + host.replace("localhost", "127.0.0.1");
      const ws = new WebSocket(this.wsUrl, { headers: { Origin: origin } });
      this.ws = ws;

      const onOpen = () => {
        cleanup();
        this.events.emit("connected");
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const onClose = () => {
        cleanup();
        reject(new Error("WebSocket closed before open"));
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
        return reject(new Error("CDP not connected"));
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP request ${method} (id=${id}) timed out`));
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

  async evaluate(expression: string, options?: { timeout?: number }): Promise<unknown> {
    const result = (await this.send("Runtime.evaluate", { expression }, options?.timeout)) as {
      result?: { type?: string; value?: unknown; description?: string };
      exceptionDetails?: CDPExceptionDetails;
    };

    if (result.exceptionDetails) {
      throw new Error(formatExceptionDetails(result.exceptionDetails));
    }

    return result.result?.value;
  }

  async addBinding(name: string): Promise<void> {
    await this.send("Runtime.addBinding", { name });
  }

  /**
   * Inject a script that will push a result via the binding using a unique requestId.
   * Returns the parsed payload when the matching binding call arrives.
   */
  evaluateWithBinding(
    expression: string,
    requestId?: string,
    options?: { timeout?: number }
  ): Promise<Record<string, unknown>> {
    const id = requestId ?? crypto.randomUUID();
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingBindings.delete(id);
        reject(new Error(`Binding response for requestId=${id} timed out`));
      }, timeout);

      this.pendingBindings.set(id, { resolve, reject, timer });

      this.evaluate(expression, { timeout }).catch((err) => {
        this.pendingBindings.delete(id);
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  getLoadedScripts(): Map<string, ScriptInfo> {
    return new Map(this.scripts);
  }

  getEnabledDomains(): ReadonlySet<string> {
    return this.enabledDomains;
  }

  private handleMessage(raw: WebSocket.RawData): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const req = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(req.timer);
      if (msg.error) {
        req.reject(
          new Error(
            ((msg.error as Record<string, unknown>).message as string) ?? JSON.stringify(msg.error)
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

    if (method === "Runtime.executionContextCreated") {
      this.events.emit("executionContextCreated", params);
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
    for (const [, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(new Error("CDP connection closed"));
    }
    this.pending.clear();

    for (const [, binding] of this.pendingBindings) {
      clearTimeout(binding.timer);
      binding.reject(new Error("CDP connection closed"));
    }
    this.pendingBindings.clear();

    this.scripts.clear();
    this.enabledDomains.clear();
    this.ws = null;
  }
}
