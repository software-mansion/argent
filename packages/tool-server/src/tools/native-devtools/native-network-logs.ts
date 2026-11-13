import { z } from "zod";
import {
  FAILURE_CODES,
  FailureError,
  type Registry,
  type ServiceRef,
  type ToolDefinition,
} from "@argent/registry";
import {
  isInjectableBundleId,
  nativeDevtoolsRef,
  nonInjectableError,
  precheckNativeDevtools,
  type NativeDevtoolsApi,
  type NativeDevtoolsPrecheckBlock,
} from "../../blueprints/native-devtools";
import {
  androidNetworkInspectorRef,
  type AndroidCaptureState,
  type AndroidNetworkInspectorApi,
  type AndroidNetworkInspectorState,
} from "../../blueprints/android-network-inspector";
import type { NativeNetworkRecord, NativeRecordState } from "../../utils/native-network-record";
import { resolveDevice } from "../../utils/device-info";
import { ensureDeps } from "../../utils/check-deps";
import { metroPort, metroPortField } from "../../utils/debugger/metro-port";
import { isLiveService } from "../network/network-capture";
import type { NetworkEvent } from "../../blueprints/macos-app";
import { macosAppServices } from "../../utils/macos-input";
import { requireMacosAppOfBundle } from "./macos-view-hierarchy";

const zodSchema = z.object({
  udid: z
    .string()
    .describe(
      "Device ID from list-devices: an iOS simulator UDID or Android serial<flag:macos-apps>, or a Mac app id (macos-app-<bundle id>)</flag:macos-apps>"
    ),
  bundleId: z
    .string()
    .describe(
      "App bundle ID on iOS or package name on Android<flag:macos-apps> (on a Mac app, the bundle id in the device id)</flag:macos-apps>"
    ),
  port: metroPortField.describe(
    "The app's Metro port, whose requests are left out of the listing. Omit it to use this device's port, 8081 by default.<flag:macos-apps> A Mac app ignores it.</flag:macos-apps>"
  ),
  limit: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .default(50)
    .describe(
      "Maximum number of requests to return: the most recent ones, oldest first. 0 returns only the header and the total.<flag:macos-apps> On a Mac app, 0 returns no events.</flag:macos-apps>"
    ),
  clear: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Clear the log after reading. On iOS and Android, the IDs of cleared requests still work in view-network-request-details"
    ),
});

type Params = z.infer<typeof zodSchema>;

interface NativeRequestLine {
  id: string;
  method: string;
  url: string;
  state: NativeRecordState;
  status?: number;
  mimeType?: string;
  durationMs?: number;
  errorText?: string;
  rnRequestId?: number;
}

interface NativeListing {
  status: "ok";
  header: string;
  armed: boolean;
  /** Only on the answer before any network-capture-start for the app, or after one that found the layer unavailable. */
  started?: false;
  /** Only while network-capture-stop has capture stopped for the app. */
  stopped?: true;
  /** Android: the capture state the in-app agent reports, or unavailable after a start that found the layer unavailable. */
  capture?: AndroidCaptureState;
  /** Android: the detail the in-app agent sent with the capture state, for example why only some requests are captured, or why the start found the layer unavailable. */
  captureDetail?: string;
  count: number;
  total: number;
  requests: NativeRequestLine[];
}

type Result =
  | NativeDevtoolsPrecheckBlock
  | NativeListing
  | { status: "ok"; count: number; events: NetworkEvent[] };

/** Only reads which services are live: a read never creates one. */
type InspectorRegistry = Pick<Registry, "getSnapshot">;

