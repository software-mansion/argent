import type { DeviceInfo, Registry, ToolDefinition } from "@argent/registry";
import {
  isInjectableBundleId,
  nativeDevtoolsRef,
  type NativeDevtoolsApi,
} from "../../blueprints/native-devtools";
import {
  androidNetworkInspectorRef,
  type AndroidNetworkInspectorApi,
} from "../../blueprints/android-network-inspector";
import {
  findJsCapture,
  jsCapture,
  jsCapturePayload,
  setJsCapture,
  type JsCapture,
} from "../../blueprints/network-inspector";
import type { JsRuntimeDebuggerApi } from "../../blueprints/js-runtime-debugger";
import {
  makeNetworkCaptureControlScript,
  makeNetworkLogReadScript,
} from "../../utils/debugger/scripts/network-interceptor";
import { canonicalDeviceId } from "../../utils/debugger/device-alias";
import { metroPort } from "../../utils/debugger/metro-port";
import { resolveDevice } from "../../utils/device-info";
import { classifyNotConnected, resolveDebuggerService } from "../debugger/not-connected";
import {
  CAPTURE_CAPABILITY,
  captureSchema,
  errorMessage,
  isLiveService,
  jsNotReached,
  otherPortHint,
  runLayers,
  withCaptureLock,
  type CaptureParams,
  type CaptureResult,
  type StoppedLayer,
} from "./network-capture";

const NOT_STARTED = "capture was not started for this app";

export function createNetworkCaptureStopTool(
  registry: Registry
): ToolDefinition<CaptureParams, CaptureResult<StoppedLayer>> {
  return {
    id: "network-capture-stop",
    description: `Stop network capture for an app on every layer and keep what was captured.
Use when you have the requests you need, before you profile, or to end capture in an e2e test. Unlike stop-all-simulator-servers, the requests stay listed in native-network-logs and view-network-logs, and their ids keep working in view-network-request-details.
Capture stays off: the read tools, launch-app and restart-app do not turn it on again; network-capture-start does. A request in flight at the stop completes in the list on iOS and in the JS runtime; on Android the list marks it failed, while the app's own request goes on. On Android, a body that view-network-request-details did not read before the stop is no longer available.
Returns { status, layers }: per layer, armed (false once the layer confirmed the stop), total (the requests it keeps for the app) and a reason when the layer was not reached or was not started.`,
    zodSchema: captureSchema,
    capability: CAPTURE_CAPABILITY,
    interaction: {
      startedMsg: ({ params }) => `Stopping network capture for ${params.bundleId}`,
      completedMsg: ({ params }) => `Stopped network capture for ${params.bundleId}`,
      failedMsg: ({ params, failureSignal }) =>
        `Failed to stop network capture for ${params.bundleId}: ${failureSignal.error_code}`,
    },
    // A stop must not create the services it stops, so each layer looks them up itself.
    services: () => ({}),
    async execute(_services, params) {
      const device = resolveDevice(params.udid);
      const port = metroPort({ device_id: params.udid, port: params.port });
      const layers = await withCaptureLock(params.udid, params.bundleId, () =>
        runLayers([
          device.platform !== "android" && !isInjectableBundleId(params.bundleId)
            ? Promise.resolve<StoppedLayer>({
                layer: "js",
                armed: false,
                total: 0,
                reason: `${params.bundleId} is an Apple system app, which runs no React Native JS`,
              })
            : stopJsLayer(registry, params.udid, params.bundleId, port),
          device.platform === "android"
            ? stopAndroidLayer(registry, device, params.bundleId, port)
            : stopIosLayer(registry, device, params.bundleId, port),
        ])
      );
      return { status: "ok", layers };
    },
  };
}

/**
 * Stores the stopped intent, so no later install records, then pauses the
 * interceptor where it runs. A runtime of another app is left as it is.
 */
