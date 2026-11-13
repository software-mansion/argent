import {
  FAILURE_CODES,
  FailureError,
  type DeviceInfo,
  type Registry,
  type ToolDefinition,
} from "@argent/registry";
import {
  isInjectableBundleId,
  nativeDevtoolsRef,
  precheckNativeDevtools,
  type NativeDevtoolsApi,
  type NativeDevtoolsPrecheckBlock,
} from "../../blueprints/native-devtools";
import {
  androidNetworkInspectorRef,
  type AndroidNetworkInspectorApi,
} from "../../blueprints/android-network-inspector";
import {
  findJsCapture,
  forgetJsCapture,
  installNetworkInterceptor,
  jsCapturePayload,
  setJsCapture,
  type JsCapture,
  type JsCaptureMark,
  type NetworkInspectorApi,
} from "../../blueprints/network-inspector";
import type { JsRuntimeDebuggerApi } from "../../blueprints/js-runtime-debugger";
import { NETWORK_CAPTURE_MARK_SCRIPT } from "../../utils/debugger/scripts/network-interceptor";
import { canonicalDeviceId } from "../../utils/debugger/device-alias";
import { metroPort } from "../../utils/debugger/metro-port";
import { XcodeFirstLaunchPendingError } from "../../utils/dependency-errors";
import { xcodeFirstLaunchPending } from "../../utils/xcode-first-launch";
import { resolveDevice } from "../../utils/device-info";
import { ensureDeps } from "../../utils/check-deps";
import { classifyNotConnected, resolveDebuggerService } from "../debugger/not-connected";
import {
  CAPTURE_CAPABILITY,
  captureSchema,
  errorMessage,
  jsNotReached,
  otherPortHint,
  runLayers,
  withCaptureLock,
  type CaptureParams,
  type CaptureResult,
  type StartedLayer,
} from "./network-capture";

/** How long a start waits for an iOS app that is still connecting. */
const IOS_CONNECT_WAIT_MS = 5_000;
/** How long a start waits for the app's JS runtime to answer the read of the mark. */
const JS_ANSWER_WAIT_MS = 5_000;

export function createNetworkCaptureStartTool(
  registry: Registry
): ToolDefinition<CaptureParams, CaptureResult<StartedLayer>> {
  return {
    id: "network-capture-start",
    description: `Start network capture for an app on every layer that sees its requests: the app's JS runtime and the native layer (NSURLProtocol on iOS; OkHttp on Android, which needs a debuggable build).
Use when you are about to trigger requests you need to inspect, also as a step of an e2e test. Unlike native-network-logs and view-network-logs, which on iOS and Android only read and say capture is not started until this runs, this turns capture on and waits a few seconds for each layer to arm. A second call keeps the requests captured so far.
Returns { status, layers }: per layer, armed, and a reason when it is not armed (unavailable: true when nothing arms it without a change you must make). A native layer that is not armed yet arms by itself, for example at the app's next launch, and native capture follows the app into later processes that launch-app and restart-app start, until network-capture-stop. The JS layer arms only at a call of this tool: call it again once the app's JavaScript has loaded, and after a reload or relaunch. Capture can slow the app.
Fails with NETWORK_CAPTURE_UNAVAILABLE when no layer can capture this app.`,
    zodSchema: captureSchema,
    capability: CAPTURE_CAPABILITY,
    interaction: {
      startedMsg: ({ params }) => `Starting network capture for ${params.bundleId}`,
      completedMsg: ({ params }) => `Started network capture for ${params.bundleId}`,
      failedMsg: ({ params, failureSignal }) =>
        `Failed to start network capture for ${params.bundleId}: ${failureSignal.error_code}`,
    },
    // Each layer resolves its own service, so one that fails leaves the others running.
    services: () => ({}),
    async execute(_services, params) {
      const device = resolveDevice(params.udid);
      await ensureDeps(
        device.platform === "android"
          ? ["adb"]
          : device.platform === "ios-remote"
            ? ["sim-remote"]
            : ["xcrun"]
      );
      const port = metroPort({ device_id: params.udid, port: params.port });
      if (device.platform === "ios" && isInjectableBundleId(params.bundleId)) {
        await refuseWhileXcodeInstalls(registry, device, params.bundleId);
      }
      const layers = await withCaptureLock(params.udid, params.bundleId, () =>
        runLayers([
          device.platform !== "android" && !isInjectableBundleId(params.bundleId)
            ? Promise.resolve(
                unavailable(
                  "js",
                  `${params.bundleId} is an Apple system app, which runs no React Native JS`
                )
              )
            : startJsLayer(registry, params.udid, params.bundleId, port),
          device.platform === "android"
            ? startAndroidLayer(registry, device, params.bundleId, port)
            : startIosLayer(registry, device, params.bundleId, port),
        ])
      );
      if (layers.every((layer) => layer.unavailable)) {
        throw new FailureError(
          `Network capture cannot start for ${params.bundleId} on ${params.udid}: ` +
            layers.map((layer) => `${layer.layer}: ${layer.reason}`).join("; "),
          {
            error_code: FAILURE_CODES.NETWORK_CAPTURE_UNAVAILABLE,
            failure_stage: "network_capture_start",
            failure_area: "tool_server",
            error_kind: "unsupported",
          }
        );
      }
      return { status: "ok", layers };
    },
  };
}

