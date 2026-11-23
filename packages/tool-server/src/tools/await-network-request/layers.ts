import type { DeviceInfo, Registry } from "@argent/registry";
import { nativeDevtoolsRef, type NativeDevtoolsApi } from "../../blueprints/native-devtools";
import {
  AGENT_GONE_REASON,
  androidNetworkInspectorRef,
  LOST_WHILE_DISCONNECTED,
  STOPPED_BEFORE_FINISH,
  type AndroidNetworkInspectorApi,
} from "../../blueprints/android-network-inspector";
import { MACOS_CONNECTION_DROPPED } from "../../blueprints/ios-network-records";
import { macosAppRef, type MacosAppApi } from "../../blueprints/macos-app";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import {
  findJsCaptureOfDevice,
  installNetworkInterceptor,
  type JsCaptureMark,
} from "../../blueprints/network-inspector";
import {
  JS_RUNTIME_DEBUGGER_NAMESPACE,
  type JsRuntimeDebuggerApi,
} from "../../blueprints/js-runtime-debugger";
import type { NetworkRequestRecord } from "../../chromium-server";
import {
  NOT_RECONNECTED,
  PROCESS_ENDED,
  type NativeNetworkRecord,
} from "../../utils/native-network-record";
import { metroPort } from "../../utils/debugger/metro-port";
import { makeNetworkWaitReadScript } from "../../utils/debugger/scripts/network-interceptor";
import { classifyNotConnected } from "../debugger/not-connected";
import {
  errorMessage,
  isLiveService,
  jsNotReached,
  captureSweepUnderWay,
  lastCaptureStart,
  resolveJsRuntime,
  withCaptureLock,
} from "../network/network-capture";
import type { WaitLayer, WaitRecord } from "./match";

/** What one read of a marked layer found. */
export interface LayerRead {
  layer: WaitLayer;
  /** The read reached the layer's records. */
  readable: boolean;
  /** The layer captures the app's requests, or captured them until a stop. */
  armed: boolean;
  /** network-capture-stop stopped the layer: nothing after the stop is recorded. */
  stopped: boolean;
  /** The requests after the start's mark, oldest first. */
  records: WaitRecord[];
  /** Why the layer is not armed, or was not read, or what it may have missed. */
  note?: string;
}

/** A layer that network-capture-start marked for the device and the app. */
export interface MarkedLayer {
  layer: WaitLayer;
  /**
   * Reads the layer's requests after its mark. Never rejects. Only the JS layer
   * waits on the app, at most `budgetMs` for its answer.
   */
  read(budgetMs: number): Promise<LayerRead>;
}

const CAPTURE_ENDED =
  "its capture ended after the start (stop-all-simulator-servers, a stop of the device's services, or a tool-server restart); call network-capture-start again";
const SWEEP_UNDER_WAY =
  "stop-all-simulator-servers or the tool-server's exit is ending the app's capture";
const CAPTURE_CHANGED =
  "the app's capture changed during the read (a network-capture-start or -stop, or a teardown of the device), so the read left the app's JS runtime as it was";

/** The service behind `ref` while it runs: the wait never creates one. */
async function liveService<T>(
  registry: Registry,
  ref: { urn: string; options?: Record<string, unknown> }
): Promise<T | undefined> {
  return isLiveService(registry, ref.urn)
    ? registry.resolveService<T>(ref.urn, ref.options)
    : undefined;
}

function unreadable(layer: WaitLayer, note: string, stopped = false): LayerRead {
  return { layer, readable: false, armed: false, stopped, records: [], note };
}

/** The number in a native id `<layer>-<run tag>-<n>`, which counts up across every app of the tool-server. */
function recordNumber(id: string): number {
  return Number(id.slice(id.lastIndexOf("-") + 1));
}

/**
 * What argent writes into a native record it fails itself, as its capture
 * lost sight of the request before the request ended: the app may still have
 * got its response.
 */
const LOST_ENDINGS: ReadonlySet<string> = new Set([
  STOPPED_BEFORE_FINISH,
  LOST_WHILE_DISCONNECTED,
  AGENT_GONE_REASON,
  NOT_RECONNECTED,
  PROCESS_ENDED,
  MACOS_CONNECTION_DROPPED,
]);

function fromNative(record: NativeNetworkRecord): WaitRecord {
  const lost =
    record.state === "failed" &&
    record.errorText !== undefined &&
    LOST_ENDINGS.has(record.errorText);
  return {
    id: record.id,
    layer: record.layer,
    method: record.request.method,
    url: record.request.url,
    ...(record.response ? { status: record.response.status } : {}),
    state: lost ? "lost" : record.state,
    ...(record.timing.durationMs !== undefined
      ? { durationMs: Math.round(record.timing.durationMs) }
      : {}),
    ...(record.errorText ? { errorText: record.errorText } : {}),
  };
}

