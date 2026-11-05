import type { CDPClient } from "../utils/debugger/cdp-client";

/** One earlier hop of a redirected request, from CDP `redirectResponse`. */
export interface NetworkRedirectHop {
  method: string;
  url: string;
  status: number;
  statusText?: string;
  location?: string;
  /** Monotonic CDP timestamp of the redirect response, in seconds. */
  timestamp: number;
}

/**
 * Backs `view-network-logs` and `view-network-request-details` on Chromium:
 * recorded passively from CDP `Network` events, with no injected interceptor
 * as on the RN path.
 */
export interface NetworkRequestRecord {
  requestId: string;
  method: string;
  url: string;
  resourceType?: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  postData?: string;
  /** Earlier hops, oldest first. The other fields describe the final hop. */
  redirects?: NetworkRedirectHop[];
  initiator?: { type: string; url?: string; lineNumber?: number };
  /** ISO timestamp, from CDP wallTime. */
  startedDateTime: string;
  /** Monotonic CDP timestamp of requestWillBeSent, in seconds. */
  startTs: number;
  durationMs?: number;
  fromCache?: boolean;
  encodedDataLength?: number;
  failed?: boolean;
  errorText?: string;
}

export interface NetworkManager {
  /** Oldest first; capped at MAX_RECORDS, evicting the oldest. */
  requests(): NetworkRequestRecord[];
  get(requestId: string): NetworkRequestRecord | undefined;
  /** Enables the Network domain; called on connect and after a tab switch. */
  reattach(): Promise<void>;
  dispose(): void;
}

const MAX_RECORDS = 1000;

export function createNetworkManager(deps: { cdp: CDPClient }): NetworkManager {
  const { cdp } = deps;
  const order: string[] = [];
  const byId = new Map<string, NetworkRequestRecord>();

  function record(requestId: string): NetworkRequestRecord {
    let rec = byId.get(requestId);
    if (!rec) {
      rec = { requestId, method: "", url: "", startedDateTime: "", startTs: 0 };
      byId.set(requestId, rec);
      order.push(requestId);
      if (order.length > MAX_RECORDS) {
        const evicted = order.shift();
        if (evicted) byId.delete(evicted);
      }
    }
    return rec;
  }

  function onEvent(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case "Network.requestWillBeSent": {
        const r = (params.request ?? {}) as {
          method?: string;
          url?: string;
          headers?: Record<string, string>;
          postData?: string;
        };
        const rec = record(params.requestId as string);
        const redirect = params.redirectResponse as
          { status: number; statusText?: string; headers?: Record<string, string> } | undefined;
        // A redirect reuses the requestId. Keep the previous hop as a `redirects`
        // entry, so its method, URL and 303 are visible, and drop its body and
        // response so they do not leak onto the new request.
        if (redirect) {
          const location = Object.entries(redirect.headers ?? {}).find(
            ([name]) => name.toLowerCase() === "location"
          )?.[1];
          (rec.redirects ??= []).push({
            method: rec.method,
            url: rec.url,
            status: redirect.status,
            statusText: redirect.statusText,
            location,
            timestamp: params.timestamp as number,
          });
          delete rec.postData;
          delete rec.status;
          delete rec.statusText;
          delete rec.mimeType;
          delete rec.responseHeaders;
        }
        rec.method = r.method ?? rec.method;
        rec.url = r.url ?? rec.url;
        // Merge, don't replace: requestWillBeSentExtraInfo carries the rest of the
        // headers and may land before or after this event.
        if (r.headers) rec.requestHeaders = { ...(rec.requestHeaders ?? {}), ...r.headers };
        if (r.postData != null) rec.postData = r.postData;
        rec.resourceType = (params.type as string) ?? rec.resourceType;
        rec.initiator = (params.initiator as NetworkRequestRecord["initiator"]) ?? rec.initiator;
        // Keep the first hop's start, so the duration covers the whole redirect chain.
        if (!redirect) {
          rec.startTs = (params.timestamp as number) ?? rec.startTs;
          if (params.wallTime) {
            rec.startedDateTime = new Date((params.wallTime as number) * 1000).toISOString();
          }
        }
        break;
      }
      case "Network.responseReceived": {
        const resp = (params.response ?? {}) as {
          status?: number;
          statusText?: string;
          mimeType?: string;
          headers?: Record<string, string>;
          fromDiskCache?: boolean;
        };
        const rec = record(params.requestId as string);
        rec.status = resp.status;
        rec.statusText = resp.statusText;
        rec.mimeType = resp.mimeType;
        if (resp.headers) rec.responseHeaders = { ...(rec.responseHeaders ?? {}), ...resp.headers };
        rec.fromCache = resp.fromDiskCache;
        rec.resourceType = (params.type as string) ?? rec.resourceType;
        break;
      }
      // The *ExtraInfo events carry on-the-wire headers (Authorization, Set-Cookie, …)
      // the base events omit, and may arrive before them — hence `record()`, not `get()`.
      case "Network.requestWillBeSentExtraInfo": {
        const h = params.headers as Record<string, string> | undefined;
        if (h) {
          const rec = record(params.requestId as string);
          rec.requestHeaders = { ...(rec.requestHeaders ?? {}), ...h };
        }
        break;
      }
      case "Network.responseReceivedExtraInfo": {
        const h = params.headers as Record<string, string> | undefined;
        if (h) {
          const rec = record(params.requestId as string);
          rec.responseHeaders = { ...(rec.responseHeaders ?? {}), ...h };
        }
        break;
      }
      case "Network.loadingFinished": {
        const rec = byId.get(params.requestId as string);
        if (rec) {
          rec.encodedDataLength = params.encodedDataLength as number;
          if (rec.startTs) rec.durationMs = ((params.timestamp as number) - rec.startTs) * 1000;
        }
        break;
      }
      case "Network.loadingFailed": {
        const rec = byId.get(params.requestId as string);
        if (rec) {
          rec.failed = true;
          rec.errorText = params.errorText as string;
          rec.resourceType = (params.type as string) ?? rec.resourceType;
        }
        break;
      }
    }
  }

  cdp.events.on("event", onEvent);

  return {
    requests: () => order.map((id) => byId.get(id)).filter((r): r is NetworkRequestRecord => !!r),
    get: (requestId: string) => byId.get(requestId),
    reattach: async () => {
      await cdp.send("Network.enable").catch(() => {});
    },
    dispose: () => {
      cdp.events.off("event", onEvent);
      cdp.send("Network.disable").catch(() => {});
    },
  };
}
