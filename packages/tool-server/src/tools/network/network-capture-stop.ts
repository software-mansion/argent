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
import { readAppProcesses } from "../../blueprints/android-network-inspector-device";
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
import { assertSupported } from "../../utils/capability";
import { localIosHost, remoteIosHost } from "../../utils/ios-host";
import { SIMCTL_SPAWN_TIMEOUT_MS } from "../../utils/simctl-config";
import { classifyNotConnected } from "../debugger/not-connected";
import {
  CAPTURE_CAPABILITY,
  captureName,
  captureSchema,
  errorMessage,
  isLiveService,
  jsNotReached,
  resolveJsRuntime,
  otherPortHint,
  requestedLayers,
  runLayers,
  withLayerInRetries,
  withCaptureLock,
  type CaptureParams,
  type CaptureResult,
  type StoppedLayer,
} from "./network-capture";

const NOT_STARTED = "capture was not started for this app";
/** How long a stop waits for the app's JS runtime to answer the pause, as a start waits for the mark. */
const JS_ANSWER_WAIT_MS = 5_000;

export function createNetworkCaptureStopTool(
  registry: Registry
): ToolDefinition<CaptureParams, CaptureResult<StoppedLayer>> {
  return {
    id: "network-capture-stop",
    description: `Stop network capture for an app on every layer and keep what was captured. Pass layer js or native to stop only that layer; the other layer keeps capturing.
Use when you have the requests you need, before you profile, or to end capture in an e2e test. Unlike stop-all-simulator-servers, the requests stay listed in native-network-logs and view-network-logs, and their ids keep working in view-network-request-details (a view-network-logs id until the app's JS runtime reloads).
Capture stays off: the read tools, launch-app and restart-app do not turn it on again; network-capture-start does. A request in flight at the stop completes in the list on iOS and in the JS runtime; on Android the list marks it failed, while the app's own request goes on. On Android, a body that view-network-request-details did not read before the stop is no longer available.
Returns { status, layers }: per layer the call stopped, armed (false once the layer confirmed the stop), total (the requests it keeps for the app, or 0 when the stop could not count them, as on a JS runtime it did not reach) and a reason when the layer was not reached or was not started.`,
    zodSchema: captureSchema,
    capability: CAPTURE_CAPABILITY,
    interaction: {
      startedMsg: ({ params }) => `Stopping ${captureName(params.layer)} for ${params.bundleId}`,
      completedMsg: ({ params }) => `Stopped ${captureName(params.layer)} for ${params.bundleId}`,
      failedMsg: ({ params, failureSignal }) =>
        `Failed to stop ${captureName(params.layer)} for ${params.bundleId}: ${failureSignal.error_code}`,
    },
    // A stop must not create the services it stops, so each layer looks them up itself.
    services: () => ({}),
    async execute(_services, params) {
      const device = resolveDevice(params.udid);
      // Only the HTTP gate checks the capability, and an e2e `tool:` step does not pass it.
      assertSupported("network-capture-stop", CAPTURE_CAPABILITY, device);
      const port = metroPort({ device_id: params.udid, port: params.port });
      const run = requestedLayers(params.layer);
      // A layer the call does not name stays as it is.
      const layers = await withCaptureLock(params.udid, params.bundleId, () =>
        runLayers([
          ...(run.js
            ? [
                device.platform !== "android" && !isInjectableBundleId(params.bundleId)
                  ? Promise.resolve<StoppedLayer>({
                      layer: "js",
                      armed: false,
                      total: 0,
                      reason: `${params.bundleId} is an Apple system app, which runs no React Native JS`,
                    })
                  : stopJsLayer(
                      registry,
                      params.udid,
                      params.logicalDeviceId,
                      params.bundleId,
                      port
                    ),
              ]
            : []),
          ...(run.native
            ? [
                device.platform === "android"
                  ? stopAndroidLayer(registry, device, params.bundleId, port)
                  : stopIosLayer(registry, device, params.bundleId, port),
              ]
            : []),
        ])
      );
      return { status: "ok", layers: withLayerInRetries(layers, params.layer) };
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
  /** The device's id on a Metro that several devices share. */
  logicalDeviceId: string | undefined,
  bundleId: string,
  port: number
): Promise<StoppedLayer> {
  const jsDeviceId = logicalDeviceId ?? udid;
  const device = canonicalDeviceId(jsDeviceId) ?? jsDeviceId;
  const payload = jsCapturePayload(port, device);
  const prior = findJsCapture(device, bundleId);
  const kept = prior?.port === port ? prior : undefined;
  // A capture on another port moves here only once the app's runtime answers here.
  const other = prior && !kept ? prior : undefined;
  // It may still record when it is started, or when a stop there did not reach its interceptor.
  const otherArmed =
    other !== undefined &&
    (other.intent === "started" || (other.installed && other.paused !== true));
  // The port's capture of another app stays as it is: a runtime that names no
  // app can be that app's, so a stop here could pause or replace it.
  const here = jsCapture(payload);
  if (here && here.bundleId !== bundleId) {
    const stays = `the capture of ${here.bundleId} on Metro port ${port} stays as it is`;
    if (other) {
      return {
        layer: "js",
        armed: otherArmed,
        total: 0,
        reason: `${stays}; ${otherPortHint(bundleId, other.port)}`,
      };
    }
    return { layer: "js", armed: false, total: 0, reason: `${NOT_STARTED}; ${stays}` };
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
  // Metro answers the same for an app that exited as for an app that lost its
  // Metro connection. Only the device tells that the interceptor ended with
  // the app's process.
  const endedWithApp = async (stored: JsCapture): Promise<string | undefined> => {
    if ((await appRuns(udid, bundleId)) !== false) return undefined;
    stored.installed = false;
    return `${bundleId} is not running, so nothing records; while capture is stopped, its next JS runtime gets no interceptor`;
  };

  let dbg: JsRuntimeDebuggerApi;
  try {
    dbg = await resolveJsRuntime(registry, udid, logicalDeviceId, port);
  } catch (err) {
    const notReached = jsNotReached(classifyNotConnected(err), port, err);
    if (other) {
      return {
        layer: "js",
        armed: otherArmed,
        total: 0,
        reason: `${notReached}; ${otherPortHint(bundleId, other.port)}`,
      };
    }
    // The app has no capture to stop on any port.
    if (!prior) {
      return { layer: "js", armed: false, total: 0, reason: `${notReached}; ${NOT_STARTED}` };
    }
    const stored = storeStopped(kept?.paused === true);
    // An interceptor a start installed there records until a stop pauses it.
    const unconfirmed = kept?.installed === true && kept.paused !== true;
    const ended = unconfirmed ? await endedWithApp(stored) : undefined;
    if (ended) return { layer: "js", armed: false, total: 0, reason: `${notReached}; ${ended}` };
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
        armed: otherArmed,
        total: 0,
        reason: `${notOurs}, so nothing changed there; ${otherPortHint(bundleId, other.port)}`,
      };
    }
    if (!kept) {
      return {
        layer: "js",
        armed: false,
        total: 0,
        reason: `${notOurs}, so nothing changed there; if that runtime is the app, pass bundleId ${appId}; otherwise pass the port of ${bundleId}'s Metro`,
      };
    }
    const stored = storeStopped(kept.paused === true);
    const unconfirmed = kept.installed && kept.paused !== true;
    const ended = unconfirmed ? await endedWithApp(stored) : undefined;
    if (ended) return { layer: "js", armed: false, total: 0, reason: `${notOurs}; ${ended}` };
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
    await dbg.cdp.evaluate(makeNetworkCaptureControlScript(true), { timeout: JS_ANSWER_WAIT_MS });
  } catch (err) {
    return {
      layer: "js",
      armed: true,
      total: 0,
      reason: `the app's JS runtime did not pause capture: ${errorMessage(err)}`,
    };
  }
  stored.paused = true;
  try {
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
    // The pause took; only the count is missing.
    const uncounted = `the app's JS runtime paused capture, but did not answer the count of its requests: ${errorMessage(err)}`;
    return {
      layer: "js",
      armed: false,
      total: 0,
      reason: prior ? uncounted : `${uncounted}; ${NOT_STARTED}`,
    };
  }
}

/** Whether the app has a process on the device, or undefined when the device does not answer. */
async function appRuns(udid: string, bundleId: string): Promise<boolean | undefined> {
  const { platform } = resolveDevice(udid);
  try {
    if (platform === "android") {
      return (await readAppProcesses(udid, bundleId)).processes.length > 0;
    }
    if (platform === "ios") return (await localIosHost.listRunningBundleIds(udid)).has(bundleId);
    if (platform === "ios-remote") {
      // The remote host waits up to 60 s; the stop waits as long as for a local simulator.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), SIMCTL_SPAWN_TIMEOUT_MS);
      });
      try {
        return (await Promise.race([remoteIosHost.listRunningBundleIds(udid), late]))?.has(
          bundleId
        );
      } finally {
        clearTimeout(timer);
      }
    }
  } catch {
    // A device that does not answer tells nothing about the app.
  }
  return undefined;
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