function nativeAfter(records: NativeNetworkRecord[], floor: number): WaitRecord[] {
  return records.filter((r) => recordNumber(r.id) > floor).map(fromNative);
}

/**
 * Every layer network-capture-start marked for the device and the app, the
 * native layer first. Looks the native services up only while they run: the
 * wait never creates one, and a service that stopped took its mark with it.
 */
export async function markedLayers(
  registry: Registry,
  device: DeviceInfo,
  bundleId: string
): Promise<MarkedLayer[]> {
  const layers: MarkedLayer[] = [];
  const start = lastCaptureStart(device.id, bundleId);
  // Only the requests after the last start count. A native layer it left as it was is read
  // after the start's native floor, and dropped when stopped, as it then holds none. The JS
  // layer has no such floor, so it is read only when the last start named it.
  const startWindow: Window = {
    current: (layer, stopped) => !start || start.layers.has(layer) || (layer !== "js" && !stopped),
    floor: (mark) => Math.max(mark.lastRecord, start?.nativeFloor ?? 0),
  };
  const native =
    device.platform === "chromium"
      ? await chromiumLayer(registry, device)
      : device.platform === "android"
        ? await androidLayer(registry, device, bundleId, startWindow)
        : device.platform === "macos"
          ? await macosLayer(registry, device, startWindow)
          : await iosLayer(registry, device, bundleId, startWindow);
  if (native) layers.push(native);
  // Chromium's one layer records the page's JavaScript requests too.
  if (device.platform !== "chromium") {
    const js = jsLayer(registry, device, bundleId, startWindow);
    if (js) layers.push(js);
  }
  return layers;
}

/** The window of the last start: which marked layers it covers, and where a native one begins. */
interface Window {
  current(layer: WaitLayer, stopped: boolean): boolean;
  /** The record number after which a native layer's requests count. */
  floor(mark: { lastRecord: number }): number;
}

async function iosLayer(
  registry: Registry,
  device: DeviceInfo,
  bundleId: string,
  startWindow: Window
): Promise<MarkedLayer | undefined> {
  const ref = nativeDevtoolsRef(device);
  const resolve = () => liveService<NativeDevtoolsApi>(registry, ref);
  const found = await resolve();
  if (!found?.networkCaptureMark(bundleId)) return undefined;
  if (!startWindow.current("ios-native", found.isNetworkCaptureStopped(bundleId))) return undefined;
  return {
    layer: "ios-native",
    async read() {
      const api = await resolve();
      // A later start moves the mark; a new service has none.
      const mark = api?.networkCaptureMark(bundleId);
      if (!api || !mark) return unreadable("ios-native", CAPTURE_ENDED);
      const stopped = api.isNetworkCaptureStopped(bundleId);
      const store = api.networkRecords(bundleId);
      const state = store?.state();
      const armed = stopped || state?.armed === true;
      return {
        layer: "ios-native",
        readable: true,
        armed,
        stopped,
        records: nativeAfter(
          store?.records(mark.metroPort, { includeHidden: true }) ?? [],
          startWindow.floor(mark)
        ),
        ...(armed
          ? {}
          : { note: state?.note ?? "the app has not connected yet; capture arms when it does" }),
      };
    },
  };
}

async function androidLayer(
  registry: Registry,
  device: DeviceInfo,
  bundleId: string,
  startWindow: Window
): Promise<MarkedLayer | undefined> {
  // The URN has no port, and the options only reach a service that does not run yet.
  const ref = androidNetworkInspectorRef(device, bundleId, metroPort({ device_id: device.id }));
  const resolve = () => liveService<AndroidNetworkInspectorApi>(registry, ref);
  const found = await resolve();
  if (!found?.captureMark()) return undefined;
  if (!startWindow.current("android-native", found.isStopped())) return undefined;
  return {
    layer: "android-native",
    async read() {
      const api = await resolve();
      const mark = api?.captureMark();
      if (!api || !mark) return unreadable("android-native", CAPTURE_ENDED);
      const stopped = api.isStopped();
      const state = api.state();
      // An agent that acknowledged Network.enable hooks no client while its capture is unavailable.
      const armed = stopped || (state.armed && state.capture?.state !== "unavailable");
      return {
        layer: "android-native",
        readable: true,
        armed,
        stopped,
        records: nativeAfter(
          api.records(mark.metroPort, { includeHidden: true }),
          startWindow.floor(mark)
        ),
        ...(armed
          ? {}
          : {
              note:
                state.note ??
                state.capture?.detail ??
                api.unavailableReason() ??
                "the app's agent has not armed yet",
            }),
      };
    },
  };
}

