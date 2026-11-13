import { z } from "zod";
import {
  FAILURE_CODES,
  FailureError,
  ServiceState,
  type Registry,
  type ServiceRef,
  type ToolDefinition,
} from "@argent/registry";
import {
  nativeDevtoolsRef,
  precheckNativeDevtools,
  type NativeDevtoolsApi,
  type NativeDevtoolsPrecheckBlock,
} from "../../blueprints/native-devtools";
import {
  androidNetworkInspectorRef,
  liveAndroidNetworkCaptures,
  type AndroidCaptureState,
  type AndroidNetworkInspectorApi,
  type AndroidNetworkInspectorState,
  type AndroidNetworkNotAttachable,
} from "../../blueprints/android-network-inspector";
import type { NativeNetworkRecord, NativeRecordState } from "../../utils/native-network-record";
import { resolveDevice } from "../../utils/device-info";
import { ensureDeps } from "../../utils/check-deps";
import { metroPort, metroPortField } from "../../utils/debugger/metro-port";
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
      "Clear the log after reading. On Android, the IDs of cleared requests still work in view-network-request-details"
    ),
  stop: z
    .boolean()
    .optional()
    .describe(
      "Android only: turn native capture off for this app instead of listing. Other apps keep theirs."
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
  /** Android: the capture state the in-app agent reports. */
  capture?: AndroidCaptureState;
  /** Android: the detail the in-app agent sent with the capture state, for example why only some requests are captured. */
  captureDetail?: string;
  count: number;
  total: number;
  requests: NativeRequestLine[];
}

interface AndroidNativeStopped {
  status: "ok";
  stopped: boolean;
  message: string;
}

type Result =
  | NativeDevtoolsPrecheckBlock
  | { status: "ok"; count: number; events: NetworkEvent[] }
  | AndroidNetworkNotAttachable
  | NativeListing
  | AndroidNativeStopped;

/** `stop` reads and disposes the app's inspector without ever creating one. */
type InspectorRegistry = Pick<Registry, "getSnapshot" | "resolveService" | "disposeService">;

