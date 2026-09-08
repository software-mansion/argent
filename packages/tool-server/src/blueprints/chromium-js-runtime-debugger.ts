import { WebSocketServer, WebSocket } from "ws";
import * as http from "node:http";
import {
  TypedEventEmitter,
  type DeviceInfo,
  type ServiceBlueprint,
  type ServiceEvents,
} from "@argent/registry";
import { CHROMIUM_CDP_NAMESPACE, type ChromiumCdpApi } from "./chromium-cdp";
import type { ConsoleAPICalledParams } from "../utils/debugger/cdp-client";
import { SourceMapsRegistry } from "../utils/debugger/source-maps";
import type { SourceResolver } from "../utils/debugger/source-resolver";
import { LogFileWriter } from "../utils/debugger/log-file-writer";
import { consoleTimestampToIso } from "../utils/debugger/console-timestamp";
import { recordReapedSession } from "../utils/reaped-sessions";
import {
  type ConsoleLogEntry,
  type ConsoleLogEvents,
  type JsRuntimeDebuggerApi,
} from "./js-runtime-debugger";

export const CHROMIUM_JS_RUNTIME_DEBUGGER_NAMESPACE = "ChromiumJsRuntimeDebugger";

type ChromiumJsdFactoryOptions = Record<string, unknown> & { device: DeviceInfo };

export function chromiumJsRuntimeDebuggerRef(device: DeviceInfo): {
  urn: string;
  options: ChromiumJsdFactoryOptions;
} {
  return {
    urn: `${CHROMIUM_JS_RUNTIME_DEBUGGER_NAMESPACE}:${device.id}`,
    options: { device },
  };
}

function stringifyConsoleValue(value: unknown): string {
  if (typeof value === "object" && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return Object.prototype.toString.call(value);
    }
  }
  return String(value);
}

