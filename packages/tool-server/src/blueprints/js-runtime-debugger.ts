import {
  TypedEventEmitter,
  type ServiceBlueprint,
  type ServiceEvents,
} from "@argent/registry";
import { discoverMetro } from "../utils/debugger/discovery";
import { selectTarget } from "../utils/debugger/target-selection";
import {
  CDPClient,
  type ConsoleAPICalledParams,
  type NetworkRequestData,
  type NetworkResponseData,
} from "../utils/debugger/cdp-client";
import {
  createSourceResolver,
  type SourceResolver,
} from "../utils/debugger/source-resolver";
import { SourceMapsRegistry } from "../utils/debugger/source-maps";
import { WebSocketServer, WebSocket } from "ws";
import * as http from "node:http";

export const JS_RUNTIME_DEBUGGER_NAMESPACE = "JsRuntimeDebugger";

export interface ConsoleLogEntry {
  id: number;
  level: string;
  args: Array<{ type: string; value?: unknown; description?: string }>;
  message: string;
  timestamp: number;
}

export type ConsoleLogEvents = {
  log: (entry: ConsoleLogEntry) => void;
};

// ── Network log types ──

export type NetworkLogState = "pending" | "finished" | "failed";

export interface NetworkLogEntry {
  /** Monotonically increasing id within this session */
  id: number;
  requestId: string;
  state: NetworkLogState;
  request?: NetworkRequestData;
  response?: NetworkResponseData;
  /** Resource type reported by CDP (XHR, Fetch, Script, Image, etc.) */
  resourceType?: string;
  /** Encoded response body size in bytes (from loadingFinished) */
  encodedDataLength?: number;
  /** CDP timestamp when request was sent */
  timestamp?: number;
  /** Wall-clock time when request was sent */
  wallTime?: number;
  /** Duration in ms (loadingFinished.timestamp - requestWillBeSent.timestamp) */
  durationMs?: number;
  /** Error text if the request failed */
  errorText?: string;
  initiator?: { type: string; url?: string; lineNumber?: number };
}

export type NetworkLogEvents = {
  entry: (entry: NetworkLogEntry) => void;
};

const MAX_LOG_BUFFER = 1000;
const MAX_NETWORK_LOG_BUFFER = 2000;

function formatConsoleArgs(params: ConsoleAPICalledParams): string {
  return params.args
    .map((arg) => {
      if (arg.value !== undefined) return String(arg.value);
      if (arg.description) return arg.description;
      return `[${arg.type}]`;
    })
    .join(" ");
}

function createConsoleLogServer(
  consoleEvents: TypedEventEmitter<ConsoleLogEvents>,
  consoleLogs: ConsoleLogEntry[],
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    const wss = new WebSocketServer({ server });

    wss.on("connection", (ws) => {
      for (const entry of consoleLogs) {
        ws.send(JSON.stringify(entry));
      }

      const onLog = (entry: ConsoleLogEntry) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(entry));
        }
      };
      consoleEvents.on("log", onLog);
      ws.on("close", () => consoleEvents.off("log", onLog));
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to bind console log server"));
        return;
      }
      const url = `ws://127.0.0.1:${addr.port}`;
      resolve({
        url,
        close: () =>
          new Promise<void>((res) => {
            wss.clients.forEach((c) => c.close());
            wss.close(() => server.close(() => res()));
          }),
      });
    });

    server.on("error", reject);
  });
}

export interface JsRuntimeDebuggerApi {
  port: number;
  projectRoot: string;
  deviceName: string;
  isNewDebugger: boolean;
  cdp: CDPClient;
  sourceResolver: SourceResolver;
  sourceMaps: SourceMapsRegistry;
  consoleLogs: ConsoleLogEntry[];
  consoleEvents: TypedEventEmitter<ConsoleLogEvents>;
  consoleSocketUrl: string;
  networkLogs: NetworkLogEntry[];
  networkLogsById: Map<string, NetworkLogEntry>;
  networkEvents: TypedEventEmitter<NetworkLogEvents>;
}

export const jsRuntimeDebuggerBlueprint: ServiceBlueprint<
  JsRuntimeDebuggerApi,
  string