function unavailable(layer: StartedLayer["layer"], reason: string): StartedLayer {
  return { layer, armed: false, reason, unavailable: true };
}

/**
 * The iOS layer fails while Xcode's component install is pending, for an app
 * that needs simctl to arm. The JS layer runs at the same time, so this check
 * runs before both: a start that fails leaves nothing recording in the app.
 */
async function refuseWhileXcodeInstalls(
  registry: Registry,
  device: DeviceInfo,
  bundleId: string
): Promise<void> {
  if (!xcodeFirstLaunchPending("simctl")) return;
  let api: NativeDevtoolsApi;
  try {
    const ref = nativeDevtoolsRef(device);
    api = await registry.resolveService<NativeDevtoolsApi>(ref.urn, ref.options);
  } catch {
    // The iOS layer reports this service unavailable.
    return;
  }
  // A connected app, and an app that a device provider lends, arm without simctl.
  if (api.armsEnv && !api.isConnected(bundleId)) throw new XcodeFirstLaunchPendingError("simctl");
}

/**
 * Stores the started intent, reads the mark, then installs. The mark is read
 * first, so the requests of the install count after it.
 */
async function startJsLayer(
  registry: Registry,
  udid: string,
  bundleId: string,
  port: number
): Promise<StartedLayer> {
  const device = canonicalDeviceId(udid) ?? udid;
  const payload = jsCapturePayload(port, device);
  const found = findJsCapture(device, bundleId);
  // The app's capture on another port moves here only once its runtime answers here.
  const other = found && found.port !== port ? found : undefined;
  // An interceptor an earlier start installed here stays in the app's JS context
  // until a reload, whatever becomes of this start.
  const installedHere = found !== undefined && !other && found.installed;
  let dbg: JsRuntimeDebuggerApi;
  try {
    dbg = await resolveDebuggerService(registry, { port, device_id: udid });
  } catch (err) {
    const reason = classifyNotConnected(err);
    const lost = reason === "metro_not_running" || reason === "device_mismatch";
    if (other) {
      const text = `${jsNotReached(reason, port, err)}; ${otherPortHint(bundleId, other.port)}`;
      return lost ? unavailable("js", text) : { layer: "js", armed: false, reason: text };
    }
    if (lost) {
      // No mark stays for a layer that is unavailable, but an interceptor an
      // earlier start installed records until a stop pauses it, so its entry stays.
      if (!found?.installed || found.paused) forgetJsCapture(device, bundleId);
      return unavailable("js", jsNotReached(reason, port, err));
    }
    // The app may connect, or answer, after this call; the next start arms it.
    // This start did not reach the JS context, so a pause a stop left there stays.
    setJsCapture(payload, {
      bundleId,
      intent: "started",
      mark: { install: null },
      installed: installedHere,
      ...(installedHere && found?.paused ? { paused: true as const } : {}),
    });
    return {
      layer: "js",
      armed: false,
      reason: `${jsNotReached(reason, port, err)}; call network-capture-start again once the app runs`,
    };
  }

  const appId = dbg.runtimeApp?.appId;
  if (appId !== undefined && appId !== bundleId) {
    // That app's own capture on this port stays as it is, and so does an
    // interceptor an earlier start of this app installed.
    if (!other && (!found?.installed || found.paused)) forgetJsCapture(device, bundleId);
    return unavailable(
      "js",
      `the JS runtime on Metro port ${port} is ${appId}'s, not ${bundleId}'s; ${
        other ? otherPortHint(bundleId, other.port) : `pass the port of ${bundleId}'s Metro`
      }`
    );
  }

  const capture: JsCapture = { bundleId, intent: "started", installed: installedHere };
  setJsCapture(payload, capture);
  try {
    capture.mark = await readMark(dbg);
  } catch (err) {
    // A runtime that does not answer the mark does not answer the install either,
    // and each evaluate of the install waits for the full CDP timeout. This start
    // did not reach the JS context, so a pause a stop left there stays.
    capture.mark = { install: null };
    if (installedHere && found?.paused) capture.paused = true;
    return {
      layer: "js",
      armed: false,
      reason: `the app's JS runtime did not answer (${errorMessage(err)}); call network-capture-start again once it answers`,
    };
  }
  try {
    const api = await registry.resolveService<NetworkInspectorApi>(`NetworkInspector:${payload}`);
    const install = await installNetworkInterceptor(api.cdp, payload, dbg.runtimeApp);
    if (install.installed) return { layer: "js", armed: true };
    if (install.reason === "no XMLHttpRequest yet") {
      return {
        layer: "js",
        armed: false,
        reason:
          "the app's JavaScript has not loaded yet; call network-capture-start again once it has",
      };
    }
    return {
      layer: "js",
      armed: false,
      reason: `the interceptor did not install: ${install.reason}`,
    };
  } catch (err) {
    return {
      layer: "js",
      armed: false,
      reason: `the interceptor did not install: ${errorMessage(err)}`,
    };
  }
}