function formatConsoleArgs(params: ConsoleAPICalledParams): string {
  return params.args
    .map((arg) => {
      if (arg.value !== undefined) return stringifyConsoleValue(arg.value);
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

function makeStubSourceResolver(): SourceResolver {
  const unsupported = () => {
    throw new Error(
      "SourceResolver is not implemented on Chromium debugger sessions — Metro symbolicate is the only backing implementation."
    );
  };
  return {
    resolveDebugStack: async () => null,
    symbolicate: async () => null,
    readSourceFragment: unsupported,
  };
}

export const chromiumJsRuntimeDebuggerBlueprint: ServiceBlueprint<JsRuntimeDebuggerApi, string> = {
  namespace: CHROMIUM_JS_RUNTIME_DEBUGGER_NAMESPACE,

  getURN(payload: string) {
    return `${CHROMIUM_JS_RUNTIME_DEBUGGER_NAMESPACE}:${payload}`;
  },

  getDependencies(_payload: string) {
    // The device id lives in the payload, not in options, so the registry can
    // compute this URN without the resolved DeviceInfo.
    return { chromium: `${CHROMIUM_CDP_NAMESPACE}:${_payload}` };
  },

  // Deliberately NO recoverable(): the registry's self-heal disposes the node
  // before retrying, and dispose unlinks the captured console log. It would
  // also buy nothing — the only failure window while this node and ChromiumCdp
  // both stay RUNNING is a tab switch, where CDPClient.reconnect() re-points
  // the same client object and the cached node heals itself; a genuinely dead
  // socket arrives instead as ChromiumCdp's terminated cascade.

  async factory(deps, payload, options) {
    const opts = options as ChromiumJsdFactoryOptions | undefined;
    const device = opts?.device;
    if (!device) {
      throw new Error(
        `${CHROMIUM_JS_RUNTIME_DEBUGGER_NAMESPACE}.factory requires a resolved DeviceInfo via options.device. ` +
          `Use chromiumJsRuntimeDebuggerRef(device) when registering the service ref.`
      );
    }
    if (device.id !== payload) {
      throw new Error(
        `${CHROMIUM_JS_RUNTIME_DEBUGGER_NAMESPACE}.factory: payload "${payload}" does not match options.device.id "${device.id}".`
      );
    }

    const chromium = deps.chromium as ChromiumCdpApi;
    const cdp = chromium.cdp;
    const port = chromium.port;

    // Bridges a post-factory `disconnected` to `terminated`, which the registry
    // only binds once factory returns; the disconnect-during-factory window is
    // covered by ChromiumCdp's own terminated event cascading into us. Both
    // listeners must come back off in dispose — `cdp.events` outlives us.
    const events = new TypedEventEmitter<ServiceEvents>();
    const onDisconnected = (error?: Error) => {
      events.emit("terminated", error ?? new Error("Chromium CDP disconnected"));
    };
    cdp.events.on("disconnected", onDisconnected);

    const logWriter = new LogFileWriter(port);
    const consoleEvents = new TypedEventEmitter<ConsoleLogEvents>();
    let nextLogId = 0;

    const onConsoleAPI = (params: ConsoleAPICalledParams) => {
      // consoleAPICalled.timestamp is ms-since-epoch on Chrome as on Hermes (see
      // consoleTimestampToIso); keep it finite so streamed entries carry a usable
      // number.
      const ts = Number.isFinite(params.timestamp) ? params.timestamp : Date.now();
      const entry: ConsoleLogEntry = {
        id: nextLogId++,
        level: params.type,
        args: params.args.map((a) => ({
          type: a.type,
          value: a.value,
          description: a.description,
        })),
        message: formatConsoleArgs(params),
        timestamp: ts,
        stackTrace: params.stackTrace as ConsoleLogEntry["stackTrace"],
      };
      logWriter.write({
        id: entry.id,
        timestamp: consoleTimestampToIso(ts),
        level: entry.level,
        message: entry.message,
        stackTrace: entry.stackTrace,
      });
      consoleEvents.emit("log", entry);
    };
    cdp.events.on("consoleAPICalled", onConsoleAPI);

    const consoleServer = await createConsoleLogServer(consoleEvents, logWriter);

    // Best-effort: no Chromium-capable tool uses evaluateWithBinding today (its
    // only two callers are gated RN-only), so a failure here is not fatal.
    await cdp.addBinding("__argent_callback").catch(() => {});

    // The base registry IS the stub here. Nothing calls
    // `registerFromScriptParsed` on a Chromium session — page scripts carry
    // their own //# sourceMappingURL=data:... or rely on the browser
    // devtools' own resolution — so it holds no pending registrations and
    // `waitForPending()` resolves at once, which is what `debugger-status`
    // reports as `sourceMapReady`.
    const sourceMaps = new SourceMapsRegistry();
    const sourceResolver = makeStubSourceResolver();

    const api: JsRuntimeDebuggerApi = {
      port,
      // No Metro project root on Chromium; debugger-connect and debugger-status
      // document the field as empty here.
      projectRoot: "",
      deviceName: device.name ?? "Chromium",
      appName: "Chromium",
      logicalDeviceId: device.id,
      // No legacy RN inspector on Chromium.
      isNewDebugger: true,
      cdp,
      sourceResolver,
      sourceMaps,
      logWriter,
      consoleEvents,
      consoleSocketUrl: consoleServer.url,
    };

    return {
      api,
      dispose: async () => {
        cdp.events.off("consoleAPICalled", onConsoleAPI);
        cdp.events.off("disconnected", onDisconnected);
        await consoleServer.close();
        // `logWriter.close()` below unlinks the log file, and this dispose is
        // routinely triggered by another agent's `stop-all-simulator-servers`
        // (`ChromiumJsRuntimeDebugger` is in `DEVICE_OWNED_NAMESPACES`). The
        // breadcrumb is what keeps `debugger-log-registry`'s promise that an
        // empty result with no note means the app logged nothing. Only one key
        // to write, unlike Hermes: here `logicalDeviceId` IS `device.id`.
        const captured = logWriter.getStats().totalEntries;
        if (captured > 0) {
          recordReapedSession(
            "js-runtime-debugger",
            device.id,
            `The ${captured} captured console ${captured === 1 ? "entry" : "entries"} went with ` +
              `it — the log file is deleted on teardown, so this registry starts empty rather ` +
              `than the app having logged nothing.`
          );
        }
        logWriter.close();
        // Deliberately no `cdp.disconnect()` (unlike the Hermes blueprint): the
        // session belongs to ChromiumCdp and its other consumers — screenshot,
        // describe, gesture-tap, ...
      },
      events,
    };
  },
};
