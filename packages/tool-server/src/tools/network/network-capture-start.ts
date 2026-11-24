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
  lastAndroidRecordNumber,
  androidNetworkInspectorRef,
  type AndroidNetworkInspectorApi,
} from "../../blueprints/android-network-inspector";
import {
  findJsCapture,
  forgetJsCapture,
  jsCapture,
  installNetworkInterceptor,
  NO_XHR_YET,
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
import {
  DependencyMissingError,
  XcodeFirstLaunchPendingError,
} from "../../utils/dependency-errors";
import { xcodeFirstLaunchPending } from "../../utils/xcode-first-launch";
import { resolveDevice } from "../../utils/device-info";
import { assertSupported } from "../../utils/capability";
import { ensureDeps } from "../../utils/check-deps";
import { macosLaunchRefusal, type MacosAppApi } from "../../blueprints/macos-app";
import { lastIosRecordNumber } from "../../blueprints/ios-network-records";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { classifyNotConnected } from "../debugger/not-connected";
import {
  CAPTURE_CAPABILITY,
  captureName,
  captureSchema,
  errorMessage,
  jsNotReached,
  resolveJsRuntime,
  otherPortHint,
  requestedLayers,
  runLayers,
  withLayerInRetries,
  noteCaptureStart,
  appleAppNoJs,
  macosAppOfCall,
  setNativeUnavailable,
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
    description: `Start network capture on iOS simulators and Android<flag:macos-apps> (also on Mac apps)</flag:macos-apps> before triggering requests or waiting for one with await-network-request, including in an e2e test. Repeating the call keeps requests already captured, and await-network-request then reads only the requests after it. Capture can slow the app.
The JavaScript layer needs an app connected to Metro. Start again after its JavaScript loads, including after a reload or relaunch. While the JS capture is started, await-network-request can also install it again after a reload. Android native capture needs a debuggable build.<flag:macos-apps> For a supported React Native app launched from Xcode, use layer js and form udid as macos-app-<bundle id>. Native capture needs a supported build launched through Argent.</flag:macos-apps>
Check armed and reason for each requested layer. A pending native layer can become ready when Argent launches or reconnects to the app. On iOS simulators using a device provider's socket, start native capture again after a relaunch.
On Chromium, this marks where the active tab's capture window begins. Argent records the tab from the first tool call on the app, and bundleId can be any name.
When every requested layer is unavailable, the call fails with NETWORK_CAPTURE_UNAVAILABLE or TOOL_DEPENDENCY_MISSING.`,
    zodSchema: captureSchema,
    capability: CAPTURE_CAPABILITY,
    interaction: {
      startedMsg: ({ params }) => `Starting ${captureName(params.layer)} for ${params.bundleId}`,
      completedMsg: ({ params, result }) => {
        const started = `Started ${captureName(params.layer)} for ${params.bundleId}`;
        const waiting = result.layers.filter((entry) => !entry.armed);
        if (waiting.length === 0) return started;
        const names = waiting.map((entry) => entry.layer).join(" and ");
        if (waiting.length === 1) {
          const reason = waiting[0]!.reason;
          return `${started}, but ${names} is not armed yet${reason ? `: ${reason}` : ""}`;
        }
        const reasons = waiting
          .map((entry) => (entry.reason ? `${entry.layer}: ${entry.reason}` : entry.layer))
          .join("; ");
        return `${started}, but ${names} are not armed yet (${reasons})`;
      },
      failedMsg: ({ params, failureSignal }) =>
        `Failed to start ${captureName(params.layer)} for ${params.bundleId}: ${failureSignal.error_code}`,
    },
    // Each layer resolves its own service, so one that fails leaves the others running.
    services: () => ({}),
    async execute(_services, params) {
      const device = resolveDevice(params.udid);
      // Only the HTTP gate checks the capability, and an e2e `tool:` step does not pass it.
      assertSupported("network-capture-start", CAPTURE_CAPABILITY, device);
      const run = requestedLayers(params.layer);
      if (device.platform === "chromium") {
        // One layer, the tab's CDP log, records every request; `layer` names a part of it.
        const layer = await withCaptureLock(params.udid, params.bundleId, () =>
          startChromiumLayer(registry, device)
        );
        if (layer.unavailable) throw unavailableError(params, [layer]);
        return { status: "ok", layers: [layer] };
      }
      const port = metroPort({ device_id: params.udid, port: params.port });
      // The checks run under the lock too: a stop called while they run waits for
      // this start, so the start cannot install capture after that stop.
      const layers = await withCaptureLock(params.udid, params.bundleId, async () => {
        // Before any layer starts: a native request numbered after it came after this start.
        const nativeFloor =
          device.platform === "android" ? lastAndroidRecordNumber() : lastIosRecordNumber();
        // A Mac app's service is resolved under the lock, so a start that waited for a
        // stop-all-simulator-servers of the app arms the service that comes after it.
        // The bundle id is the device's, checked before any layer starts.
        const app =
          device.platform === "macos"
            ? await macosAppOfCall(registry, device, "network-capture-start", params.bundleId)
            : undefined;
        // The JS layer also reaches a remote simulator's Metro over the sim-remote
        // tunnel. adb and xcrun serve only the native layer, which checks them.
        if (device.platform === "ios-remote") await ensureDeps(["sim-remote"]);
        // Only the iOS native layer needs simctl to arm.
        if (run.native && device.platform === "ios" && isInjectableBundleId(params.bundleId)) {
          await refuseWhileXcodeInstalls(registry, device, params.bundleId);
        }
        // A layer the call does not name stays as it is.
        return runLayers([
          ...(run.js
            ? [
                device.platform !== "android" && !isInjectableBundleId(params.bundleId)
                  ? Promise.resolve(
                      unavailable("js", appleAppNoJs(params.bundleId, app !== undefined))
                    )
                  : startJsLayer(
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
                app
                  ? startMacosLayer(app, device, params.bundleId, port)
                  : device.platform === "android"
                    ? startAndroidLayer(registry, device, params.bundleId, port)
                    : startIosLayer(registry, device, params.bundleId, port, run.js),
              ]
            : []),
        ]).then((started) => {
          // A start that fails leaves the window of the last start that did not.
          if (!started.every((layer) => layer.unavailable)) {
            noteCaptureStart(params.udid, params.bundleId, started, nativeFloor);
          }
          return started;
        });
      });
      if (layers.every((layer) => layer.unavailable)) {
        const error = unavailableError(params, layers);
        // ensureDeps caches its probe, so this is what the native layer found.
        const missing = await missingNativeDep(device);
        if (missing && layers.some((layer) => layer.reason === missing.message)) {
          throw new DependencyMissingError(missing.missing, error.message);
        }
        throw error;
      }
      return { status: "ok", layers: withLayerInRetries(layers, params.layer) };
    },
  };
}

/**
 * The native layer of a Mac app, in the app's own service. A layer that cannot arm is
 * unavailable, not an error: the JS layer reaches the app through Metro, also a
 * copy of the app that argent did not start.
 */
async function startMacosLayer(
  app: MacosAppApi,
  device: DeviceInfo,
  bundleId: string,
  port: number
): Promise<StartedLayer> {
  // Capture is off after this start, also one that an earlier start left on for
  // the next copy argent starts, so a read and a stop say what this start found.
  const notTurnedOn = (reason: string): StartedLayer => {
    app.forgetNetworkCaptureStart();
    setNativeUnavailable(device.id, bundleId, reason);
    return unavailable("macos-native", reason);
  };
  // No launch of an Apple app loads argent's library, so nothing arms it.
  if (!isInjectableBundleId(bundleId)) {
    return notTurnedOn(
      `${bundleId} is an Apple app; argent captures only apps it can load its library into, such as your own builds`
    );
  }
  // Nor does a launch arm an app that argent refuses to start.
  const refusal = app.isConnected() ? undefined : await macosLaunchRefusal(bundleId);
  if (refusal) return notTurnedOn(refusal);
  setNativeUnavailable(device.id, bundleId);
  const { armed, reason } = await app.startNetworkCapture(port);
  return { layer: "macos-native", armed, ...(reason ? { reason } : {}) };
}

/**
 * A Chromium app's one layer: the tool-server records the tab's requests from
 * its first tool call on the app, so a start only marks where the requests
 * that await-network-request reads begin.
 */
async function startChromiumLayer(registry: Registry, device: DeviceInfo): Promise<StartedLayer> {
  const ref = chromiumCdpRef(device);
  let api: ChromiumCdpApi;
  try {
    api = await registry.resolveService<ChromiumCdpApi>(ref.urn, ref.options);
  } catch (err) {
    return unavailable("chromium", `argent cannot reach the app over CDP: ${errorMessage(err)}`);
  }
  api.server.network.startCapture();
  return { layer: "chromium", armed: true };
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
 * The host tool that the local native layer needs and does not find. The JS
 * layer needs neither adb nor xcrun, so a missing one leaves it running.
 */
async function missingNativeDep(device: DeviceInfo): Promise<DependencyMissingError | undefined> {
  // execute checks sim-remote before both layers, and a Mac app's layers need neither tool.
  if (device.platform === "ios-remote" || device.platform === "macos") return undefined;
  try {
    await ensureDeps([device.platform === "android" ? "adb" : "xcrun"]);
    return undefined;
  } catch (err) {
    if (err instanceof DependencyMissingError) return err;
    throw err;
  }
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
  /** The device's id on a Metro that several devices share. */
  logicalDeviceId: string | undefined,
  bundleId: string,
  port: number
): Promise<StartedLayer> {
  const jsDeviceId = logicalDeviceId ?? udid;
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
    dbg = await resolveJsRuntime(registry, udid, logicalDeviceId, port);
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
      // The entry stays for the reads; its mark is an earlier start's, which this one did not move.
      dropJsMark(payload);
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
    // No mark: this start did not see the context, which may hold an earlier interceptor's log.
    setJsCapture(payload, {
      bundleId,
      intent: "started",
      installed: installedHere,
      physicalDeviceId: udid,
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
      dropJsMark(payload);
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

  const capture: JsCapture = {
    bundleId,
    intent: "started",
    installed: installedHere,
    physicalDeviceId: udid,
  };
  setJsCapture(payload, capture);
  try {
    capture.mark = await readMark(dbg);
  } catch (err) {
    // A runtime that does not answer the mark does not answer the install either,
    // and each evaluate of the install waits for the full CDP timeout. This start
    // did not reach the JS context, so a pause a stop left there stays. No mark either:
    // the context may hold an earlier interceptor's log, which no request after this start is in.
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
    if (install.reason === NO_XHR_YET) {
      return {
        layer: "js",
        armed: false,
        reason:
          "the app's JavaScript has not loaded yet; call network-capture-start again once it has, before you trigger the requests to inspect",
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

/** Drops the mark of the entry under `payload`, which a start that did not read one leaves. */
function dropJsMark(payload: string): void {
  const kept = jsCapture(payload);
  if (kept) delete kept.mark;
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
  port: number,
  /** The call starts the JS layer too, whose capture a relaunch ends. */
  jsToo: boolean
): Promise<StartedLayer> {
  if (!isInjectableBundleId(bundleId)) {
    return unavailable(
      "ios-native",
      `${bundleId} is an Apple system app, which native network capture never covers`
    );
  }
  // Capture stays off here, so a read says why, rather than to call this tool again.
  const notTurnedOn = (reason: string): StartedLayer => {
    setNativeUnavailable(device.id, bundleId, reason);
    return unavailable("ios-native", reason);
  };
  const missing = await missingNativeDep(device);
  if (missing) return notTurnedOn(missing.message);
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

  setNativeUnavailable(device.id, bundleId);
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
  // A start of the native layer alone cannot tell whether JS capture runs: an
  // earlier start can have named another Metro target for it.
  const jsAfterRelaunch = jsToo
    ? ", then network-capture-start again, since a relaunch ends the JS layer's capture"
    : `; a relaunch also ends any JS capture of the app: if it ran and you still need it, call network-capture-start with layer "js" and the same port and logicalDeviceId as its start once the app's JavaScript loads (for native requests alone, restart-app is enough)`;
  return {
    layer: "ios-native",
    armed: false,
    reason:
      block?.status === "restart_required"
        ? `no running process of the app can be armed; capture arms at its next launch, so call restart-app to capture it now${jsAfterRelaunch}; if restart-app fails rather than starting the app, the bundle id is not installed on this simulator: check it, or install the app`
        : "the app has not connected yet; capture arms when it does",
  };
}

async function startAndroidLayer(
  registry: Registry,
  device: DeviceInfo,
  bundleId: string,
  port: number
): Promise<StartedLayer> {
  // No inspector keeps the reason of these two, so a read says why, rather than to call this tool again.
  const notTurnedOn = (reason: string): StartedLayer => {
    setNativeUnavailable(device.id, bundleId, reason);
    return unavailable("android-native", reason);
  };
  const missing = await missingNativeDep(device);
  if (missing) return notTurnedOn(missing.message);
  let api: AndroidNetworkInspectorApi;
  try {
    const ref = androidNetworkInspectorRef(device, bundleId, port);
    api = await registry.resolveService<AndroidNetworkInspectorApi>(ref.urn, ref.options);
  } catch (err) {
    return notTurnedOn(errorMessage(err));
  }
  // From here the inspector keeps its own reason.
  setNativeUnavailable(device.id, bundleId);
  const started = await api.startCapture(port);
  // The start's js layer tells whether the app's JavaScript requests are still recorded.
  if (started.unavailable) return unavailable("android-native", started.reason ?? "unavailable");
  return {
    layer: "android-native",
    armed: started.armed,
    ...(started.reason ? { reason: started.reason } : {}),
  };
}
