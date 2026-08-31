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
import { recordReapedSession, describeLostHistory } from "../utils/reaped-sessions";
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

  // Deliberately NO recoverable() here. The registry's self-heal disposes the
  // recovering node before it retries, and this blueprint's dispose closes the
  // LogFileWriter, ending the capture session whether or not the retry then
  // succeeds: the registry mints a new one over a new path, and the old file is
  // either unlinked or — since a self-heal fires on NOT_CONNECTED, which means a
  // socket that is not OPEN — kept under a breadcrumb for a session that never
  // died. It would also buy nothing: the one window where a call fails while
  // this node and its ChromiumCdp dependency stay RUNNING is a tab switch,
  // where CDPClient.reconnect() rejects in-flight
  // requests with CONNECTION_CLOSED (late sends with NOT_CONNECTED) but
  // re-points the SAME client object at the new tab — the cached node heals
  // itself for the next call without any dispose. The failing call surfaces a
  // classified error that debugger-status maps to a structured "reconnecting"
  // result with retry-once guidance. A genuinely dead Chromium socket instead
  // fires ChromiumCdp's own terminated event, whose teardown cascades into this
  // dependent — the node leaves RUNNING and the next call re-resolves fresh.
  // (Same reasoning as debugger-log-registry's missing socket gate — a dispose
  // buys nothing here and costs the session; see that tool's comment.)

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
    // Deliberately NOT where "did the renderer die?" is answered — dispose reads
    // the socket for that. When the renderer goes away, `ChromiumCdp`'s own
    // handler for this event runs first and cascades a teardown into us, and
    // that dispose removes this listener before the emit reaches it, so a latch
    // set here would still be false on the one path it would exist for.
    const onDisconnected = (error?: Error) => {
      events.emit("terminated", error ?? new Error("Chromium CDP disconnected"));
    };
    const logWriter = new LogFileWriter(port);
    // Registered after the writer, whose constructor mkdir -p's ~/.argent/tmp
    // and throws on an unwritable home: this client belongs to `ChromiumCdp`
    // and survives a failed factory, so a listener attached before the throw
    // would stay on it forever.
    cdp.events.on("disconnected", onDisconnected);
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

    // No dispose exists until this factory returns, so a throw here leaves
    // everything set up above with nothing to ever undo it: the writer's fd, its
    // file and its keepalive would last as long as the process — the keepalive
    // holding that file out of `pruneStaleLogs` for exactly that long — and the
    // two listeners would stay on `ChromiumCdp`'s client, which survives this
    // failure, feeding console entries into a session that no longer exists —
    // and, once the rollback below closes the writer, into a closed one. The
    // client itself is that service's to disconnect, not ours.
    let consoleServer: Awaited<ReturnType<typeof createConsoleLogServer>>;
    try {
      consoleServer = await createConsoleLogServer(consoleEvents, logWriter);
    } catch (err) {
      cdp.events.off("consoleAPICalled", onConsoleAPI);
      cdp.events.off("disconnected", onDisconnected);
      logWriter.close();
      throw err;
    }

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
        // Same breadcrumb the Hermes blueprint leaves, for the same reason:
        // this dispose ends the capture session, and `ChromiumJsRuntimeDebugger`
        // being in `DEVICE_OWNED_NAMESPACES` makes it routinely triggered by
        // another agent's `stop-all-simulator-servers`.
        // Without it `debugger-log-registry` reports `totalEntries: 0` with no
        // note, and its description reads a bare zero as "nothing captured
        // since this session began" — with nothing to say the session changed,
        // the reader takes that for the one that died. The next resolve always
        // builds a fresh writer over a new path, so the count restarts at 0
        // whether or not the old file survives below.
        //
        // One id, unlike Hermes: a chromium device's `logicalDeviceId` IS its
        // `device.id` (set from it in the api above), so there is no second key
        // to write.
        //
        // The socket, not the `disconnected` event, because on the path this
        // exists for that event never reaches us: a dead renderer closes the
        // shared client, `ChromiumCdp`'s handler runs before ours and
        // synchronously cascades a teardown into this service, and the `off`
        // above then unregisters our handler mid-emit — `TypedEventEmitter`
        // iterates the live listener set, so it is skipped rather than called.
        // `CDPClient` nulls its socket before emitting, so the socket is the
        // durable form of the same fact. Its one ambiguity is a tab switch,
        // where `reconnect()` also leaves the client briefly socket-less with
        // the renderer alive; a teardown landing inside that window keeps a file
        // the pruner reclaims a day later, which is the cheaper way to be wrong.
        const runtimeDied = !cdp.isConnected();
        const captured = logWriter.getStats().totalEntries;
        const keptAt = runtimeDied && logWriter.hasFile() ? logWriter.getFilePath() : undefined;
        if (captured > 0) {
          recordReapedSession(
            "js-runtime-debugger",
            device.id,
            describeLostHistory(captured, keptAt),
            { cause: runtimeDied ? "runtime-death" : "teardown", keptAt }
          );
        }
        // After the socket read, not before it: an await here would let a
        // teardown's socket close mid-dispose and be reported as a death.
        await consoleServer.close();
        // Gated on `captured` for the same reason the breadcrumb is: a death
        // that logged nothing leaves an empty file no breadcrumb names and
        // nothing reclaims for a day.
        logWriter.close({ keepFile: runtimeDied && captured > 0 });
        // Do NOT disconnect the cdp — it belongs to the ChromiumCdp service.
        // Disposing this blueprint must leave the underlying CDP session alive
        // for other consumers (screenshot, describe, gesture-tap, ...).
      },
      events,
    };
  },
};
