import {
  FAILURE_CODES,
  FailureError,
  getFailureSignal,
  type DeviceInfo,
  type Registry,
  type ToolDefinition,
} from "@argent/registry";
import {
  isInjectableBundleId,
  nativeDevtoolsRef,
  precheckNativeDevtools,
  PROVIDER_CAPTURE_OFF,
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
  setJsUnavailable,
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
import { assertSupported } from "../../utils/capability";
import { ensureDeps } from "../../utils/check-deps";
import { macosAppRef, macosLaunchRefusal, type MacosAppApi } from "../../blueprints/macos-app";
import { requireMacosAppOfBundle } from "../native-devtools/macos-view-hierarchy";
import { classifyNotConnected, resolveDebuggerService } from "../debugger/not-connected";
import {
  CAPTURE_CAPABILITY,
  captureSchema,
  errorMessage,
  jsNotReached,
  otherPortHint,
  runLayers,
  setIosUnavailable,
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
    description: `Start network capture for an app on every layer that sees its requests: the app's JS runtime and the native layer (NSURLProtocol on iOS; OkHttp on Android, which needs a debuggable build).<flag:macos-apps> On a Mac app, only its native NSURLProtocol layer.</flag:macos-apps>
Use when you are about to trigger requests you need to inspect, also as a step of an e2e test. Unlike the read tools (native-network-logs and view-network-logs on iOS and Android<flag:macos-apps>, native-network-logs on a Mac app</flag:macos-apps>), which only read and say capture is not started until this runs, this turns capture on and waits a few seconds for each layer to arm. A second call keeps the requests captured so far.
Returns { status, layers }: per layer, armed, and a reason when it is not armed (unavailable: true when nothing arms it without a change you must make). A native layer that is not armed yet arms by itself, for example at the app's next launch (on Android, only a launch by launch-app or restart-app), and native capture follows the app into later processes that launch-app and restart-app start, until network-capture-stop. On a device whose devtools agent argent attached to, a relaunch ends native capture: call this tool again after it. The JS layer arms only at a call of this tool: call it again once the app's JavaScript has loaded, and after a reload or relaunch. Capture can slow the app.
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
      // Only the HTTP gate checks the capability, and an e2e `tool:` step does not pass it.
      assertSupported("network-capture-start", CAPTURE_CAPABILITY, device);
      if (device.platform === "macos") {
        const layer = await withCaptureLock(params.udid, params.bundleId, () =>
          startMacosLayer(registry, device, params)
        );
        return { status: "ok", layers: [layer] };
      }
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
            : startJsLayer(registry, params.logicalDeviceId ?? params.udid, params.bundleId, port),
          device.platform === "android"
            ? startAndroidLayer(registry, device, params.bundleId, port)
            : startIosLayer(registry, device, params.bundleId, port),
        ])
      );
      if (layers.every((layer) => layer.unavailable)) throw unavailableError(params, layers);
      return { status: "ok", layers };
    },
  };
}

/**
 * A Mac app has one layer, in the app's own service. It is resolved under the
 * lock, so a start that waited for a stop-all-simulator-servers of the app arms
 * the service that comes after it.
 */
async function startMacosLayer(
  registry: Registry,
  device: DeviceInfo,
  params: CaptureParams
): Promise<StartedLayer> {
  const ref = macosAppRef(device);
  const app = requireMacosAppOfBundle(
    { macosApp: await registry.resolveService<MacosAppApi>(ref.urn, ref.options) },
    device,
    "network-capture-start",
    params.bundleId
  );
  // No launch of an Apple app loads argent's library, so nothing arms it.
  if (!isInjectableBundleId(params.bundleId)) {
    throw unavailableError(params, [
      unavailable(
        "macos-native",
        `${params.bundleId} is an Apple app; argent captures only apps it can load its library into, such as your own builds`
      ),
    ]);
  }
  // Nor does a launch arm an app that argent refuses to start.
  const refusal = app.isConnected() ? undefined : await macosLaunchRefusal(params.bundleId);
  if (refusal) throw unavailableError(params, [unavailable("macos-native", refusal)]);
  const { armed, reason } = await app.startNetworkCapture();
  return { layer: "macos-native", armed, ...(reason ? { reason } : {}) };
}

function unavailableError(params: CaptureParams, layers: StartedLayer[]): FailureError {
  return new FailureError(
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
  /** The device as Metro's runtimes name it: its udid, or its logicalDeviceId on a shared Metro. */
  jsDeviceId: string,
  bundleId: string,
  port: number
): Promise<StartedLayer> {
  const device = canonicalDeviceId(jsDeviceId) ?? jsDeviceId;
  const payload = jsCapturePayload(port, device);
  const found = findJsCapture(device, bundleId);
  // The app's capture on another port moves here only once its runtime answers here.
  const other = found && found.port !== port ? found : undefined;
  // An interceptor an earlier start installed here stays in the app's JS context
  // until a reload, whatever becomes of this start.
  const installedHere = found !== undefined && !other && found.installed;
  // That interceptor records until a stop pauses it, so its entry stays, and
  // the layer is not unavailable, whatever this start finds.
  const recording = installedHere && found.paused !== true;
  let dbg: JsRuntimeDebuggerApi;
  try {
    dbg = await resolveDebuggerService(registry, { port, device_id: jsDeviceId });
  } catch (err) {
    const reason = classifyNotConnected(err);
    const code = getFailureSignal(err)?.error_code;
    // Only the device provider changes its grant, or offers the device again.
    const lost =
      reason === "metro_not_running" ||
      reason === "device_mismatch" ||
      code === FAILURE_CODES.EXTERNAL_DEVICE_CAPABILITY_DENIED ||
      code === FAILURE_CODES.EXTERNAL_DEVICE_UNAVAILABLE;
    if (other) {
      const text = `${jsNotReached(reason, port, err)}; ${otherPortHint(bundleId, other.port)}`;
      return lost ? unavailable("js", text) : { layer: "js", armed: false, reason: text };
    }
    if (lost && recording) {
      return {
        layer: "js",
        armed: false,
        reason: `${jsNotReached(reason, port, err)}; the interceptor already in the app's JS runtime may still record, so call network-capture-start again once the app answers`,
      };
    }
    if (lost) {
      const text = jsNotReached(reason, port, err);
      // A stop's pause, and the requests it kept, stay with that interceptor.
      if (installedHere) return unavailable("js", text);
      // No mark stays for a layer that is unavailable; a read says why.
      forgetJsCapture(device, bundleId);
      setJsUnavailable(payload, bundleId, text);
      return unavailable("js", text);
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
    const notOurs = `the JS runtime on Metro port ${port} is ${appId}'s, not ${bundleId}'s`;
    if (recording) {
      return {
        layer: "js",
        armed: false,
        reason: `${notOurs}; the interceptor already in ${bundleId}'s JS runtime may still record, so call network-capture-start again once that runtime answers on this port`,
      };
    }
    if (other) return unavailable("js", `${notOurs}; ${otherPortHint(bundleId, other.port)}`);
    const text = `${notOurs}; if that runtime is the app, pass bundleId ${appId}; otherwise pass the port of ${bundleId}'s Metro`;
    // A stop's pause, and the requests it kept, stay with that interceptor.
    if (installedHere) return unavailable("js", text);
    // That app's own capture on this port stays as it is; a read says why this app has none.
    forgetJsCapture(device, bundleId);
    setJsUnavailable(payload, bundleId, text);
    return unavailable("js", text);
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
  // Capture stays off here, so a read says why, rather than to call this tool again.
  const notTurnedOn = (reason: string): StartedLayer => {
    setIosUnavailable(device.id, bundleId, reason);
    return unavailable("ios-native", reason);
  };
  let api: NativeDevtoolsApi;
  try {
    const ref = nativeDevtoolsRef(device);
    api = await registry.resolveService<NativeDevtoolsApi>(ref.urn, ref.options);
  } catch (err) {
    return notTurnedOn(errorMessage(err));
  }

  let block: NativeDevtoolsPrecheckBlock | null = null;
  if (!api.isConnected(bundleId)) {
    try {
      block = await precheckNativeDevtools(api, device.id, bundleId);
    } catch (err) {
      // Its message says what to do, as every tool that needs simctl says it.
      if (err instanceof XcodeFirstLaunchPendingError) throw err;
      return notTurnedOn(errorMessage(err));
    }
    if (block?.status === "service_stale" || block?.status === "init_failed") {
      return notTurnedOn(block.message);
    }
  }

  setIosUnavailable(device.id, bundleId);
  const armed = await api.startNetworkCapture(
    bundleId,
    port,
    // A lent agent says whether the provider has capture on only after it connects.
    block?.status === "connect_pending" || !api.armsEnv ? IOS_CONNECT_WAIT_MS : 0
  );
  if (armed) return { layer: "ios-native", armed: true };
  if (api.isConnected(bundleId)) {
    const note = api.networkRecords(bundleId)?.state().note;
    // Only the provider turns its capture on.
    if (note === PROVIDER_CAPTURE_OFF) return unavailable("ios-native", note);
    return {
      layer: "ios-native",
      armed: false,
      reason: note ?? "waiting for the agent to acknowledge Network.enable",
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
        ? "no running process of the app can be armed; capture arms at its next launch, so call restart-app to capture it now, then network-capture-start again, since a relaunch ends the JS layer's capture; if restart-app fails rather than starting the app, the bundle id is not installed on this simulator: check it, or install the app"
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
