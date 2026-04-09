import { TypedEventEmitter, type ServiceBlueprint, type ServiceEvents } from "@argent/registry";
import { discoverMetro } from "../utils/debugger/discovery";
import { selectTarget } from "../utils/debugger/target-selection";
import { CDPClient, type ConsoleAPICalledParams } from "../utils/debugger/cdp-client";
import { createSourceResolver, type SourceResolver } from "../utils/debugger/source-resolver";
import { SourceMapsRegistry } from "../utils/debugger/source-maps";
import { DISABLE_LOGBOX_SCRIPT } from "../utils/debugger/scripts/disable-logbox";
import { LogFileWriter } from "../utils/debugger/log-file-writer";
import { WebSocketServer, WebSocket } from "ws";
import * as http from "node:http";

export const JS_RUNTIME_DEBUGGER_NAMESPACE = "JsRuntimeDebugger";

export interface ConsoleLogEntry {
  id: number;
  level: string;
  args: Array<{ type: string; value?: unknown; description?: string }>;
  message: string;
  timestamp: number;
  stackTrace?: {
    callFrames: Array<{
      functionName: string;
      scriptId: string;
      url: string;
      lineNumber: number;
      columnNumber: number;
    }>;
  };
}

export type ConsoleLogEvents = {
  log: (entry: ConsoleLogEntry) => void;
};

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
  logWriter: LogFileWriter
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    const wss = new WebSocketServer({ server });

    wss.on("connection", (ws) => {
      for (const entry of logWriter.readAll()) {
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
  appName: string;
  logicalDeviceId: string | undefined;
  isNewDebugger: boolean;
  cdp: CDPClient;
  sourceResolver: SourceResolver;
  sourceMaps: SourceMapsRegistry;
  logWriter: LogFileWriter;
  consoleEvents: TypedEventEmitter<ConsoleLogEvents>;
  consoleSocketUrl: string;
}

export const jsRuntimeDebuggerBlueprint: ServiceBlueprint<JsRuntimeDebuggerApi, string> = {
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
      sourceMaps.registerFromScriptParsed(script.url, script.scriptId, script.sourceMapURL);
    });

    const ignore = () => {};
    await cdp.send("FuseboxClient.setClientMetadata", {}).catch(ignore);
    await cdp.send("ReactNativeApplication.enable", {}).catch(ignore);
    await cdp.send("Runtime.enable");
    await cdp.send("Debugger.enable", { maxScriptsCacheSize: 100_000_000 });
    await cdp.send("Debugger.setPauseOnExceptions", { state: "none" });
    await cdp.send("Debugger.setAsyncCallStackDepth", { maxDepth: 32 }).catch(ignore);
    await cdp.send("Runtime.runIfWaitingForDebugger").catch(ignore);
    await cdp.addBinding("__argent_callback");

    await cdp.evaluate(DISABLE_LOGBOX_SCRIPT).catch(ignore);

    await sourceMaps.waitForPending();

    const sourceResolver = createSourceResolver(port, metro.projectRoot);

    const logWriter = new LogFileWriter(port);
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
        stackTrace: params.stackTrace as ConsoleLogEntry["stackTrace"],
      };
      logWriter.write({
        id: entry.id,
        timestamp: new Date(entry.timestamp * 1000).toISOString(),
        level: entry.level,
        message: entry.message,
        stackTrace: entry.stackTrace,
      });
      consoleEvents.emit("log", entry);
    });

    const consoleServer = await createConsoleLogServer(consoleEvents, logWriter);

    const api: JsRuntimeDebuggerApi = {
      port,
      projectRoot: metro.projectRoot,
      deviceName: selected.deviceName,
      appName: selected.target.title,
      logicalDeviceId: selected.target.reactNative?.logicalDeviceId,
      isNewDebugger: selected.isNewDebugger,
      cdp,
      sourceResolver,
      sourceMaps,
      logWriter,
      consoleEvents,
      consoleSocketUrl: consoleServer.url,
    };

    const events = new TypedEventEmitter<ServiceEvents>();

    cdp.events.on("disconnected", (error) => {
      events.emit("terminated", error ?? new Error("CDP disconnected"));
    });

    return {
      api,
      dispose: async () => {
        await consoleServer.close();
        logWriter.close();
        await cdp.disconnect();
      },
      events,
    };
  },
};
