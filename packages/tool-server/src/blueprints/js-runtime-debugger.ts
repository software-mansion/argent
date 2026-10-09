import {
  FAILURE_CODES,
  FailureError,
  TypedEventEmitter,
  getFailureSignal,
  type ServiceBlueprint,
  type ServiceEvents,
} from "@argent/registry";
import { discoverMetro } from "../utils/debugger/discovery";
import {
  externalJsDebuggerUrl,
  isResolvedMetroPort,
  publishedMetroPort,
} from "../utils/debugger/metro-port";
import { classifyDevice } from "../utils/device-info";
import { assertExternalCapability } from "../utils/external-devices";
import { proxyStart } from "../utils/sim-remote";
import { selectTarget } from "../utils/debugger/target-selection";
import {
  rememberDeviceAlias,
  forgetDeviceAlias,
  rememberLogicalKeyedDevice,
  forgetLogicalKeyedDevice,
} from "../utils/debugger/device-alias";
import { recordReapedSession, describeLostHistory } from "../utils/reaped-sessions";
import { CDPClient, type ConsoleAPICalledParams } from "../utils/debugger/cdp-client";
import { createSourceResolver, type SourceResolver } from "../utils/debugger/source-resolver";
import { SourceMapsRegistry } from "../utils/debugger/source-maps";
import { DISABLE_LOGBOX_SCRIPT } from "../utils/debugger/scripts/disable-logbox";
import { LogFileWriter } from "../utils/debugger/log-file-writer";
import { consoleTimestampToIso } from "../utils/debugger/console-timestamp";
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
        reject(
          new FailureError("Failed to bind console log server", {
            error_code: FAILURE_CODES.JS_RUNTIME_CONSOLE_SERVER_BIND_FAILED,
            failure_stage: "js_runtime_console_server_bind",
            failure_area: "tool_server",
            error_kind: "network",
          })
        );
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

  getURN(payload: string) {
    return `${JS_RUNTIME_DEBUGGER_NAMESPACE}:${payload}`;
  },

  // Only the send() guard's DEBUGGER_CDP_NOT_CONNECTED proves the request never
  // left the host, so only it is safe to retry. CONNECTION_CLOSED and
  // REQUEST_TIMEOUT reject requests that were delivered and may have taken
  // effect; Metro discovery and target-selection codes throw before the node is
  // RUNNING, where the registry never consults this.
  recoverable(error: unknown): boolean {
    return getFailureSignal(error)?.error_code === FAILURE_CODES.DEBUGGER_CDP_NOT_CONNECTED;
  },

  async factory(_deps, payload, options?) {
    const colonIdx = payload.indexOf(":");
    if (colonIdx < 0) {
      throw new FailureError(
        `JsRuntimeDebugger payload must be "port:deviceId", got: "${payload}"`,
        {
          error_code: FAILURE_CODES.JS_RUNTIME_PAYLOAD_INVALID,
          failure_stage: "js_runtime_debugger_payload",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }
    const deviceId = payload.slice(colonIdx + 1);
    if (!deviceId) {
      throw new FailureError(`JsRuntimeDebugger payload missing deviceId: "${payload}"`, {
        error_code: FAILURE_CODES.JS_RUNTIME_PAYLOAD_DEVICE_MISSING,
        failure_stage: "js_runtime_debugger_payload",
        failure_area: "tool_server",
        error_kind: "validation",
      });
    }
    // Sliced rather than re-derived from `port` below: the reaped-session scope
    // is keyed on this text, and its readers recompute it from the same port
    // resolution that built this URN.
    const portKey = payload.slice(0, colonIdx);
    const port = parseInt(portKey, 10);
    if (!Number.isFinite(port)) {
      throw new FailureError(`JsRuntimeDebugger payload has invalid port: "${payload}"`, {
        error_code: FAILURE_CODES.JS_RUNTIME_PAYLOAD_PORT_INVALID,
        failure_stage: "js_runtime_debugger_payload",
        failure_area: "tool_server",
        error_kind: "validation",
      });
    }

    // A remote (cloud) sim reaches the developer's LOCAL Metro over a sim-remote
    // reverse tunnel: the sim's localhost:<port> is forwarded out to this host.
    // Only the app→Metro hop needs it — discoverMetro below still reaches Metro
    // directly. proxyStart tolerates "already started", so re-ensuring it on
    // every connect is cheap.
    if (classifyDevice(deviceId) === "ios-remote") {
      await proxyStart(deviceId, port);
    }

    // Read here, not at dispose: a provider dropping this device is one of the
    // things that ends the session, and it takes with it the descriptor this
    // answer turns on. Tells the breadcrumb's readers whether this session is
    // the one a call naming no port addresses, and so whether a later such call
    // may address it by a different port.
    const scopeWasResolved = isResolvedMetroPort(deviceId, port);

    /**
     * Mechanism gate for provider-supplied devices. Every tool that speaks CDP
     * to the app's JS runtime (the debugger family, the React profiler and the
     * network inspector via its declared dependency on this service) resolves
     * this blueprint, so one check here covers them all. A no-op for every
     * device Argent booted itself.
     */
    await assertExternalCapability(JS_RUNTIME_DEBUGGER_NAMESPACE, deviceId, "js-debugger");

    const metro = await discoverMetro(port).catch((error: unknown) => {
      /**
       * An explicit `port` outranks the one a provider publishes, so a caller
       * that passed `8081` out of habit lands here with no way to guess why.
       */
      const published = publishedMetroPort(deviceId, port);

      if (published !== undefined && error instanceof FailureError) {
        error.message +=
          ` The provider offering this device publishes Metro on port ${published} — ` +
          `omit the 'port' parameter to use it.`;
      }

      throw error;
    });
    const selected = selectTarget(metro.targets, port, {
      ...options,
      deviceId,
    });

    /**
     * React Native's inspector-proxy keeps one debugger per device and
     * terminates the incumbent to admit a new one. Connecting to Metro's
     * target would therefore evict a provider already debugging this runtime,
     * and the two would reconnect in a loop. A provider avoids that by
     * re-serving its own connection and publishing the socket.
     *
     * Only the socket comes from the provider. `selected` still supplies the
     * session's identity below, so names, alias and source-map roots are the
     * same either way.
     *
     * Taken only while this session is on the bundler the provider published.
     * `publishedMetroPort` answers with that port exactly when it is not the
     * one in use, which is the caller having named another bundler. Its runtime
     * is not the one the provider re-serves, so the socket belongs to a
     * different app than the target metadata above. Sending CDP down it would
     * drive one runtime while reporting another, silently, across the debugger,
     * the network inspector and the profiler alike.
     *
     * A provider that published a socket but no `metroPort` names no bundler to
     * disagree with, so its socket still stands.
     */
    const onPublishedBundler = publishedMetroPort(deviceId, port) === undefined;
    const proxied = onPublishedBundler ? externalJsDebuggerUrl(deviceId) : undefined;

    const cdp = new CDPClient(proxied ?? selected.webSocketUrl);
    await cdp.connect();

    const sourceMaps = new SourceMapsRegistry();

    cdp.events.on("scriptParsed", (script) => {
      sourceMaps.registerFromScriptParsed(script.url, script.scriptId, script.sourceMapURL);
    });

    const ignore = () => {};
    const warnOnError = (label: string) => (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[JsRuntimeDebugger:${port}] ${label} failed (non-fatal): ${msg}\n`);
    };

    // No dispose exists until this factory returns, so anything that throws
    // from here on leaves the connected socket with nothing to close it, and
    // Metro holds a debugger target open for the life of the process. The
    // un-`catch`ed sends are the reachable case: a request timeout against a
    // frozen runtime is `runtime_unresponsive`, a documented not-connected
    // state.
    let logWriter: LogFileWriter;
    let sourceResolver: SourceResolver;
    try {
      /**
       * Through a provider's socket Argent is one of several clients on a single
       * connection, so this setup splits by what it touches.
       *
       * These four are per-runtime, not per-client. On a shared session they reach
       * into someone else's debugger: `setPauseOnExceptions: "none"` would disarm
       * exception breakpoints a user set, from a tool they did not run. The client
       * that owns the session owns its global state.
       *
       * The rest are unconditional. Enables are idempotent, and a binding only
       * adds one. Other clients can ignore it by name.
       */
      if (!proxied) {
        await cdp.send("FuseboxClient.setClientMetadata", {}).catch(ignore);
      }

      await cdp.send("ReactNativeApplication.enable", {}).catch(ignore);
      await cdp.send("Runtime.enable");
      await cdp.send("Debugger.enable", { maxScriptsCacheSize: 100_000_000 });

      if (!proxied) {
        await cdp.send("Debugger.setPauseOnExceptions", { state: "none" });
        await cdp.send("Debugger.setAsyncCallStackDepth", { maxDepth: 32 }).catch(ignore);
        await cdp.send("Runtime.runIfWaitingForDebugger").catch(ignore);
      }

      await cdp.addBinding("__argent_callback");

      await cdp.evaluate(DISABLE_LOGBOX_SCRIPT).catch(warnOnError("DISABLE_LOGBOX_SCRIPT"));

      await sourceMaps.waitForPending();

      sourceResolver = createSourceResolver(port, metro.projectRoot);

      // Its constructor mkdir -p's ~/.argent/tmp, which an unwritable home
      // makes throw.
      logWriter = new LogFileWriter(port);
    } catch (err) {
      await cdp.disconnect();
      throw err;
    }
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
        timestamp: consoleTimestampToIso(entry.timestamp),
        level: entry.level,
        message: entry.message,
        stackTrace: entry.stackTrace,
      });
      consoleEvents.emit("log", entry);
    };
    cdp.events.on("consoleAPICalled", onConsoleAPI);

    // Same rule, now with a writer to undo as well: its fd, its file and its
    // hourly keepalive would last as long as the process, and the keepalive
    // would hold that file out of `pruneStaleLogs` for exactly that long.
    let consoleServer: Awaited<ReturnType<typeof createConsoleLogServer>>;
    try {
      consoleServer = await createConsoleLogServer(consoleEvents, logWriter);
    } catch (err) {
      // Off before close, for the reason the dispose below gives.
      cdp.events.off("consoleAPICalled", onConsoleAPI);
      logWriter.close();
      await cdp.disconnect();
      throw err;
    }

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

    // Connect is the only place both ids are known at once; the alias keeps a
    // later tool that forwards the logicalDeviceId on this instance instead of
    // opening a second one. See utils/debugger/device-alias.ts.
    rememberDeviceAlias(api.logicalDeviceId, deviceId);
    // Equal ids mean the caller connected with the logicalDeviceId itself, as
    // `selectTarget` demands once a second device shares this Metro. Nothing
    // then joins the session to a udid or serial, so a `list-devices`-scoped
    // `stop-all-simulator-servers` can only report it, never reach it.
    rememberLogicalKeyedDevice(api.logicalDeviceId, deviceId);

    const events = new TypedEventEmitter<ServiceEvents>();

    cdp.events.on("disconnected", (error) => {
      events.emit(
        "terminated",
        error ??
          new FailureError("CDP disconnected", {
            error_code: FAILURE_CODES.JS_RUNTIME_CDP_DISCONNECTED,
            failure_stage: "js_runtime_debugger_cdp_lifecycle",
            failure_area: "tool_server",
            error_kind: "network",
          })
      );
    });

    return {
      api,
      dispose: async () => {
        // Before the writer closes below: `disconnect()` waits out a close
        // handshake, and a frame delivered in that window would reach a closed
        // writer, whose `write` throws.
        cdp.events.off("consoleAPICalled", onConsoleAPI);
        // This dispose ends the capture session — up to 50,000 captured console
        // entries stop being reachable through the registry, because the next
        // resolve builds a new writer over a new path. That is invisible, and
        // `JsRuntimeDebugger` is in the teardown's namespace set, so this
        // dispose is routinely triggered by another agent's
        // `stop-all-simulator-servers`. Leave a breadcrumb so
        // `debugger-log-registry`'s otherwise silent `totalEntries: 0` can say
        // what happened to the history, and where it went: on a runtime death
        // `close` below keeps the file, so the breadcrumb can name it.
        //
        // Only when there IS history to lose, and under every id this device
        // answers to: the caller may read back with either the id it connected
        // with or the `logicalDeviceId` Metro echoed, and `forgetDeviceAlias`
        // below removes the only thing that joins them. One call, so the two
        // are one event and reading either spends both; a copy left behind
        // would explain some later unrelated answer, and the next teardown
        // would reclaim the file this one named.
        //
        // The socket is the whole of "did the app die?" here, and the
        // `disconnected` event is not consulted at all: `CDPClient` nulls its
        // socket before emitting, so every death this blueprint can see is
        // already visible as a closed socket — including the ones that never
        // reach a listener, where `debugger-status`'s stale_connection branch or
        // the registry's `recoverable` self-heal disposes in the window between
        // the socket leaving OPEN and the close event dispatching. Nothing
        // re-points this client either: `reconnect()` is Chromium's tab switch
        // alone, so an OPEN socket here really does mean a live app, and an
        // explicit teardown removes the file.
        const runtimeDied = !cdp.isConnected();
        const captured = logWriter.getStats().totalEntries;
        const keptAt = runtimeDied && logWriter.hasFile() ? logWriter.getFilePath() : undefined;
        if (captured > 0) {
          const ids = [deviceId];
          if (api.logicalDeviceId) ids.push(api.logicalDeviceId);
          recordReapedSession("js-runtime-debugger", ids, describeLostHistory(captured, keptAt), {
            cause: runtimeDied ? "runtime-death" : "teardown",
            keptAt,
            // What proves a later event is this same device rather than the one
            // `selectTarget`'s fallback minted on this device's id: Metro names
            // the device, the caller's id does not. Undefined for a legacy
            // inspector, which is the whole of the reason the store will not
            // reclaim on matching ids alone.
            logicalId: api.logicalDeviceId,
            // This device can hold another session on another Metro port, with
            // its own log file; without the port that one's death would reclaim
            // this file, and its teardown would replace the record naming it.
            scope: portKey,
            scopeWasResolved,
          });
        }
        forgetDeviceAlias(api.logicalDeviceId);
        forgetLogicalKeyedDevice(deviceId);
        await consoleServer.close();
        // Gated on `captured` for the same reason the breadcrumb is: a death
        // that logged nothing leaves an empty file no breadcrumb names and
        // nothing reclaims for a day.
        logWriter.close({ keepFile: runtimeDied && captured > 0 });
        await cdp.disconnect();
      },
      events,
    };
  },
};
