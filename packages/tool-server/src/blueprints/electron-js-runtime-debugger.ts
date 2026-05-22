import { WebSocketServer, WebSocket } from "ws";
import * as http from "node:http";
import {
  TypedEventEmitter,
  type DeviceInfo,
  type ServiceBlueprint,
  type ServiceEvents,
} from "@argent/registry";
import { ELECTRON_CDP_NAMESPACE, type ElectronCdpApi } from "./electron-cdp";
import type { ConsoleAPICalledParams } from "../utils/debugger/cdp-client";
import { SourceMapsRegistry } from "../utils/debugger/source-maps";
import type { SourceResolver } from "../utils/debugger/source-resolver";
import { LogFileWriter } from "../utils/debugger/log-file-writer";
import {
  type ConsoleLogEntry,
  type ConsoleLogEvents,
  type JsRuntimeDebuggerApi,
} from "./js-runtime-debugger";

export const ELECTRON_JS_RUNTIME_DEBUGGER_NAMESPACE = "ElectronJsRuntimeDebugger";

type ElectronJsdFactoryOptions = Record<string, unknown> & { device: DeviceInfo };

export function electronJsRuntimeDebuggerRef(device: DeviceInfo): {
  urn: string;
  options: ElectronJsdFactoryOptions;
} {
  return {
    urn: `${ELECTRON_JS_RUNTIME_DEBUGGER_NAMESPACE}:${device.id}`,
    options: { device },
  };
}

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

// Stubs for fields only consumed by debugger-inspect-element, which is locked
// out on Electron (it depends on the React Native internal
// getInspectorDataForViewAtPoint). Keeping them shaped means electron and
// metro paths can share a single api interface — tools that *don't* use them
// work uniformly, and any future tool that calls one on an electron api hits a
// loud, clearly-named error instead of `undefined`.
function makeStubSourceResolver(): SourceResolver {
  const unsupported = () => {
    throw new Error(
      "SourceResolver is not implemented on Electron debugger sessions — Metro symbolicate is the only backing implementation."
    );
  };
  return {
    resolveDebugStack: async () => null,
    symbolicate: async () => null,
    readSourceFragment: unsupported,
  };
}

class StubSourceMapsRegistry extends SourceMapsRegistry {
  constructor() {
    super("");
  }
  override async waitForPending(): Promise<void> {
    // No Metro source-map fetch loop on Electron — page scripts already carry
    // their own //# sourceMappingURL=data:... or rely on the browser devtools'
    // own resolution path.
  }
}

export const electronJsRuntimeDebuggerBlueprint: ServiceBlueprint<JsRuntimeDebuggerApi, string> = {
  namespace: ELECTRON_JS_RUNTIME_DEBUGGER_NAMESPACE,

  getURN(payload: string) {
    return `${ELECTRON_JS_RUNTIME_DEBUGGER_NAMESPACE}:${payload}`;
  },

  getDependencies(_payload: string) {
    // The payload IS the device id (e.g. "electron-cdp-9222") so we depend on
    // the matching ElectronCdp service. Keeping the device id in the payload —
    // rather than passing through options — means the registry can compute
    // dependency URNs without needing the resolved DeviceInfo.
    return { electron: `${ELECTRON_CDP_NAMESPACE}:${_payload}` };
  },

  async factory(deps, payload, options) {
    const opts = options as ElectronJsdFactoryOptions | undefined;
    const device = opts?.device;
    if (!device) {
      throw new Error(
        `${ELECTRON_JS_RUNTIME_DEBUGGER_NAMESPACE}.factory requires a resolved DeviceInfo via options.device. ` +
          `Use electronJsRuntimeDebuggerRef(device) when registering the service ref.`
      );
    }
    if (device.id !== payload) {
      throw new Error(
        `${ELECTRON_JS_RUNTIME_DEBUGGER_NAMESPACE}.factory: payload "${payload}" does not match options.device.id "${device.id}".`
      );
    }

    const electron = deps.electron as ElectronCdpApi;
    const cdp = electron.cdp;
    const port = electron.port;

    const logWriter = new LogFileWriter(port);
    const consoleEvents = new TypedEventEmitter<ConsoleLogEvents>();
    let nextLogId = 0;

    const onConsoleAPI = (params: ConsoleAPICalledParams) => {
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
        timestamp: new Date(entry.timestamp).toISOString(),
        level: entry.level,
        message: entry.message,
        stackTrace: entry.stackTrace,
      });
      consoleEvents.emit("log", entry);
    };
    cdp.events.on("consoleAPICalled", onConsoleAPI);

    const consoleServer = await createConsoleLogServer(consoleEvents, logWriter);

    // Best-effort: bind a callback name so evaluateWithBinding works if a
    // future Electron tool wants it. Failure is non-fatal — the existing
    // four ported tools don't use it.
    await cdp.addBinding("__argent_callback").catch(() => {});

    const sourceMaps = new StubSourceMapsRegistry();
    const sourceResolver = makeStubSourceResolver();

    const api: JsRuntimeDebuggerApi = {
      port,
      // Electron apps have no Metro project root. Empty string keeps the
      // contract type-clean; callers that care (only inspect-element via the
      // source resolver) are gated out before they ever touch this field.
      projectRoot: "",
      deviceName: device.name ?? "Electron",
      appName: "Electron",
      logicalDeviceId: device.id,
      // Electron always speaks the new CDP — there is no Hermes-legacy mode.
      isNewDebugger: true,
      cdp,
      sourceResolver,
      sourceMaps,
      logWriter,
      consoleEvents,
      consoleSocketUrl: consoleServer.url,
    };

    const events = new TypedEventEmitter<ServiceEvents>();
    cdp.events.on("disconnected", (error) => {
      events.emit("terminated", error ?? new Error("Electron CDP disconnected"));
    });

    return {
      api,
      dispose: async () => {
        cdp.events.off("consoleAPICalled", onConsoleAPI);
        await consoleServer.close();
        logWriter.close();
        // Do NOT disconnect the cdp — it belongs to the ElectronCdp service.
        // Disposing this blueprint must leave the underlying CDP session alive
        // for other consumers (screenshot, describe, gesture-tap, ...).
      },
      events,
    };
  },
};