export function createNativeNetworkLogsTool(
  registry: InspectorRegistry
): ToolDefinition<Params, Result> {
  return {
    id: "native-network-logs",
    interaction: {
      startedMsg: ({ params }) => `Reading native network activity for ${params.bundleId}`,
      completedMsg: ({ params }) => `Read native network activity for ${params.bundleId}`,
      failedMsg: ({ params, failureSignal }) =>
        `Failed to read native network activity for ${params.bundleId}: ${failureSignal.error_code}`,
    },
    capability: {
      apple: { simulator: true },
      appleRemote: { simulator: true },
      android: { emulator: true, device: true },
      macos: { app: true },
    },
    description: `Retrieve network requests captured at the native level: NSURLProtocol on iOS, OkHttp on Android.
Use when inspecting native-level HTTP traffic that view-network-logs cannot see: requests that never pass through JS XMLHttpRequest or fetch.
On iOS it sees URLSession requests (default and ephemeral session configurations, and URLSession.shared) from native modules and Swift/Objective-C code. It does not see background URLSession transfers, WKWebView, Network.framework, or HTTP stacks that bypass URLSession (e.g. Flutter), so an empty result does not mean the app sent nothing.
Returns { status, header, armed, count, total, requests }: one line per request, oldest first, with its id (ios-3f9a-12, android-3f9a-12), method, URL, state (pending, headers, complete or failed), status, mimeType, durationMs and errorText. The header says whether capture is armed, how many requests there are and the app's pid once read, and why capture is not armed when it is not. Requests to Metro on \`port\` are left out. Pass a request's id to view-network-request-details for its headers and bodies, and on Android its redirects. The history is kept across relaunches of the app, except on a device whose devtools agent argent attached to.
On iOS and Android this tool only reads and never starts capture: call network-capture-start for the app first, then repeat the action whose requests you need. Before a start it returns started: false and a header that says capture is not started; after network-capture-stop it returns stopped: true and still lists what was captured.
On iOS: when capture started while the app was already running, the header of the first answer says that the app's launch was not recorded; to capture the launch, restart-app and call again, unless the header says the launch cannot be recorded on that device. On a local simulator, launch-app and restart-app return networkCapture saying whether capture is armed in the new process.
<flag:macos-apps>On a Mac app it returns { status, count, events }: NSURLSession events, react-native-macos fetch included. There the first call starts capture, with no network-capture-start, and capture stays on across restart-app, with a new log per process.
</flag:macos-apps>On iOS, if status is restart_required: follow the message (usually restart-app), then retry. If status is service_stale: the app is already injected, so restarting it cannot help. Restart the tool-server (\`argent server stop && argent server start --detach\`) and retry. If the same status comes back after that restart, stop restarting: follow the message, which names the terminal fallback. If status is connect_pending: the app is injected and still connecting. Do not restart it, wait a few seconds and retry. If status is init_failed: follow the message (re-boot the simulator) rather than retrying.
On a device whose devtools agent argent attached to rather than armed itself, a not-connected app fails with \`NATIVE_DEVTOOLS_NOT_CONNECTED\` instead of a status, and no restart on argent's side fixes it. An Apple system app is rejected outright (terminal: never retry it).
On Android: needs a debuggable build. A header that says not attached means the app's current process started without launch-app or restart-app and runs without capture: restart-app or network-capture-start attaches it.
Capture also misses a request already in flight at the attach and requests from clients other than OkHttp (e.g. HttpURLConnection, Cronet); an app whose OkHttp is fully minified reports capture unavailable.
Android results also carry capture and captureDetail. When capture is active, captureDetail and the header can say that only some requests are captured: then an empty or short list does not mean the app sent nothing.`,
    zodSchema,
    services: (params): Record<string, ServiceRef> => {
      const device = resolveDevice(params.udid);
      if (device.platform === "macos") return macosAppServices(device);
      // A read never starts capture, so it names only a service that already runs.
      const live = (urn: string): boolean => isLiveService(registry, urn);
      if (device.platform === "android") {
        const port = metroPort({ device_id: params.udid, port: params.port });
        const ref = androidNetworkInspectorRef(device, params.bundleId, port);
        return live(ref.urn) ? { androidNetwork: ref } : {};
      }
      const ref = nativeDevtoolsRef(device);
      return live(ref.urn) ? { nativeDevtools: ref } : {};
    },
    async execute(services, params) {
      const device = resolveDevice(params.udid);
      if (device.platform === "macos") {
        // A Mac app keeps capture on from its first read: it has no start or stop.
        const app = requireMacosAppOfBundle(
          services,
          device,
          "native-network-logs",
          params.bundleId
        );
        await app.activateNetworkInspection();
        const events = params.limit === 0 ? [] : app.networkLog().slice(-params.limit);
        if (params.clear) app.clearNetworkLog();
        return { status: "ok", count: events.length, events };
      }
      const port = metroPort({ device_id: params.udid, port: params.port });

      if (device.platform === "android") {
        const api = services.androidNetwork as AndroidNetworkInspectorApi | undefined;
        if (!api || (!api.isStarted() && !api.isStopped())) {
          const reason = api?.unavailableReason();
          return reason
            ? unavailableAndroid(reason)
            : notStarted("android-native", params.bundleId);
        }
        return listAndroidNative(api, params, port);
      }

      // Start never captures one, so pointing at it would loop.
      if (!isInjectableBundleId(params.bundleId)) throw nonInjectableError(params.bundleId);
      const api = services.nativeDevtools as NativeDevtoolsApi | undefined;
      if (api?.isNetworkCaptureStopped(params.bundleId)) {
        // What the stop kept needs no connection, and nothing is armed.
        const store = api.networkRecords(params.bundleId);
        const listing = listNative("ios-native", store?.records(port) ?? [], params.limit, {
          armed: false,
          state: "stopped",
          detail: [STOPPED_DETAIL],
        });
        if (params.clear) store?.clear();
        return { ...listing, stopped: true };
      }
      if (!api?.isNetworkCaptureStarted(params.bundleId)) {
        return notStarted("ios-native", params.bundleId);
      }

      await ensureDeps(device.platform === "ios-remote" ? ["sim-remote"] : ["xcrun"]);
      const blocked = await precheckNativeDevtools(api, params.udid, params.bundleId);
      if (blocked) return blocked;

      /**
       * `{count: 0}` reads as "the screen made no requests", so say when the
       * truth is "nothing is capturing them", as the hierarchy tools do.
       */
      if (!api.isConnected(params.bundleId)) throw notConnected(api, params.bundleId);
      await api.refreshLentNetworkCapture(params.bundleId);
      const store = api.networkRecords(params.bundleId);
      if (!store) throw notConnected(api, params.bundleId);

      const all = store.records(port);
      const state = store.state();
      const detail: string[] = [];
      if (state.pid !== undefined) detail.push(`pid ${state.pid}`);
      if (state.note) detail.push(state.note);
      if (api.takeCaptureGap(params.bundleId)) detail.push(captureGapNote(api.armsEnv));
      const listing = listNative("ios-native", all, params.limit, {
        armed: state.armed,
        state: state.armed ? "armed" : "not armed",
        detail,
      });
      if (params.clear) store.clear();
      return listing;
    },
  };
}