> = {
  namespace: JS_RUNTIME_DEBUGGER_NAMESPACE,

  getURN(port: string) {
    return `${JS_RUNTIME_DEBUGGER_NAMESPACE}:${port}`;
  },

  async factory(_deps, payload, options?) {
    const port = parseInt(payload, 10);

    const metro = await discoverMetro(port);
    const selected = selectTarget(metro.targets, port, options);

    const cdp = new CDPClient(selected.webSocketUrl);
    await cdp.connect();

    const sourceMaps = new SourceMapsRegistry(metro.projectRoot);

    cdp.events.on("scriptParsed", (script) => {
      sourceMaps.registerFromScriptParsed(
        script.url,
        script.scriptId,
        script.sourceMapURL,
      );
    });

    const ignore = () => {};
    await cdp.send("FuseboxClient.setClientMetadata", {}).catch(ignore);
    await cdp.send("ReactNativeApplication.enable", {}).catch(ignore);
    await cdp.send("Runtime.enable");
    await cdp.send("Debugger.enable", { maxScriptsCacheSize: 100_000_000 });
    await cdp.send("Debugger.setPauseOnExceptions", { state: "none" });
    await cdp
      .send("Debugger.setAsyncCallStackDepth", { maxDepth: 32 })
      .catch(ignore);
    await cdp.send("Runtime.runIfWaitingForDebugger").catch(ignore);
    await cdp.addBinding("__radon_lite_callback");

    // Enable Network domain — best-effort; not all runtimes support it.
    await cdp.send("Network.enable").catch(ignore);

    await sourceMaps.waitForPending();

    const sourceResolver = createSourceResolver(port, metro.projectRoot);

    const consoleLogs: ConsoleLogEntry[] = [];
    const consoleEvents = new TypedEventEmitter<ConsoleLogEvents>();
    let nextLogId = 0;

    cdp.events.on("consoleAPICalled", (params) => {
      const entry: ConsoleLogEntry = {
        id: nextLogId++,
        level: params.type,
        args: params.args.map((a) => ({
          type: a.type,
          value: a.value,
          description: a.description,
        })),
        message: formatConsoleArgs(params),
        timestamp: params.timestamp,
      };
      consoleLogs.push(entry);
      if (consoleLogs.length > MAX_LOG_BUFFER) {
        consoleLogs.splice(0, consoleLogs.length - MAX_LOG_BUFFER);
      }
      consoleEvents.emit("log", entry);
    });

    const consoleServer = await createConsoleLogServer(
      consoleEvents,
      consoleLogs,
    );

    // ── Network log capture ──
    const networkLogs: NetworkLogEntry[] = [];
    const networkLogsById = new Map<string, NetworkLogEntry>();
    const networkEvents = new TypedEventEmitter<NetworkLogEvents>();
    let nextNetworkLogId = 0;

    function getOrCreateNetworkEntry(requestId: string): NetworkLogEntry {
      let entry = networkLogsById.get(requestId);
      if (!entry) {
        entry = {
          id: nextNetworkLogId++,
          requestId,
          state: "pending",
        };
        networkLogs.push(entry);
        networkLogsById.set(requestId, entry);
        if (networkLogs.length > MAX_NETWORK_LOG_BUFFER) {
          const removed = networkLogs.splice(
            0,
            networkLogs.length - MAX_NETWORK_LOG_BUFFER,
          );
          for (const r of removed) {
            networkLogsById.delete(r.requestId);
          }
        }
      }
      return entry;
    }

    cdp.events.on("networkRequestWillBeSent", (params) => {
      // Filter out requests to the Metro server itself (hot-reload, bundle fetches).
      try {
        const url = new URL(params.request.url);
        if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
          const urlPort = parseInt(url.port, 10);
          if (urlPort === port) return;
        }
      } catch {
        // Not a valid URL — let it through.
      }

      const entry = getOrCreateNetworkEntry(params.requestId);
      entry.request = params.request;
      entry.timestamp = params.timestamp;
      entry.wallTime = params.wallTime;
      entry.resourceType = params.type;
      entry.initiator = params.initiator;
      networkEvents.emit("entry", entry);
    });

    cdp.events.on("networkResponseReceived", (params) => {
      const entry = networkLogsById.get(params.requestId);
      if (!entry) return;
      entry.response = params.response;
      if (!entry.resourceType && params.type) {
        entry.resourceType = params.type;
      }
      networkEvents.emit("entry", entry);
    });

    cdp.events.on("networkLoadingFinished", (params) => {
      const entry = networkLogsById.get(params.requestId);
      if (!entry) return;
      entry.state = "finished";
      entry.encodedDataLength = params.encodedDataLength;
      if (entry.timestamp != null) {
        entry.durationMs = Math.round(
          (params.timestamp - entry.timestamp) * 1000,
        );
      }
      networkEvents.emit("entry", entry);
    });

    cdp.events.on("networkLoadingFailed", (params) => {
      const entry = networkLogsById.get(params.requestId);
      if (!entry) return;
      entry.state = "failed";
      entry.errorText = params.errorText;
      if (entry.timestamp != null) {
        entry.durationMs = Math.round(
          (params.timestamp - entry.timestamp) * 1000,
        );
      }
      networkEvents.emit("entry", entry);
    });

    const api: JsRuntimeDebuggerApi = {
      port,
      projectRoot: metro.projectRoot,
      deviceName: selected.deviceName,
      isNewDebugger: selected.isNewDebugger,
      cdp,
      sourceResolver,
      sourceMaps,
      consoleLogs,
      consoleEvents,
      consoleSocketUrl: consoleServer.url,
      networkLogs,
      networkLogsById,
      networkEvents,
    };

    const events = new TypedEventEmitter<ServiceEvents>();

    cdp.events.on("disconnected", (error) => {
      events.emit("terminated", error ?? new Error("CDP disconnected"));
    });

    return {
      api,
      dispose: async () => {
        await consoleServer.close();
        await cdp.disconnect();
      },
      events,
    };
  },
};