async function stopJsLayer(
  registry: Registry,
  udid: string,
  bundleId: string,
  port: number
): Promise<StoppedLayer> {
  const device = canonicalDeviceId(udid) ?? udid;
  const payload = jsCapturePayload(port, device);
  const prior = findJsCapture(device, bundleId);
  const kept = prior?.port === port ? prior : undefined;
  // A capture on another port moves here only once the app's runtime answers here.
  const other = prior && !kept ? prior : undefined;
  // An app never started here leaves the capture of the port's app as it is.
  const here = jsCapture(payload);
  if (!prior && here && here.bundleId !== bundleId) {
    return {
      layer: "js",
      armed: false,
      total: 0,
      reason: `${NOT_STARTED}; the capture of ${here.bundleId} on Metro port ${port} stays as it is`,
    };
  }
  const storeStopped = (paused: boolean): JsCapture => {
    const capture: JsCapture = {
      bundleId,
      intent: "stopped",
      ...(kept?.mark ? { mark: kept.mark } : {}),
      installed: kept?.installed ?? false,
      ...(paused ? { paused: true as const } : {}),
    };
    setJsCapture(payload, capture);
    return capture;
  };

  let dbg: JsRuntimeDebuggerApi;
  try {
    dbg = await resolveDebuggerService(registry, { port, device_id: udid });
  } catch (err) {
    const notReached = jsNotReached(classifyNotConnected(err), port, err);
    if (other) {
      return {
        layer: "js",
        armed: other.intent === "started",
        total: 0,
        reason: `${notReached}; ${otherPortHint(bundleId, other.port)}`,
      };
    }
    // The app has no capture to stop on any port.
    if (!prior) {
      return { layer: "js", armed: false, total: 0, reason: `${notReached}; ${NOT_STARTED}` };
    }
    storeStopped(kept?.paused === true);
    // An interceptor a start installed there records until a stop pauses it.
    const unconfirmed = kept?.installed === true && kept.paused !== true;
    return {
      layer: "js",
      armed: unconfirmed,
      total: 0,
      reason: unconfirmed
        ? `${notReached}; the interceptor already in the app's JS runtime may still record, so call network-capture-stop again once the app answers`
        : `${notReached}; while capture is stopped, the app's JS runtime gets no interceptor`,
    };
  }
  const appId = dbg.runtimeApp?.appId;
  if (appId !== undefined && appId !== bundleId) {
    const notOurs = `the JS runtime on Metro port ${port} is ${appId}'s, not ${bundleId}'s`;
    // As when the runtime is not reached: the app's own capture is not stopped.
    if (other) {
      return {
        layer: "js",
        armed: other.intent === "started",
        total: 0,
        reason: `${notOurs}, so nothing changed there; ${otherPortHint(bundleId, other.port)}`,
      };
    }
    if (!kept) {
      return {
        layer: "js",
        armed: false,
        total: 0,
        reason: `${notOurs}, so nothing changed there; pass the port of ${bundleId}'s Metro`,
      };
    }
    storeStopped(kept.paused === true);
    const unconfirmed = kept.installed && kept.paused !== true;
    return {
      layer: "js",
      armed: unconfirmed,
      total: 0,
      reason: unconfirmed
        ? `${notOurs}; the interceptor already in ${bundleId}'s JS runtime may still record, so call network-capture-stop again once that runtime answers on this port`
        : `${notOurs}; while capture is stopped, ${bundleId}'s JS runtime gets no interceptor`,
    };
  }
  const stored = storeStopped(false);
  try {
    await dbg.cdp.evaluate(makeNetworkCaptureControlScript(true));
    stored.paused = true;
    const { total, interceptorInstalled } = JSON.parse(
      String(await dbg.cdp.evaluate(makeNetworkLogReadScript(0, 0, port)))
    ) as { total: number; interceptorInstalled: boolean };
    return {
      layer: "js",
      armed: false,
      total: interceptorInstalled ? total : 0,
      ...(prior ? {} : { reason: NOT_STARTED }),
    };
  } catch (err) {
    return {
      layer: "js",
      armed: true,
      total: 0,
      reason: `the app's JS runtime did not pause capture: ${errorMessage(err)}`,
    };
  }
}

async function stopIosLayer(
  registry: Registry,
  device: DeviceInfo,
  bundleId: string,
  port: number
): Promise<StoppedLayer> {
  if (!isInjectableBundleId(bundleId)) {
    return {
      layer: "ios-native",
      armed: false,
      total: 0,
      reason: `${bundleId} is an Apple system app, which native network capture never covers`,
    };
  }
  const ref = nativeDevtoolsRef(device);
  if (!isLiveService(registry, ref.urn)) {
    return { layer: "ios-native", armed: false, total: 0, reason: NOT_STARTED };
  }
  const api = await registry.resolveService<NativeDevtoolsApi>(ref.urn, ref.options);
  // The service runs for other tools too; an app never started there is left as it is.
  if (!api.isNetworkCaptureStarted(bundleId) && !api.isNetworkCaptureStopped(bundleId)) {
    return { layer: "ios-native", armed: false, total: 0, reason: NOT_STARTED };
  }
  const { confirmed, reason } = await api.stopNetworkCapture(bundleId);
  return {
    layer: "ios-native",
    armed: !confirmed,
    total: api.networkRecords(bundleId)?.records(port).length ?? 0,
    ...(reason ? { reason } : {}),
  };
}

async function stopAndroidLayer(
  registry: Registry,
  device: DeviceInfo,
  bundleId: string,
  port: number
): Promise<StoppedLayer> {
  const ref = androidNetworkInspectorRef(device, bundleId, port);
  if (!isLiveService(registry, ref.urn)) {
    return { layer: "android-native", armed: false, total: 0, reason: NOT_STARTED };
  }
  const api = await registry.resolveService<AndroidNetworkInspectorApi>(ref.urn, ref.options);
  // A start that found the app unavailable leaves nothing to stop.
  if (!api.isStarted() && !api.isStopped()) {
    return { layer: "android-native", armed: false, total: 0, reason: NOT_STARTED };
  }
  const { confirmed, reason } = await api.stopCapture();
  return {
    layer: "android-native",
    armed: !confirmed,
    total: api.records(port).length,
    ...(reason ? { reason } : {}),
  };
}
