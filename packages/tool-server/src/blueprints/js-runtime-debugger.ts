import {
  FAILURE_CODES,
  FailureError,
  TypedEventEmitter,
  getFailureSignal,
  type ServiceBlueprint,
  type ServiceEvents,
} from "@argent/registry";
import { discoverMetro } from "../utils/debugger/discovery";
import { externalJsDebuggerUrl, publishedMetroPort } from "../utils/debugger/metro-port";
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
import { recordReapedSession } from "../utils/reaped-sessions";
import { CDPClient, type ConsoleAPICalledParams } from "../utils/debugger/cdp-client";
import { createSourceResolver, type SourceResolver } from "../utils/debugger/source-resolver";
import { SourceMapsRegistry } from "../utils/debugger/source-maps";
import { DISABLE_LOGBOX_SCRIPT } from "../utils/debugger/scripts/disable-logbox";
import { LogFileWriter, type RichLogEntry } from "../utils/debugger/log-file-writer";
import { consoleTimestampToIso } from "../utils/debugger/console-timestamp";

export const JS_RUNTIME_DEBUGGER_NAMESPACE = "JsRuntimeDebugger";

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

/**
 * What a React Native runtime says about itself in
 * `ReactNativeApplication.metadataUpdated`, its answer to the enable sent at
 * connect. Metro's target list names the app but not its platform, so this is
 * where a runtime says it runs on Android or iOS. Fields stay unset when the
 * runtime does not send it.
 */
export interface RuntimeAppMetadata {
  /** Android package name or iOS bundle id. */
  appId?: string;
  /** "android" or "ios". */
  platform?: string;
}

export interface JsRuntimeDebuggerApi {
  port: number;
  projectRoot: string;
  deviceName: string;
  appName: string;
  logicalDeviceId: string | undefined;
  runtimeApp?: RuntimeAppMetadata;
  isNewDebugger: boolean;
  cdp: CDPClient;
  sourceResolver: SourceResolver;
  sourceMaps: SourceMapsRegistry;
  logWriter: LogFileWriter;
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
    const port = parseInt(payload.slice(0, colonIdx), 10);
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

    /**
     * Through a provider's socket Argent is one of several clients on a single
     * connection, so this setup splits by what it touches.
     *
     * These four are per-runtime, not per-client. On a shared session they reach
     * into someone else's debugger: `setPauseOnExceptions: "none"` would disarm
     * exception breakpoints a user set, from a tool they did not run. The client
     * that owns the session owns its global state.
     *
     * The remaining setup only affects Argent's client. Enables are idempotent,
     * and a binding only adds one. Other clients can ignore it by name.
     */
    if (!proxied) {
      await cdp.send("FuseboxClient.setClientMetadata", {}).catch(ignore);
    }

    const runtimeApp: RuntimeAppMetadata = {};
    cdp.events.on("event", (method, params) => {
      if (method !== "ReactNativeApplication.metadataUpdated") return;
      if (typeof params.appIdentifier === "string") runtimeApp.appId = params.appIdentifier;
      if (typeof params.platform === "string") runtimeApp.platform = params.platform;
    });
    await cdp.send("ReactNativeApplication.enable", {}).catch(ignore);
    await cdp.send("Runtime.enable");
    // Metro can inline a full source map on Debugger.enable. Only skip it for
    // targets advertising the modern inspector: legacy Hermes (RN <= 0.72,
    // including Vega) requires it for evaluation. A reactNative block alone
    // does not prove the runtime uses the modern inspector.
    const enableDebugger =
      !!proxied || selected.target.reactNative?.capabilities?.prefersFuseboxFrontend !== true;
    if (enableDebugger) {
      await cdp.send("Debugger.enable", { maxScriptsCacheSize: 100_000_000 });
    }

    if (!proxied) {
      if (enableDebugger) {
        await cdp.send("Debugger.setPauseOnExceptions", { state: "none" });
        await cdp.send("Debugger.setAsyncCallStackDepth", { maxDepth: 32 }).catch(ignore);
      }
      await cdp.send("Runtime.runIfWaitingForDebugger").catch(ignore);
    }

    await cdp.addBinding("__argent_callback");

    await cdp.evaluate(DISABLE_LOGBOX_SCRIPT).catch(warnOnError("DISABLE_LOGBOX_SCRIPT"));

    await sourceMaps.waitForPending();

    const sourceResolver = createSourceResolver(port, metro.projectRoot);

    const logWriter = new LogFileWriter(port);
    let nextLogId = 0;

    cdp.events.on("consoleAPICalled", (params) => {
      logWriter.write({
        id: nextLogId++,
        timestamp: consoleTimestampToIso(params.timestamp),
        level: params.type,
        message: formatConsoleArgs(params),
        stackTrace: params.stackTrace as RichLogEntry["stackTrace"],
      });
    });

    const api: JsRuntimeDebuggerApi = {
      port,
      projectRoot: metro.projectRoot,
      deviceName: selected.deviceName,
      appName: selected.target.title,
      logicalDeviceId: selected.target.reactNative?.logicalDeviceId,
      runtimeApp,
      isNewDebugger: selected.isNewDebugger,
      cdp,
      sourceResolver,
      sourceMaps,
      logWriter,
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
        // `logWriter.close()` below unlinks the log file unless the socket
        // dropped (likely an app crash, so the log is evidence), and this
        // dispose is routinely another agent's `stop-all-simulator-servers`.
        // Breadcrumb so `debugger-log-registry` can say where the history went
        // — only when there was history, and under both ids, since
        // `forgetDeviceAlias` below drops the only join between them.
        const captured = logWriter.getStats().totalEntries;
        const keepFile = captured > 0 && !cdp.isConnected();
        if (captured > 0) {
          const entries = `${captured} captured console ${captured === 1 ? "entry" : "entries"}`;
          const salvage = keepFile
            ? `The log file with its ${entries} is kept at ${logWriter.getFilePath()}.`
            : `The ${entries} went with it — the log file is deleted on teardown, so this ` +
              `registry starts empty rather than the app having logged nothing.`;
          recordReapedSession(
            "js-runtime-debugger",
            [deviceId, api.logicalDeviceId],
            salvage,
            keepFile
          );
        }
        forgetDeviceAlias(api.logicalDeviceId);
        forgetLogicalKeyedDevice(deviceId);
        logWriter.close({ keepFile });
        await cdp.disconnect();
      },
      events,
    };
  },
};