const STOPPED_DETAIL =
  "capture stopped by network-capture-stop; network-capture-start turns it on again";

/** The answer before any start: no service was reached, and nothing was turned on. */
function notStarted(layer: NativeNetworkRecord["layer"], bundleId: string): NativeListing {
  return {
    status: "ok",
    header: `${layer}: not started, 0 requests (network capture is off for ${bundleId}; call network-capture-start for it, then repeat the action)`,
    armed: false,
    started: false,
    count: 0,
    total: 0,
    requests: [],
  };
}

/** The answer after a start that found the Android layer unavailable: another start finds the same. */
function unavailableAndroid(reason: string): NativeListing {
  return {
    status: "ok",
    header: `android-native: unavailable, 0 requests (${reason})`,
    armed: false,
    started: false,
    capture: "unavailable",
    captureDetail: reason,
    count: 0,
    total: 0,
    requests: [],
  };
}

function notConnected(api: NativeDevtoolsApi, bundleId: string): FailureError {
  const remedy = api.armsEnv
    ? `Network capture for it is armed and starts once it connects, so call again in a few seconds. ` +
      `Requests made before then are not recorded.`
    : `Native devtools here are an external provider's agent, which serves only the app that provider ` +
      `chose to lend. ${bundleId} is either not that app or its connection has not landed yet, so no ` +
      `native network log is being captured for it. argent did not launch this process and cannot ` +
      `re-point it, so restarting anything is the provider's call rather than argent's. Retry if the ` +
      `app has just started; otherwise, for a React Native app, read its JavaScript requests with view-network-logs.`;
  return new FailureError(`Native devtools not connected for bundleId: ${bundleId}. ${remedy}`, {
    error_code: FAILURE_CODES.NATIVE_DEVTOOLS_NOT_CONNECTED,
    error_kind: "not_found",
    failure_area: "tool_server",
    failure_stage: "native_network_logs_connection",
  });
}

