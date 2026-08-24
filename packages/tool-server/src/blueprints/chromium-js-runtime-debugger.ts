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

// Stubs for fields only consumed by debugger-inspect-element, which is locked
// out on Chromium (it depends on the React Native internal
// getInspectorDataForViewAtPoint). Keeping them shaped means chromium and
// metro paths can share a single api interface — tools that *don't* use them
// work uniformly, and any future tool that calls one on a chromium api hits a
// loud, clearly-named error instead of `undefined`.
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

class StubSourceMapsRegistry extends SourceMapsRegistry {
  constructor() {
    super("");
  }
  override async waitForPending(): Promise<void> {
    // No Metro source-map fetch loop on Chromium — page scripts already carry
    // their own //# sourceMappingURL=data:... or rely on the browser devtools'
    // own resolution path.
  }
}

export const chromiumJsRuntimeDebuggerBlueprint: ServiceBlueprint<JsRuntimeDebuggerApi, string> = {
  namespace: CHROMIUM_JS_RUNTIME_DEBUGGER_NAMESPACE,

  getURN(payload: string) {
    return `${CHROMIUM_JS_RUNTIME_DEBUGGER_NAMESPACE}:${payload}`;
  },

  getDependencies(_payload: string) {
    // The payload IS the device id (e.g. "chromium-cdp-9222") so we depend on
    // the matching ChromiumCdp service. Keeping the device id in the payload —
    // rather than passing through options — means the registry can compute
    // dependency URNs without needing the resolved DeviceInfo.
    return { chromium: `${CHROMIUM_CDP_NAMESPACE}:${_payload}` };
  },

  // Deliberately NO recoverable() here. The registry's self-heal disposes the
  // recovering node before it retries, and this blueprint's dispose closes the
  // LogFileWriter — which UNLINKS the session's captured console log from disk
  // (log-file-writer.ts) — so a recovery pass would destroy the logs whether or
  // not the retry then succeeds. It would also buy nothing: the one window
  // where a call fails while this node and its ChromiumCdp dependency stay
  // RUNNING is a tab switch, where CDPClient.reconnect() rejects in-flight
  // requests with CONNECTION_CLOSED (late sends with NOT_CONNECTED) but
  // re-points the SAME client object at the new tab — the cached node heals
  // itself for the next call without any dispose. The failing call surfaces a
  // classified error that debugger-status maps to a structured "reconnecting"
  // result with retry-once guidance. A genuinely dead Chromium socket instead
  // fires ChromiumCdp's own terminated event, whose teardown cascades into this
  // dependent — the node leaves RUNNING and the next call re-resolves fresh.
  // (Same log-preservation reasoning as debugger-log-registry's missing socket
  // gate — see that tool's comment.)

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

    // Attach the terminated bridge *before* any awaits below. This is mainly
    // about post-factory disconnects: once the registry binds to our `events`
    // (after factory returns), a `disconnected` here translates cleanly to
    // `terminated` so the service is torn down. The disconnect-DURING-factory
    // window is handled by the upstream ChromiumCdp service, which has its own
    // `terminated` event already bound to the registry — when it fires, the
    // registry cascades teardown into us. So this listener and the upstream
    // one cooperate: upstream covers the factory-init window; this one covers
    // everything after factory returns. The dispose closure must `off` both
    // listeners symmetrically — otherwise the upstream `cdp.events` outlives
    // our blueprint and would emit into a disposed event bus.
    const events = new TypedEventEmitter<ServiceEvents>();
    const onDisconnected = (error?: Error) => {
      events.emit("terminated", error ?? new Error("Chromium CDP disconnected"));
    };
    cdp.events.on("disconnected", onDisconnected);

    const logWriter = new LogFileWriter(port);
    const consoleEvents = new TypedEventEmitter<ConsoleLogEvents>();
    let nextLogId = 0;

    const onConsoleAPI = (params: ConsoleAPICalledParams) => {
      // consoleAPICalled.timestamp is ms-since-epoch on both Chrome and Hermes/RN
      // (see consoleTimestampToIso). Keep the numeric entry.timestamp finite: a
      // non-finite value (CDP server bug / future protocol revision) is coerced to
      // now, matching the ISO helper below, so the streamed entry and the log file
      // stay consistent.
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

    // Best-effort: bind a callback name so evaluateWithBinding works if a
    // future Chromium tool wants it. Failure is non-fatal — the existing
    // four ported tools don't use it. Future tools that DO use bindings must
    // re-attempt addBinding themselves and surface their own errors loudly.
    await cdp.addBinding("__argent_callback").catch(() => {});

    const sourceMaps = new StubSourceMapsRegistry();
    const sourceResolver = makeStubSourceResolver();

    const api: JsRuntimeDebuggerApi = {
      port,
      // Chromium apps have no Metro project root. Empty string keeps the
      // contract type-clean; callers that care (only inspect-element via the
      // source resolver) are gated out before they ever touch this field.
      projectRoot: "",
      deviceName: device.name ?? "Chromium",
      appName: "Chromium",
      logicalDeviceId: device.id,
      // Chromium always speaks the new CDP — there is no Hermes-legacy mode.
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
        // Same breadcrumb the Hermes blueprint leaves, for the same reason:
        // `logWriter.close()` unlinks the log file, and since
        // `ChromiumJsRuntimeDebugger` joined `DEVICE_OWNED_NAMESPACES` this
        // dispose is routinely triggered by another agent's
        // `stop-all-simulator-servers`. Without it `debugger-log-registry`
        // reports `totalEntries: 0` with no note — and its description promises
        // that, absent the note, empty means the app logged nothing. That
        // promise covers V8 as much as Hermes, so this side has to keep it too.
        //
        // One id, unlike Hermes: a chromium device's `logicalDeviceId` IS its
        // `device.id` (set from it in the api above), so there is no second key
        // to write.
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
        // Do NOT disconnect the cdp — it belongs to the ChromiumCdp service.
        // Disposing this blueprint must leave the underlying CDP session alive
        // for other consumers (screenshot, describe, gesture-tap, ...).
      },
      events,
    };
  },
};
