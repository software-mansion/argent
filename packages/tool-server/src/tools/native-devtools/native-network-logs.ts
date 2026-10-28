import { z } from "zod";
import {
  FAILURE_CODES,
  FailureError,
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
    "Android only: the app's Metro port, whose requests are left out of the listing. Omit it to use this device's port, 8081 by default."
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
      "Clear the log after reading. On Android, the IDs of cleared requests still work in view-network-request-details"
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

type Result =
  | NativeDevtoolsPrecheckBlock
  | { status: "ok"; count: number; events: NetworkEvent[] }
  | AndroidNetworkNotAttachable
  | AndroidNativeListing;

export const nativeNetworkLogsTool: ToolDefinition<Params, Result> = {
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
  },
  description: `Retrieve network requests captured at the native level: NSURLProtocol on iOS, OkHttp on Android.
Unlike the JS-level network inspector (view-network-logs), this also sees requests that never pass through JS XMLHttpRequest or fetch. On iOS that is ALL of the app's traffic, including native modules, Swift/Objective-C networking and background transfers.
Use when you need to inspect native-level HTTP traffic that is invisible to the JS-level capture. 
On iOS: returns { status, count, events } where each event contains URL, method, status code, headers, and timing.
If status is restart_required: follow the message (usually restart-app), then retry. If status is service_stale: the app is already injected, so restarting it cannot help. Restart the tool-server (\`argent server stop && argent server start --detach\`) and retry. If the same status comes back after that restart, stop restarting: follow the message, which names the terminal fallback. If status is connect_pending: the app is injected and still connecting. Do not restart it, wait a few seconds and retry. If status is init_failed: the simulator's native-devtools environment could not be initialised. Follow the message (re-boot the simulator) rather than retrying this tool.
A not-running app comes back as one of those statuses rather than a failure. An app that is not connected does too, except on a device whose devtools agent argent attached to rather than armed itself: there it fails with \`NATIVE_DEVTOOLS_NOT_CONNECTED\`, since no restart of ours can complete a handshake we do not own. Failures are separate: an Apple system app is rejected outright (terminal: never retry it), while a missing host dependency is not.
On Android: needs a debuggable build. The first call starts capture and usually returns armed: false. Call it again every few seconds until armed is true, then repeat the action whose requests you need: earlier requests are not captured.
Returns { status, header, armed, capture, count, total, requests }. Pass a request's ID (android-3f9a-12) to view-network-request-details for its headers, redirects and bodies.
Capture can slow the app. It stays on, and launch-app and restart-app attach it to each new process, until stop-all-simulator-servers stops this device's services; restart-app then starts the app without it.
When status is not_attachable, use view-network-logs and do not retry.`,
  zodSchema,
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.udid);
    if (device.platform === "android") {
      const port = metroPort({ device_id: params.udid, port: params.port });
      return { androidNetwork: androidNetworkInspectorRef(device, params.bundleId, port) };
    }
    return { nativeDevtools: nativeDevtoolsRef(device) };
  },
  async execute(services, params) {
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