export function createNativeNetworkLogsTool(
  registry: InspectorRegistry
): ToolDefinition<Params, Result> {
  return {
    id: "native-network-logs",
    interaction: {
      startedMsg: ({ params }) =>
        params.stop
          ? `Stopping native network capture for ${params.bundleId}`
          : `Reading native network activity for ${params.bundleId}`,
      completedMsg: ({ params }) =>
        params.stop
          ? `Stopped native network capture for ${params.bundleId}`
          : `Read native network activity for ${params.bundleId}`,
      failedMsg: ({ params, failureSignal }) =>
        params.stop
          ? `Failed to stop native network capture for ${params.bundleId}: ${failureSignal.error_code}`
          : `Failed to read native network activity for ${params.bundleId}: ${failureSignal.error_code}`,
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
Returns { status, header, armed, count, total, requests }: one line per request, oldest first, with its id (ios-3f9a-12, android-3f9a-12), method, URL, state (pending, headers, complete or failed), status, mimeType, durationMs and errorText. The header says whether capture is armed, how many requests there are and the app's pid once read, and why capture is not armed when it is not. Requests to Metro on \`port\` are left out. The history is kept across relaunches of the app, except on a device whose devtools agent argent attached to.
The first call for an app starts capture, so earlier requests are not captured: repeat the action whose requests you need, then call again.
On iOS: the first call waits until the app acknowledges capture. When capture started while the app was already running, the header of the first answer says that the app's launch was not recorded; to capture the launch, restart-app and call again, unless the header says the launch cannot be recorded on that device. Capture stays on for later processes of the app (except on a device whose devtools agent argent attached to, where a relaunch ends it).
<flag:macos-apps>On a Mac app: { status, count, events } of NSURLSession requests, react-native-macos fetch included; capture stays on across restart-app, a new log per process.
</flag:macos-apps>On iOS: If status is restart_required: follow the message (usually restart-app), then retry. If status is service_stale: the app is already injected, so restarting it cannot help. Restart the tool-server (\`argent server stop && argent server start --detach\`) and retry. If the same status comes back after that restart, stop restarting: follow the message, which names the terminal fallback. If status is connect_pending: the app is injected and still connecting. Do not restart it, wait a few seconds and retry. If status is init_failed: follow the message (re-boot the simulator) rather than retrying.
On a device whose devtools agent argent attached to rather than armed itself, a not-connected app fails with \`NATIVE_DEVTOOLS_NOT_CONNECTED\` instead of a status, and no restart on argent's side fixes it. An Apple system app is rejected outright (terminal: never retry it).
On Android: needs a debuggable build. The first call usually returns armed: false. Call it again every few seconds until armed is true, then repeat the action whose requests you need.
Capture also misses a request already in flight at the attach and requests from clients other than OkHttp (e.g. HttpURLConnection, Cronet); an app whose OkHttp is fully minified reports capture unavailable.
Android results also carry capture and captureDetail. When capture is active, captureDetail and the header can say that only some requests are captured: then an empty or short list does not mean the app sent nothing. Pass an Android request's ID (android-3f9a-12) to view-network-request-details for its headers, redirects and bodies.
Capture can slow the app. It stays on, and launch-app and restart-app attach it to each new process, until a call with stop: true turns it off for this app (stop-all-simulator-servers for the device also does); restart-app then starts the app without the agent. stop: true returns { status, stopped, message }, where stopped is false when capture was not on for the app. On iOS stop: true fails: capture there ends only when stop-all-simulator-servers stops this device's services, and in the running process only when the app restarts.
When status is not_attachable, use view-network-logs and do not retry.`,
    zodSchema,
    services: (params): Record<string, ServiceRef> => {
      const device = resolveDevice(params.udid);
      // Stopping must not create the inspector it is asked to stop, and iOS
      // has nothing to stop.
      if (params.stop) return {};
      if (device.platform === "macos") return macosAppServices(device);
      if (device.platform === "android") {
        const port = metroPort({ device_id: params.udid, port: params.port });
        return { androidNetwork: androidNetworkInspectorRef(device, params.bundleId, port) };
      }
      return { nativeDevtools: nativeDevtoolsRef(device) };
    },
    async execute(services, params) {
      if (params.stop) return stopAndroidNative(registry, params);

      if (services.androidNetwork) {
        await ensureDeps(["adb"]);
        return listAndroidNative(services.androidNetwork as AndroidNetworkInspectorApi, params);
      }

      const device = resolveDevice(params.udid);
      if (device.platform === "macos") {
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
      await ensureDeps(device.platform === "ios-remote" ? ["sim-remote"] : ["xcrun"]);

      const api = services.nativeDevtools as NativeDevtoolsApi;

      const blocked = await precheckNativeDevtools(api, params.udid, params.bundleId);
      // Capture is on for the app before a block is returned, so the relaunch
      // the block asks for is armed when it connects.
      const arming = api.activateNetworkInspection(params.bundleId);
      if (blocked) return blocked;

      /**
       * `{count: 0}` reads as "the screen made no requests", so say when the
       * truth is "nothing is capturing them", as the hierarchy tools do.
       */
      if (!api.isConnected(params.bundleId)) throw notConnected(api, params.bundleId);
      await arming;
      const store = api.networkRecords(params.bundleId);
      if (!store) throw notConnected(api, params.bundleId);

      const all = store.records(metroPort({ device_id: params.udid, port: params.port }));
      const state = store.state();
      const detail: string[] = [];
      if (state.pid !== undefined) detail.push(`pid ${state.pid}`);
      if (state.note) detail.push(state.note);
      if (api.takeCaptureGap(params.bundleId)) detail.push(captureGapNote(api.armsEnv));
      const listing = listNative("ios-native", all, params.limit, state.armed, detail);
      if (params.clear) store.clear();
      return listing;
    },
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

/**
 * Turns native capture off for one app by disposing its inspector, the same
 * teardown stop-all-simulator-servers runs: the agent stops capturing, and the
 * session file, the agent's files and the reverse are removed. Nothing else on
 * the device changes. `stopped` is true only when capture was on.
 */
async function stopAndroidNative(
  registry: InspectorRegistry,
  params: Params
): Promise<AndroidNativeStopped> {
  const device = resolveDevice(params.udid);
  if (device.platform !== "android") {
    // The iOS devtools and the Mac library can turn network inspection on for an app, never off.
    throw new FailureError(
      device.platform === "macos"
        ? "stop applies to Android only. On a Mac app, network capture stays on until stop-all-simulator-servers stops this device's services or the tool-server stops."
        : "stop applies to Android only. On iOS, network capture stays on for the app until stop-all-simulator-servers stops this device's services and the app restarts.",
      {
        error_code: FAILURE_CODES.NATIVE_NETWORK_LOGS_STOP_UNSUPPORTED,
        failure_stage: "native_network_logs_stop",
        failure_area: "tool_server",
        error_kind: "unsupported",
      }
    );
  }
  const notOn: AndroidNativeStopped = {
    status: "ok",
    stopped: false,
    message: `native network capture was not on for ${params.bundleId} on ${params.udid}`,
  };
  const port = metroPort({ device_id: params.udid, port: params.port });
  const { urn } = androidNetworkInspectorRef(device, params.bundleId, port);
  const state = registry.getSnapshot().services.get(urn)?.state;
  if (state === undefined || state === ServiceState.IDLE) return notOn;
  // An inspector whose first call did not go through never turned capture on,
  // but it may hold a session or a reverse, so it is disposed all the same.
  const wasOn =
    state === ServiceState.RUNNING &&
    liveAndroidNetworkCaptures(params.udid).includes(params.bundleId);
  let pid: number | undefined;
  if (wasOn) {
    const api = await registry.resolveService<AndroidNetworkInspectorApi>(urn);
    pid = api.state().process?.pid;
  }
  await registry.disposeService(urn);
  if (!wasOn) return notOn;
  return {
    status: "ok",
    stopped: true,
    message:
      `native network capture stopped for ${params.bundleId} on ${params.udid}. ` +
      (pid !== undefined
        ? `The in-app agent stays loaded in pid ${pid}, without capturing, until that process ends; `
        : "An in-app agent that was attached stays loaded until its process ends; ") +
      "restart-app starts the app without it.",
  };
}

async function listAndroidNative(
  api: AndroidNetworkInspectorApi,
  params: Params
): Promise<AndroidNetworkNotAttachable | NativeListing> {
  const port = metroPort({ device_id: params.udid, port: params.port });
  const attached = await api.ensureAttached(port);
  if (attached?.status === "not_attachable") return attached;

  const all = api.records(port);
  const state = api.state();
  const listing = listNative(
    "android-native",
    all,
    params.limit,
    state.armed,
    headerDetail(state, attached?.note)
  );
  if (params.clear) api.clear();
  return {
    ...listing,
    ...(state.capture ? { capture: state.capture.state } : {}),
    ...(state.capture?.detail ? { captureDetail: state.capture.detail } : {}),
  };
}

/** The listing both native layers return: a header line, then the `limit` most recent requests. */
function listNative(
  layer: NativeNetworkRecord["layer"],
  all: NativeNetworkRecord[],
  limit: number,
  armed: boolean,
  detail: string[]
): NativeListing {
  const shown = limit === 0 ? [] : all.slice(-limit);
  const noun = all.length === 1 ? "request" : "requests";
  return {
    status: "ok",
    header:
      `${layer}: ${armed ? "armed" : "not armed"}, ${all.length} ${noun}` +
      (detail.length > 0 ? ` (${detail.join("; ")})` : ""),
    armed,
    count: shown.length,
    total: all.length,
    requests: shown.map(toRequestLine),
  };
}

/** `callNote` is about this call alone, as when adb did not answer it. */
function headerDetail(state: AndroidNetworkInspectorState, callNote?: string): string[] {
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
  if (callNote) parts.push(callNote);
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
