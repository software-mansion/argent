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
  type NetworkEvent,
} from "../../blueprints/native-devtools";
import {
  androidNetworkInspectorRef,
  type AndroidCaptureState,
  type AndroidNativeRecord,
  type AndroidNativeRecordState,
  type AndroidNetworkInspectorApi,
  type AndroidNetworkInspectorState,
  type AndroidNetworkNotAttachable,
} from "../../blueprints/android-network-inspector";
import { resolveDevice } from "../../utils/device-info";
import { ensureDeps } from "../../utils/check-deps";
import { metroPort, metroPortField } from "../../utils/debugger/metro-port";

const zodSchema = z.object({
  udid: z.string().describe("Device ID from list-devices: an iOS simulator UDID or Android serial"),
  bundleId: z.string().describe("App bundle ID on iOS or package name on Android"),
  port: metroPortField.describe(
    "Android only: the app's Metro port, whose own requests are left out of the listing. Omit it to use this device's port, 8081 by default. Ignored on iOS."
  ),
  limit: z
    .number()
    .optional()
    .default(50)
    .describe("Maximum number of entries to return: the most recent ones, oldest first"),
  clear: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Clear the log after reading. On Android this hides every request listed so far, also ones past limit; their IDs still work in view-network-request-details"
    ),
  stop: z
    .boolean()
    .optional()
    .describe(
      "Android only: end native capture for this app instead of listing. Other apps keep theirs."
    ),
});

type Params = z.infer<typeof zodSchema>;

interface AndroidNativeRequestLine {
  id: string;
  method: string;
  url: string;
  state: AndroidNativeRecordState;
  status?: number;
  mimeType?: string;
  durationMs?: number;
  errorText?: string;
  rnRequestId?: number;
}

interface AndroidNativeListing {
  status: "ok";
  header: string;
  armed: boolean;
  capture?: AndroidCaptureState;
  count: number;
  total: number;
  requests: AndroidNativeRequestLine[];
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
  | AndroidNativeListing
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
    },
    description: `Retrieve network requests captured at the native level: NSURLProtocol traffic on iOS, OkHttp traffic on Android.
Unlike the JS-level network inspector (view-network-logs), this also sees requests made outside JS fetch. On iOS that is ALL of the app's traffic, including native modules, Swift/Objective-C networking and background transfers.
Use when you need native-level HTTP traffic that is invisible to JS fetch interception.
On iOS: returns { status, count, events }, where each event contains URL, method, status code, headers and timing. If status is restart_required: follow the message (usually restart-app), then retry. If status is service_stale: the app is already injected, so restarting it cannot help — restart the tool-server (\`argent server stop && argent server start --detach\`) and retry. If the same status comes back after that restart, stop restarting: follow the message, which names the terminal fallback. If status is connect_pending: the app is injected and still connecting — do not restart it, wait a few seconds and retry. If status is init_failed: the simulator's native-devtools environment could not be initialised — follow the message (re-boot the simulator) rather than retrying this tool. A not-running app comes back as one of those statuses rather than a failure. An app that is not connected does too, except on a device whose devtools agent argent attached to rather than armed itself — there it fails with \`NATIVE_DEVTOOLS_NOT_CONNECTED\`, since no restart of ours can complete a handshake we do not own. Failures are separate: an Apple system app is rejected outright (terminal — never retry it), while a missing host dependency is not. stop does not apply on iOS.
On Android: needs a debuggable build on Android 8.0 or later (arm64-v8a or x86_64). The first call sets capture up and usually returns armed: false. Call it again every few seconds until armed is true, then repeat the action whose requests you need. When the app is not running, status is still ok and the header says so; launch it with launch-app or restart-app.
Returns { status: "ok", header, armed, capture, count, total, requests }. The header names the app's pid and the capture state: active (requests are captured), waiting (the app has not loaded OkHttp yet; capture starts when it does) or unavailable (nothing can be captured in this process; use view-network-logs). Requests are listed oldest first, and each has an ID such as android-3f9a-12. Pass it to view-network-request-details for the headers, the final URL, redirects and the request or response body.
Capture includes React Native requests, images and other OkHttp traffic. It misses requests made before the agent connected, such as startup requests, and native modules that do not use OkHttp. Requests to the app's Metro port (port, or this device's default) are left out.
Capture stays on for the app until stop: true. launch-app and restart-app attach it to the new process and say so in their output; a process started any other way (open-url, a launcher tap, a crash relaunch) is attached by the next call of this tool.
Capture can slow the app. stop: true ends it for this app only: its android- IDs stop resolving, and the agent stays loaded in the current process, so call restart-app before profiling.
When status is not_attachable, use view-network-logs. Do not retry native capture.`,
    zodSchema,
    services: (params): Record<string, ServiceRef> => {
      const device = resolveDevice(params.udid);
      // Stopping must not create the inspector it is asked to stop, and
      // iOS has nothing to stop.
      if (params.stop) return {};
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
      await ensureDeps(device.platform === "ios-remote" ? ["sim-remote"] : ["xcrun"]);

      const api = services.nativeDevtools as NativeDevtoolsApi;

      const blocked = await precheckNativeDevtools(api, params.udid, params.bundleId);
      if (blocked) return blocked;

      /**
       * `{count: 0}` reads as "the screen made no requests", so say when the
       * truth is "nothing is capturing them", as the hierarchy tools do.
       */
      if (!api.isConnected(params.bundleId)) {
        throw new FailureError(
          `Native devtools not connected for bundleId: ${params.bundleId}. ` +
            `No network log is being captured for it.`,
          {
            error_code: FAILURE_CODES.NATIVE_DEVTOOLS_NOT_CONNECTED,
            error_kind: "not_found",
            failure_area: "tool_server",
            failure_stage: "native_network_logs_connection",
          }
        );
      }

      api.activateNetworkInspection(params.bundleId);

      const events = api.getNetworkLog(params.bundleId).slice(-params.limit);
      if (params.clear) api.clearNetworkLog(params.bundleId);
      return { status: "ok", count: events.length, events };
    },
  };
}