/**
 * Where the context's log stands now; a context without the interceptor has no record yet.
 *
 * @throws when the evaluate fails, for example when the runtime does not answer within
 * {@link JS_ANSWER_WAIT_MS}
 */
async function readMark(dbg: JsRuntimeDebuggerApi): Promise<JsCaptureMark> {
  const answer = await dbg.cdp.evaluate(NETWORK_CAPTURE_MARK_SCRIPT, {
    timeout: JS_ANSWER_WAIT_MS,
  });
  try {
    const parsed = JSON.parse(String(answer)) as { install?: unknown; lastId?: unknown };
    return typeof parsed.install === "string" && typeof parsed.lastId === "number"
      ? { install: parsed.install, lastId: parsed.lastId }
      : { install: null };
  } catch {
    // An answer that is not a mark gives no record to count from.
    return { install: null };
  }
}

async function startIosLayer(
  registry: Registry,
  device: DeviceInfo,
  bundleId: string,
  port: number
): Promise<StartedLayer> {
  if (!isInjectableBundleId(bundleId)) {
    return unavailable(
      "ios-native",
      `${bundleId} is an Apple system app, which native network capture never covers`
    );
  }
  let api: NativeDevtoolsApi;
  try {
    const ref = nativeDevtoolsRef(device);
    api = await registry.resolveService<NativeDevtoolsApi>(ref.urn, ref.options);
  } catch (err) {
    return unavailable("ios-native", errorMessage(err));
  }

  let block: NativeDevtoolsPrecheckBlock | null = null;
  if (!api.isConnected(bundleId)) {
    try {
      block = await precheckNativeDevtools(api, device.id, bundleId);
    } catch (err) {
      // Its message says what to do, as every tool that needs simctl says it.
      if (err instanceof XcodeFirstLaunchPendingError) throw err;
      return unavailable("ios-native", errorMessage(err));
    }
    if (block?.status === "service_stale" || block?.status === "init_failed") {
      return unavailable("ios-native", block.message);
    }
  }

  const armed = await api.startNetworkCapture(
    bundleId,
    port,
    block?.status === "connect_pending" ? IOS_CONNECT_WAIT_MS : 0
  );
  if (armed) return { layer: "ios-native", armed: true };
  if (api.isConnected(bundleId)) {
    return {
      layer: "ios-native",
      armed: false,
      reason:
        api.networkRecords(bundleId)?.state().note ??
        "waiting for the agent to acknowledge Network.enable",
    };
  }
  if (!api.armsEnv) {
    return {
      layer: "ios-native",
      armed: false,
      reason: "the app has not connected through the device's devtools agent; it arms when it does",
    };
  }
  return {
    layer: "ios-native",
    armed: false,
    reason:
      block?.status === "restart_required"
        ? "no running process of the app can be armed; capture arms at its next launch, so call restart-app to capture it now"
        : "the app has not connected yet; capture arms when it does",
  };
}

async function startAndroidLayer(
  registry: Registry,
  device: DeviceInfo,
  bundleId: string,
  port: number
): Promise<StartedLayer> {
  let api: AndroidNetworkInspectorApi;
  try {
    const ref = androidNetworkInspectorRef(device, bundleId, port);
    api = await registry.resolveService<AndroidNetworkInspectorApi>(ref.urn, ref.options);
  } catch (err) {
    return unavailable("android-native", errorMessage(err));
  }
  const started = await api.startCapture(port);
  // The start's js layer tells whether the app's JavaScript requests are still recorded.
  if (started.unavailable) return unavailable("android-native", started.reason ?? "unavailable");
  return {
    layer: "android-native",
    armed: started.armed,
    ...(started.reason ? { reason: started.reason } : {}),
  };
}