async function macosLayer(
  registry: Registry,
  device: DeviceInfo,
  startWindow: Window
): Promise<MarkedLayer | undefined> {
  const ref = macosAppRef(device);
  const resolve = () => liveService<MacosAppApi>(registry, ref);
  const found = await resolve();
  if (!found?.networkCaptureMark()) return undefined;
  if (!startWindow.current("macos-native", found.isNetworkCaptureStopped())) return undefined;
  return {
    layer: "macos-native",
    async read() {
      const app = await resolve();
      const mark = app?.networkCaptureMark();
      if (!app || !mark) return unreadable("macos-native", CAPTURE_ENDED);
      const stopped = app.isNetworkCaptureStopped();
      const store = app.networkRecords();
      const state = store.state();
      const armed = stopped || state.armed;
      return {
        layer: "macos-native",
        readable: true,
        armed,
        stopped,
        records: nativeAfter(
          store.records(mark.metroPort, { includeHidden: true }),
          startWindow.floor(mark)
        ),
        ...(armed ? {} : { note: state.note ?? "the app has not connected to argent yet" }),
      };
    },
  };
}

function fromChromium(record: NetworkRequestRecord): WaitRecord {
  return {
    id: record.requestId,
    layer: "chromium",
    method: record.method,
    url: record.url,
    ...(record.status !== undefined ? { status: record.status } : {}),
    state: record.failed
      ? "failed"
      : record.finished
        ? "complete"
        : record.status !== undefined
          ? "headers"
          : "pending",
    ...(record.durationMs !== undefined ? { durationMs: Math.round(record.durationMs) } : {}),
    ...(record.errorText ? { errorText: record.errorText } : {}),
  };
}

async function chromiumLayer(
  registry: Registry,
  device: DeviceInfo
): Promise<MarkedLayer | undefined> {
  const ref = chromiumCdpRef(device);
  const resolve = () => liveService<ChromiumCdpApi>(registry, ref);
  if (!(await resolve())?.server.network.captureMark()) return undefined;
  return {
    layer: "chromium",
    async read() {
      const network = (await resolve())?.server.network;
      const mark = network?.captureMark();
      if (!network || !mark) return unreadable("chromium", CAPTURE_ENDED);
      const stopped = mark.stoppedSeq !== undefined;
      return {
        layer: "chromium",
        readable: true,
        armed: true,
        stopped,
        records: network
          .requestsAfter(mark.lastSeq)
          .filter(({ seq }) => mark.stoppedSeq === undefined || seq <= mark.stoppedSeq)
          .map(({ record }) => fromChromium(record)),
      };
    },
  };
}

interface WaitReadAnswer {
  installed: boolean;
  xhr?: boolean;
  token?: string | null;
  paused?: boolean;
  entries?: Array<{
    requestId?: string;
    state?: string;
    method?: string;
    url?: string;
    status?: number;
    durationMs?: number;
    errorText?: string;
  }>;
}

function fromJs(entry: NonNullable<WaitReadAnswer["entries"]>[number]): WaitRecord {
  const state =
    entry.state === "finished"
      ? "complete"
      : entry.state === "failed"
        ? "failed"
        : entry.status !== undefined
          ? "headers"
          : "pending";
  return {
    id: entry.requestId ?? "",
    layer: "js",
    method: entry.method ?? "",
    url: entry.url ?? "",
    ...(typeof entry.status === "number" ? { status: entry.status } : {}),
    state,
    ...(typeof entry.durationMs === "number" ? { durationMs: Math.round(entry.durationMs) } : {}),
    ...(entry.errorText ? { errorText: entry.errorText } : {}),
  };
}

/**
 * The JS layer, read through the app's debugger. While the capture is started,
 * a read reconnects to the app's runtime, and installs the interceptor in a
 * context that lost it (a reload) or never had it (a start before the app's
 * JavaScript loaded), as the start asked. A stopped capture is only read where
 * its runtime is still connected, and gets no install.
 */
