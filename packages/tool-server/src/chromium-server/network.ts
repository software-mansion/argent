import type { CDPClient } from "../utils/debugger/cdp-client";

/**
 * A recorded network request/response, captured passively from the page's CDP
 * `Network` domain events. This is the data source behind `view-network-logs`
 * and `view-network-request-details` on Chromium devices — the browser exposes
 * this natively, so (unlike the RN path) no in-app interceptor is injected.
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
  /** Request body, when the request carried one (POST/PUT/…). */
  postData?: string;
  initiator?: { type: string; url?: string; lineNumber?: number };
  /** ISO timestamp the request started (from CDP wallTime). */
  startedDateTime: string;
  /** monotonic CDP timestamp of requestWillBeSent (seconds). */
  startTs: number;
  durationMs?: number;
  fromCache?: boolean;
  encodedDataLength?: number;
  failed?: boolean;
  errorText?: string;
}

export interface NetworkManager {
  /** All recorded requests, oldest first (capped ring buffer). */
  requests(): NetworkRequestRecord[];
  /** Look up a single recorded request by its CDP requestId. */
  get(requestId: string): NetworkRequestRecord | undefined;
  /** (Re-)enable the Network domain on the active page. Called on connect and after a tab switch. */
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
        rec.method = r.method ?? rec.method;
        rec.url = r.url ?? rec.url;
        // Merge (don't replace): the full on-the-wire headers — including ones
        // added by fetch()/CORS like Authorization — arrive separately in
        // requestWillBeSentExtraInfo, which may land before or after this event.
        if (r.headers) rec.requestHeaders = { ...(rec.requestHeaders ?? {}), ...r.headers };
        if (r.postData != null) rec.postData = r.postData;
        rec.resourceType = (params.type as string) ?? rec.resourceType;
        rec.initiator = (params.initiator as NetworkRequestRecord["initiator"]) ?? rec.initiator;
        rec.startTs = (params.timestamp as number) ?? rec.startTs;
        if (params.wallTime) {
          rec.startedDateTime = new Date((params.wallTime as number) * 1000).toISOString();
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
      // The *ExtraInfo events carry the actual on-the-wire headers (Authorization,
      // Set-Cookie, …) that the base events omit. Merge them in; they may arrive
      // before the base event, so `record()` creates the entry if needed.
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
