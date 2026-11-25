import type { CDPClient } from "../utils/debugger/cdp-client";
import type { CdpNetworkConditions } from "../utils/network-conditions";

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
  initiator?: { type: string; url?: string; lineNumber?: number };
  /** ISO timestamp, from CDP wallTime. */
  startedDateTime: string;
  /** Monotonic CDP timestamp of requestWillBeSent, in seconds. */
  startTs: number;
  durationMs?: number;
  fromCache?: boolean;
  encodedDataLength?: number;
  /**
   * The whole response was received: Network.loadingFinished arrived, or the
   * page got every byte of the body that the response declared.
   */
  finished?: boolean;
  failed?: boolean;
  errorText?: string;
}

/**
 * Where the last network-capture-start began in this tab's log, as a sequence
 * number: a record numbered higher was created after it. A stop keeps the
 * mark and adds where it ended, so a wait reads only the records between.
 */
interface ChromiumCaptureMark {
  lastSeq: number;
  stoppedSeq?: number;
}

export interface NetworkManager {
  /** Oldest first; capped at MAX_RECORDS, evicting the oldest. */
  requests(): NetworkRequestRecord[];
  /** The kept records created after sequence number `seq`, oldest first, each with its number. */
  requestsAfter(seq: number): Array<{ seq: number; record: NetworkRequestRecord }>;
  get(requestId: string): NetworkRequestRecord | undefined;
  /** Marks where a capture starts: the records created from now on come after it. */
  startCapture(): ChromiumCaptureMark;
  /** Marks where the started capture ends; undefined when it was never started. */
  stopCapture(): ChromiumCaptureMark | undefined;
  captureMark(): ChromiumCaptureMark | undefined;
  /** Enables the Network domain; called on connect and after a tab switch. */
  reattach(): Promise<void>;
  /** Conditions are per target, so `reattach` applies them again to the new tab. */
  setConditions(conditions: CdpNetworkConditions): Promise<void>;
  /** True while the stored conditions shape traffic, false after a reset. */
  throttled(): boolean;
  dispose(): void;
}

const MAX_RECORDS = 1000;

const shapesTraffic = (c: CdpNetworkConditions): boolean =>
  c.offline || c.latency > 0 || c.downloadThroughput >= 0 || c.uploadThroughput >= 0;

/**
 * The length of the body as the page gets it, when the response declares one:
 * its Content-Length, unless a Content-Encoding makes the page get the body
 * decoded, in another length.
 */
function declaredBodyLength(headers: Record<string, string> | undefined): number | undefined {
  let length: string | undefined;
  for (const [name, value] of Object.entries(headers ?? {})) {
    const header = name.toLowerCase();
    if (header === "content-encoding" && value.trim().toLowerCase() !== "identity") {
      return undefined;
    }
    if (header === "content-length") length = value.trim();
  }
  return length !== undefined && /^\d+$/.test(length) ? Number(length) : undefined;
}

export function createNetworkManager(deps: { cdp: CDPClient }): NetworkManager {
  const { cdp } = deps;
  const order: string[] = [];
  const byId = new Map<string, NetworkRequestRecord>();
  // The sequence number of each kept record, in creation order.
  const seqOf = new Map<string, number>();
  let lastSeq = 0;
  let mark: ChromiumCaptureMark | undefined;
  let conditions: CdpNetworkConditions | null = null;
  /** The bytes of each declared body that the page has not got yet. */
  const bodyBytesLeft = new WeakMap<NetworkRequestRecord, number>();

  function record(requestId: string): NetworkRequestRecord {
    let rec = byId.get(requestId);
    if (!rec) {
      rec = { requestId, method: "", url: "", startedDateTime: "", startTs: 0 };
      byId.set(requestId, rec);
      seqOf.set(requestId, ++lastSeq);
      order.push(requestId);
      if (order.length > MAX_RECORDS) {
        const evicted = order.shift();
        if (evicted) {
          byId.delete(evicted);
          seqOf.delete(evicted);
        }
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
        // Merge, don't replace: requestWillBeSentExtraInfo carries the rest of the
        // headers and may land before or after this event.
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
        const length = declaredBodyLength(resp.headers);
        if (length !== undefined) bodyBytesLeft.set(rec, length);
        break;
      }
      // For a fetch() whose response is not stored (Cache-Control: no-store), Chrome
      // sends loadingFinished only once the page reads the body to its end, and never
      // for a body the page leaves unread. Such a body ended once the page got all of it.
      case "Network.dataReceived": {
        const rec = byId.get(params.requestId as string);
        const left = rec ? bodyBytesLeft.get(rec) : undefined;
        if (rec && left !== undefined) {
          const after = left - (params.dataLength as number);
          bodyBytesLeft.set(rec, after);
          if (after <= 0) rec.finished = true;
        }
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
          rec.finished = true;
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
    requestsAfter: (seq) =>
      order.flatMap((id) => {
        const at = seqOf.get(id);
        const rec = byId.get(id);
        return at !== undefined && at > seq && rec ? [{ seq: at, record: rec }] : [];
      }),
    get: (requestId: string) => byId.get(requestId),
    startCapture: () => (mark = { lastSeq }),
    stopCapture: () => {
      if (mark && mark.stoppedSeq === undefined) mark = { ...mark, stoppedSeq: lastSeq };
      return mark;
    },
    captureMark: () => mark,
    reattach: async () => {
      await cdp.send("Network.enable").catch(() => {});
      if (conditions) {
        await cdp.send("Network.emulateNetworkConditions", conditions).catch(() => {});
      }
    },
    setConditions: async (next) => {
      await cdp.send("Network.emulateNetworkConditions", next);
      conditions = next;
    },
    throttled: () => conditions !== null && shapesTraffic(conditions),
    dispose: () => {
      cdp.events.off("event", onEvent);
      cdp.send("Network.disable").catch(() => {});
    },
  };
}