function jsLayer(
  registry: Registry,
  device: DeviceInfo,
  bundleId: string,
  startWindow: Window
): MarkedLayer | undefined {
  const found = findJsCaptureOfDevice(device.id, bundleId);
  if (!found?.capture.mark) return undefined;
  if (!startWindow.current("js", found.capture.intent === "stopped")) return undefined;
  return {
    layer: "js",
    async read(budgetMs) {
      // A later start replaces the entry, and a teardown forgets it.
      const found = findJsCaptureOfDevice(device.id, bundleId);
      const mark: JsCaptureMark | undefined = found?.capture.mark;
      if (!found || !mark) return unreadable("js", CAPTURE_ENDED);
      const { payload, port, capture } = found;
      let stopped = capture.intent === "stopped";
      const physical = capture.physicalDeviceId ?? device.id;
      // The teardown pauses the interceptor and drops the debugger; a read would undo both.
      if (captureSweepUnderWay(physical)) return unreadable("js", SWEEP_UNDER_WAY, stopped);
      const urn = `${JS_RUNTIME_DEBUGGER_NAMESPACE}:${payload}`;
      const live = isLiveService(registry, urn);
      if (stopped && !live) {
        return unreadable(
          "js",
          "the app's JS runtime is not connected, and a stopped capture does not reconnect to it",
          true
        );
      }
      /**
       * Runs `change` (a reconnect, an install or a resume) under the lock that
       * network-capture-start and -stop take, and only while the capture is
       * still the started one this read found. A teardown that began first
       * ends first, and one that begins meanwhile waits for `change`, then
       * pauses and disposes what it left.
       */
      const whileStarted = <T>(change: () => Promise<T>) =>
        withCaptureLock(physical, bundleId, async (): Promise<{ value: T } | { note: string }> => {
          if (captureSweepUnderWay(physical)) return { note: SWEEP_UNDER_WAY };
          const now = findJsCaptureOfDevice(device.id, bundleId);
          if (!now?.capture.mark) return { note: CAPTURE_ENDED };
          if (now.capture !== capture || capture.intent !== "started") {
            return { note: CAPTURE_CHANGED };
          }
          return { value: await change() };
        });
      const target = payload.slice(payload.indexOf(":") + 1);
      try {
        // A live debugger is used as it is: resolving it creates nothing.
        const opened = live
          ? { value: await registry.resolveService<JsRuntimeDebuggerApi>(urn) }
          : await whileStarted(() =>
              resolveJsRuntime(registry, physical, target !== physical ? target : undefined, port)
            );
        if ("note" in opened) return unreadable("js", opened.note);
        const dbg = opened.value;
        const appId = dbg.runtimeApp?.appId;
        if (appId !== undefined && appId !== bundleId) {
          return unreadable(
            "js",
            `the JS runtime on Metro port ${port} is ${appId}'s, not ${bundleId}'s`,
            stopped
          );
        }
        const answer = JSON.parse(
          String(
            await dbg.cdp.evaluate(makeNetworkWaitReadScript(mark, port), {
              timeout: Math.max(1, budgetMs),
            })
          )
        ) as WaitReadAnswer;
        // A stop whose pause did not reach the runtime: it records still, also after the stop.
        const pauseMissed = stopped && answer.installed && answer.paused === false;
        if (pauseMissed) stopped = false;
        const resume = !stopped && !pauseMissed && (!answer.installed || answer.paused === true);
        if (resume && answer.xhr !== true) {
          return unreadable("js", "the app's JavaScript has not loaded yet", stopped);
        }
        if (!answer.installed) {
          if (stopped) {
            // Nothing records after the stop, and the reload cleared what was recorded.
            return {
              layer: "js",
              readable: true,
              armed: true,
              stopped,
              records: [],
              note: "the app's JS runtime reloaded since the stop, which cleared its requests",
            };
          }
          const installed = await whileStarted(() =>
            installNetworkInterceptor(dbg.cdp, payload, dbg.runtimeApp)
          );
          if ("note" in installed) return unreadable("js", installed.note);
          const install = installed.value;
          return unreadable(
            "js",
            install.installed
              ? "the app's JS runtime had no interceptor (it reloaded, or its JavaScript had not loaded at the start), so the wait installed it: requests from now on are recorded, earlier ones in that runtime are missing"
              : `the interceptor did not install: ${install.reason}`
          );
        }
        let note: string | undefined;
        if (resume) {
          // A stop's pause that the start did not reach: the start asked to record.
          const resumed = await whileStarted(() =>
            installNetworkInterceptor(dbg.cdp, payload, dbg.runtimeApp)
          );
          if ("note" in resumed) return unreadable("js", resumed.note);
          const install = resumed.value;
          note = install.installed
            ? "a stop's pause was still in the app's JS runtime, so the wait resumed the capture: requests sent while it was paused are missing"
            : `a stop's pause is still in the app's JS runtime, and the wait could not resume it: ${install.reason}`;
          if (!install.installed) {
            return {
              layer: "js",
              readable: true,
              armed: false,
              stopped,
              records: (answer.entries ?? []).map(fromJs),
              note,
            };
          }
        } else if (mark.install !== null && answer.token !== mark.install) {
          note =
            "the app's JS runtime reloaded after the start, so its requests between the reload and the interceptor's reinstall are missing";
        } else if (pauseMissed) {
          note =
            "the stop's pause did not reach the app's JS runtime, which still records: requests after the stop count";
        }
        return {
          layer: "js",
          readable: true,
          armed: true,
          stopped,
          records: (answer.entries ?? []).map(fromJs),
          ...(note ? { note } : {}),
        };
      } catch (err) {
        const reason = classifyNotConnected(err);
        return unreadable(
          "js",
          reason !== undefined
            ? jsNotReached(reason, port, err)
            : `the app's JS runtime did not answer: ${errorMessage(err)}`,
          stopped
        );
      }
    },
  };
}