/**
 * Ends native capture for one app: its inspector sends Network.disable to the
 * agent, takes its session file and tunnel back, and is disposed. Nothing else
 * on the device changes.
 */
async function stopAndroidNative(
  registry: InspectorRegistry,
  params: Params
): Promise<AndroidNativeStopped> {
  const device = resolveDevice(params.udid);
  if (device.platform !== "android") {
    // The iOS devtools can turn network inspection on for an app, never off.
    throw new FailureError(
      "stop applies to Android only. On iOS, network capture stays on for the app until stop-all-simulator-servers stops this device's services and the app restarts.",
      {
        error_code: FAILURE_CODES.NATIVE_NETWORK_LOGS_STOP_UNSUPPORTED,
        failure_stage: "native_network_logs_stop",
        failure_area: "tool_server",
        error_kind: "unsupported",
      }
    );
  }
  const port = metroPort({ device_id: params.udid, port: params.port });
  const { urn } = androidNetworkInspectorRef(device, params.bundleId, port);
  const state = registry.getSnapshot().services.get(urn)?.state;
  if (state === undefined || state === ServiceState.IDLE) {
    return {
      status: "ok",
      stopped: false,
      message: `native network capture was not on for ${params.bundleId} on ${params.udid}`,
    };
  }
  let pid: number | undefined;
  if (state === ServiceState.RUNNING) {
    const api = await registry.resolveService<AndroidNetworkInspectorApi>(urn);
    pid = api.state().process?.pid;
  }
  await registry.disposeService(urn);
  if (state !== ServiceState.RUNNING) {
    return {
      status: "ok",
      stopped: false,
      message: `native network capture was not on for ${params.bundleId} on ${params.udid}`,
    };
  }
  return {
    status: "ok",
    stopped: true,
    message:
      `native network capture stopped for ${params.bundleId}` +
      (pid !== undefined
        ? `; the agent stays loaded in pid ${pid} without capturing until the app restarts, so restart-app gives it a process without the agent`
        : ""),
  };
}

async function listAndroidNative(
  api: AndroidNetworkInspectorApi,
  params: Params
): Promise<AndroidNetworkNotAttachable | AndroidNativeListing> {
  const port = metroPort({ device_id: params.udid, port: params.port });
  const attached = await api.ensureAttached(port);
  if (attached?.status === "not_attachable") return attached;

  const all = api.records(port);
  const shown = all.slice(-params.limit);
  const requests = shown.map(toRequestLine);
  if (params.clear) api.clear();

  const state = api.state();
  const detail = headerDetail(state, attached?.note);
  const noun = all.length === 1 ? "request" : "requests";
  return {
    status: "ok",
    header:
      `android-native: ${state.armed ? "armed" : "not armed"}, ${all.length} ${noun}` +
      (detail.length > 0 ? ` (${detail.join("; ")})` : ""),
    armed: state.armed,
    ...(state.capture ? { capture: state.capture.state } : {}),
    count: requests.length,
    total: all.length,
    requests,
  };
}

/** `callNote` is about this call alone, as when adb did not answer it. */
function headerDetail(state: AndroidNetworkInspectorState, callNote?: string): string[] {
  const parts: string[] = [];
  if (state.process) parts.push(`pid ${state.process.pid}`);
  const capture = state.capture;
  if (capture?.state === "active") parts.push("capture active");
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

function toRequestLine(record: AndroidNativeRecord): AndroidNativeRequestLine {
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
