import { z } from "zod";
import { FAILURE_CODES, FailureError, type ToolDefinition } from "@argent/registry";
import {
  nativeDevtoolsRef,
  precheckNativeDevtools,
  type NativeDevtoolsApi,
  type NativeDevtoolsPrecheckBlock,
  type NetworkEvent,
} from "../../blueprints/native-devtools";
import { resolveDevice } from "../../utils/device-info";
import { ensureDeps } from "../../utils/check-deps";

const zodSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
  bundleId: z.string().describe("Bundle ID of the app"),
  limit: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .default(50)
    .describe(
      "Maximum number of requests (format 'requests') or raw events (format 'events') to return, most recent"
    ),
  format: z
    .enum(["requests", "events"])
    .optional()
    .describe(
      "'requests' (default): one compact row per request: method, url, finalUrl, status, mimeType, bytes, durationMs, error. 'events': the raw CDP Network.* events, several per request, with request and response headers. Neither format carries response bodies (dataReceived events hold only chunk sizes), and most request bodies are missing too: NSURLSession sends them as streams, so the event has only request.hasPostData: true."
    ),
  clear: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Clear the log after reading. The cleared events are gone, so with format 'requests' their headers cannot be read later: read with format 'events' first if you need them."
    ),
});

type Params = z.infer<typeof zodSchema>;
interface NativeRequestRow {
  requestId: string;
  method?: string;
  url?: string;
  finalUrl?: string;
  status?: number;
  mimeType?: string;
  bytes?: number;
  durationMs?: number;
  error?: string;
}

type Result =
  | NativeDevtoolsPrecheckBlock
  | { status: "ok"; count: number; events: NetworkEvent[]; truncated?: true }
  | {
      status: "ok";
      count: number;
      totalRequests: number;
      requests: NativeRequestRow[];
      truncated?: true;
    };

/**
 * The inner NSURLSession reports the canonical URL (`https://x.com` comes back
 * as `https://x.com/`, a host in lower case), so compare parsed forms: only a
 * real redirect should produce a `finalUrl`.
 */
function sameUrl(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return a === b;
  }
}

/** Fold CDP Network.* events into one row per requestId, in first-seen order. */
function summarizeRequests(events: NetworkEvent[]): NativeRequestRow[] {
  const rows = new Map<string, NativeRequestRow & { start?: number }>();
  for (const e of events) {
    const p = (e.params ?? {}) as Record<string, any>;
    const id = typeof p.requestId === "string" ? p.requestId : undefined;
    if (!id) continue;
    let row = rows.get(id);
    if (!row) rows.set(id, (row = { requestId: id }));
    const t = typeof p.timestamp === "number" ? p.timestamp : undefined;
    const finish = () => {
      if (typeof p.encodedDataLength === "number") row.bytes = p.encodedDataLength;
      if (typeof p.nativeDevtoolsDurationMs === "number")
        row.durationMs = Math.round(p.nativeDevtoolsDurationMs);
      else if (t !== undefined && row.start !== undefined)
        row.durationMs = Math.round((t - row.start) * 1000);
    };
    switch (e.method) {
      case "Network.requestWillBeSent":
        row.method = p.request?.method;
        row.url = p.request?.url;
        row.start = t;
        break;
      case "Network.responseReceived":
        row.status = p.response?.status;
        row.mimeType = p.response?.mimeType;
        if (row.url && p.response?.url && !sameUrl(p.response.url, row.url))
          row.finalUrl = p.response.url;
        break;
      case "Network.loadingFinished":
        finish();
        break;
      case "Network.loadingFailed":
        row.error = p.errorText ?? "failed";
        finish();
        break;
    }
  }
  return [...rows.values()].map(({ start: _start, ...row }) => row);
}

export { summarizeRequests };

export const nativeNetworkLogsTool: ToolDefinition<Params, Result> = {
  id: "native-network-logs",
  interaction: {
    startedMsg: ({ params }) => `Reading native network activity for ${params.bundleId}`,
    completedMsg: ({ params }) => `Read native network activity for ${params.bundleId}`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to read native network activity for ${params.bundleId}: ${failureSignal.error_code}`,
  },
  capability: { apple: { simulator: true }, appleRemote: { simulator: true } },
  description: `Retrieve network requests captured at the native NSURLProtocol level. 
Unlike view-network-logs, it also sees URLSession requests (default and ephemeral session configurations, and URLSession.shared) from native modules and Swift/Objective-C code. It does not see background URLSession transfers, WKWebView, Network.framework, or HTTP stacks that bypass URLSession (e.g. Flutter), so an empty result does not mean the app sent nothing. Capture starts at the first call, so the first call is usually empty: repeat the action, then call again. 
Use when you need to inspect native-level HTTP traffic that is invisible to the JS-level capture. 
Returns { status, count, totalRequests, requests } with one row per request (method, url, status, mimeType, bytes, durationMs, error). finalUrl is set when a redirect ended elsewhere; status and mimeType are then those of finalUrl. A row with no bytes, durationMs or error has not finished: it is still running, or the app cancelled it. truncated: true means the log reached its 1000-event limit, so older requests are missing, totalRequests counts only what is left, and A row without method and url lost its first events, to that limit or to a clear: true read while it was in flight. Pass format: "events" for the raw CDP events with headers (most request bodies are not captured, and response bodies never are); it returns { status, count, events } plus the same truncated: true when the oldest events, usually the requestWillBeSent ones holding request headers, were dropped.
If status is restart_required: follow the message (usually restart-app), then retry. If status is service_stale: the app is already injected, so restarting it cannot help. Restart the tool-server (\`argent server stop && argent server start --detach\`) and retry. If the same status comes back after that restart, stop restarting: follow the message, which names the terminal fallback. If status is connect_pending: the app is injected and still connecting. Do not restart it, wait a few seconds and retry. If status is init_failed: the simulator's native-devtools environment could not be initialised. Follow the message (re-boot the simulator) rather than retrying this tool.
A not-running app comes back as one of those statuses rather than a failure. An app that is not connected does too, except on a device whose devtools agent argent attached to rather than armed itself: there it fails with \`NATIVE_DEVTOOLS_NOT_CONNECTED\`, since no restart of ours can complete a handshake we do not own. Failures are separate: an Apple system app is rejected outright (terminal: never retry it), while a missing host dependency or a udid that is not an Apple device is not.`,
  zodSchema,
  services: (params) => ({
    nativeDevtools: nativeDevtoolsRef(resolveDevice(params.udid)),
  }),
  async execute(services, params) {
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

    const log = api.getNetworkLog(params.bundleId);
    const evicted = api.networkLogEvicted(params.bundleId);
    if (params.clear) api.clearNetworkLog(params.bundleId);
    // slice(-0) would return everything, so cut from the front instead.
    const mostRecent = <T>(items: T[]) => items.slice(Math.max(0, items.length - params.limit));
    const truncated = evicted ? { truncated: true as const } : {};
    if (params.format === "events") {
      const events = mostRecent(log);
      return { status: "ok", count: events.length, events, ...truncated };
    }
    const all = summarizeRequests(log);
    const requests = mostRecent(all);
    return {
      status: "ok",
      count: requests.length,
      totalRequests: all.length,
      requests,
      ...truncated,
    };
  },
};