/** Said once, by the first answer after capture started for an app that was already running. */
function captureGapNote(armsEnv: boolean): string {
  return armsEnv
    ? "capture started while the app was already running, so the requests before that, its launch among them, were not recorded; to capture the launch, restart-app and call again"
    : "argent connected to the app's agent while the app was running, so the requests before that, its launch among them, were not recorded; on this device a relaunch ends capture, so the launch cannot be recorded here: do not restart the app for it";
}

/** Lists without any adb work: a read attaches nothing, also while capture is started. */
function listAndroidNative(
  api: AndroidNetworkInspectorApi,
  params: Params,
  port: number
): NativeListing {
  const all = api.records(port);
  const state = api.state();
  const listing = listNative("android-native", all, params.limit, {
    armed: state.armed,
    state: state.stopped
      ? "stopped"
      : state.armed
        ? "armed"
        : state.notAttached
          ? "not attached"
          : "not armed",
    detail: state.stopped ? [STOPPED_DETAIL] : headerDetail(state),
  });
  if (params.clear) api.clear();
  return {
    ...listing,
    ...(state.stopped ? { stopped: true as const } : {}),
    ...(state.capture ? { capture: state.capture.state } : {}),
    ...(state.capture?.detail ? { captureDetail: state.capture.detail } : {}),
  };
}

/** The listing both native layers return: a header line, then the `limit` most recent requests. */
function listNative(
  layer: NativeNetworkRecord["layer"],
  all: NativeNetworkRecord[],
  limit: number,
  shape: { armed: boolean; state: string; detail: string[] }
): NativeListing {
  const shown = limit === 0 ? [] : all.slice(-limit);
  const noun = all.length === 1 ? "request" : "requests";
  return {
    status: "ok",
    header:
      `${layer}: ${shape.state}, ${all.length} ${noun}` +
      (shape.detail.length > 0 ? ` (${shape.detail.join("; ")})` : ""),
    armed: shape.armed,
    count: shown.length,
    total: all.length,
    requests: shown.map(toRequestLine),
  };
}

function headerDetail(state: AndroidNetworkInspectorState): string[] {
  const parts: string[] = [];
  if (state.process) parts.push(`pid ${state.process.pid}`);
  const capture = state.capture;
  // An active capture can still cover only part of the app's requests, and the
  // agent then says so in its detail. Show it, or an empty list reads as "the
  // app sent nothing".
  if (capture?.state === "active") {
    parts.push(`capture active${capture.detail ? `: ${capture.detail}` : ""}`);
  }
  if (capture?.state === "waiting") {
    parts.push(
      `capture waiting: ${capture.detail ?? "the app has not loaded OkHttp yet, and capture starts when it does"}`
    );
  }
  if (capture?.state === "unavailable") {
    parts.push(
      `capture unavailable${capture.detail ? `: ${capture.detail}` : ""}; use view-network-logs`
    );
  }
  if (state.droppedEvents) {
    parts.push(`${state.droppedEvents} events were lost while the agent was disconnected`);
  }
  if (state.note) parts.push(state.note);
  return parts;
}

function toRequestLine(record: NativeNetworkRecord): NativeRequestLine {
  return {
    id: record.id,
    method: record.request.method,
    url: record.request.url,
    state: record.state,
    ...(record.response
      ? { status: record.response.status, mimeType: record.response.mimeType }
      : {}),
    ...(record.timing.durationMs !== undefined ? { durationMs: record.timing.durationMs } : {}),
    ...(record.errorText ? { errorText: record.errorText } : {}),
    ...(record.rnRequestId !== undefined ? { rnRequestId: record.rnRequestId } : {}),
  };
}
