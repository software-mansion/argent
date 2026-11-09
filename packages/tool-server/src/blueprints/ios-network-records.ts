import { randomBytes } from "node:crypto";
import { STATUS_CODES } from "node:http";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import { withKeyedLock } from "../utils/keyed-lock";
import {
  MAX_CACHED_BODIES,
  MAX_LAYER_ID_CHARS,
  MAX_RECORDS,
  MAX_VALUE_CHARS,
  NOT_RECONNECTED,
  PROCESS_ENDED,
  PROCESS_GONE,
  RECORD_CHARS_BUDGET,
  asObject,
  asString,
  capString,
  deviceKeyOf,
  headerMap,
  isMetroTraffic,
  isOpen,
  recordSize,
  toBody,
  unavailable,
  type NativeNetworkBody,
  type NativeNetworkRecord,
} from "../utils/native-network-record";

/**
 * A tag per tool-server start, so an id from before a restart rarely names
 * another request: two starts share a tag 1 time in 65536.
 */
const RUN_TAG = randomBytes(2).toString("hex");

export const IOS_NATIVE_REQUEST_ID = /^ios-[0-9a-f]{4}-\d+$/;

/** Shared by every store of the tool-server, so ids never repeat across apps or devices. */
let nextRecordNumber = 1;

/** A request body read answers within this, with the body or with "still sending". */
const POST_DATA_WAIT_MS = 5_000;
/**
 * A request body read stays open until the app has sent the whole body, across
 * several waits. Past this it is dropped, and the next read asks again.
 */
const POST_DATA_TIMEOUT_MS = 60_000;
const RESPONSE_BODY_TIMEOUT_MS = 10_000;

const STILL_SENDING = "the app is still sending this request body; read it again later";
const CONNECTION_CLOSED = "the agent's connection closed before this body was read";
const REQUEST_BODY_GONE = "the agent holds no body for this request";
const RESPONSE_BODY_GONE = "the agent no longer holds this body";
const NO_RESPONSE_BODY = "the response has no body";

export interface IosNetworkCaptureState {
  /** The app's live connection acknowledged Network.enable. */
  armed: boolean;
  /** The process of the live connection, once the host has read it. */
  pid?: number;
  /** Why the live connection is not armed yet. */
  note?: string;
}

/** What a reader of one app's iOS native records sees. */
export interface IosNetworkRecords {
  state(): IosNetworkCaptureState;
  /** The listed records, oldest first, without Metro's own traffic on `metroPort`. */
  records(metroPort: number): NativeNetworkRecord[];
  record(id: string): NativeNetworkRecord | undefined;
  /** Hides every record from the listing; ids still resolve. */
  clear(): void;
  /** The response body, read from the app once per record. Never rejects. */
  responseBody(id: string): Promise<NativeNetworkBody>;
  /**
   * The request body, read from the app once per record, or held by the host
   * when it came with the request. Waits at most 5 s for the app's answer,
   * after any body read before it on the connection, and answers "still
   * sending" while the app has not sent the whole body yet. Never rejects.
   */
  requestPostData(id: string): Promise<NativeNetworkBody>;
}

/** The app's side of the body reads, owned by the native-devtools service. */
export interface IosAgentLink {
  /** The index of the app's live connection, if it has one. */
  liveConnection(): number | undefined;
  /** Sends one CDP request on `connection`; rejects when that connection is not live. */
  request(
    connection: number,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number
  ): Promise<unknown>;
}

/** What the host learned about the app after one of its connections closed. */
export interface ClosedConnectionCheck {
  /** A newer connection of the same app exists. */
  superseded: boolean;
  /** Whether the app runs now; undefined when the host could not tell. */
  running?: boolean;
  /** The pid of the running process, when the host could read it. */
  runningPid?: number;
  /** The pid of the closed connection's process, when the host had read it. */
  connectionPid?: number;
}

export interface IosNetworkRecordStore extends IosNetworkRecords {
  /** Folds one event that came in on `connection` into its request's record. */
  fold(connection: number, method: string, params: unknown): void;
  /** The store still holds a record that came in on `connection`. */
  holdsRecordsOf(connection: number): boolean;
  /**
   * Fails the open records of a connection that closed. A connection does not
   * come back for the same process, so its open records never settle. The
   * check also decides why a body of the connection can no longer be read.
   */
  connectionClosed(connection: number, check: ClosedConnectionCheck): void;
}

/**
 * One app's records. They belong to the app, not to a connection, so a
 * reconnect and a relaunch keep the history. `state` reads the app's live
 * connection, which the native-devtools service owns.
 */
export function createIosNetworkRecords(
  state: () => IosNetworkCaptureState,
  link: IosAgentLink
): IosNetworkRecordStore {
  const records: NativeNetworkRecord[] = [];
  let recordChars = 0;
  const recordSizes = new WeakMap<NativeNetworkRecord, number>();
  const byId = new Map<string, NativeNetworkRecord>();
  /** Keyed on the connection and the request id the agent sent. */
  const byLayerId = new Map<string, NativeNetworkRecord>();
  const cleared = new WeakSet<NativeNetworkRecord>();
  const startArrivals = new WeakMap<NativeNetworkRecord, number>();
  /** A request body that came with the request: its start, and its whole length. */
  const inlineBodies = new WeakMap<NativeNetworkRecord, { text: string; chars: number }>();
  /** Bodies read or being read, keyed `kind:id`, oldest first. */
  const bodies = new Map<string, BodyRead>();
  /**
   * One body read at a time per app connection: a large body holds up the
   * other replies and events on the connection while it is sent.
   */
  const bodyReads = new Map<string, Promise<unknown>>();
  /** Closed connections whose process the host found ended. */
  const endedConnections = new Set<number>();

  const keyOf = (connection: number, layerId: string): string => `${connection}:${layerId}`;

  function startRecord(connection: number, layerId: string, p: Record<string, unknown>): void {
    const req = asObject(p.request);
    const startedAt =
      typeof p.wallTime === "number"
        ? p.wallTime * 1000
        : typeof p.timestamp === "number"
          ? p.timestamp * 1000
          : Date.now();
    const postData = typeof req.postData === "string" ? req.postData : "";
    const record: NativeNetworkRecord = {
      id: `ios-${RUN_TAG}-${nextRecordNumber++}`,
      layer: "ios-native",
      layerId,
      connection,
      state: "pending",
      request: {
        url: capString(asString(req.url)),
        method: capString(asString(req.method), 100) || "GET",
        headers: headerMap(req.headers),
        ...(req.hasPostData === true || postData.length > 0 ? { hasPostData: true } : {}),
      },
      timing: { startedAt: Math.round(startedAt) },
    };
    if (postData.length > 0) {
      inlineBodies.set(record, {
        text: postData.slice(0, MAX_VALUE_CHARS),
        chars: postData.length,
      });
    }
    byLayerId.set(keyOf(connection, layerId), record);
    startArrivals.set(record, performance.now());
    records.push(record);
    byId.set(record.id, record);
    resize(record);
  }

  /** The duration the app measured, else the time between the first and the last event. */
  function setDuration(record: NativeNetworkRecord, p: Record<string, unknown>): void {
    const measured = p.nativeDevtoolsDurationMs;
    if (typeof measured === "number" && Number.isFinite(measured) && measured >= 0) {
      record.timing.durationMs = Math.round(measured);
      return;
    }
    const arrived = startArrivals.get(record);
    if (arrived !== undefined) record.timing.durationMs = Math.round(performance.now() - arrived);
  }

  /** Re-measures a record after it grew, and evicts the oldest past either bound. */
  function resize(record: NativeNetworkRecord): void {
    if (!byId.has(record.id)) return;
    const size = recordSize(record) + (inlineBodies.get(record)?.text.length ?? 0);
    recordChars += size - (recordSizes.get(record) ?? 0);
    recordSizes.set(record, size);
    while (
      records.length > MAX_RECORDS ||
      (records.length > 1 && recordChars > RECORD_CHARS_BUDGET)
    ) {
      evict(records.shift()!);
    }
  }

  function evict(record: NativeNetworkRecord): void {
    const key = keyOf(record.connection, record.layerId);
    if (byLayerId.get(key) === record) byLayerId.delete(key);
    byId.delete(record.id);
    recordChars -= recordSizes.get(record) ?? 0;
    recordSizes.delete(record);
    bodies.delete(`response:${record.id}`);
    bodies.delete(`post:${record.id}`);
  }

  /** Why a body of a connection that is no longer live cannot be read. */
  function closedReason(connection: number): string {
    // A connection does not come back for the same process, so a newer one is a new process.
    const live = link.liveConnection();
    return endedConnections.has(connection) || (live !== undefined && live > connection)
      ? PROCESS_GONE
      : CONNECTION_CLOSED;
  }

  function readBody(id: string, kind: "response" | "post"): Promise<NativeNetworkBody> {
    const record = byId.get(id);
    if (!record) return Promise.resolve(unavailable("no such request"));
    if (kind === "post") {
      if (!record.request.hasPostData) {
        return Promise.resolve(unavailable("the request has no body"));
      }
      const inline = inlineBodies.get(record);
      if (inline) {
        return Promise.resolve({
          available: true,
          body: inline.text,
          base64Encoded: false,
          truncated: inline.text.length < inline.chars,
          inlineChars: inline.chars,
        });
      }
    } else if (record.state !== "complete") {
      // A request can also fail after its headers arrived, as when the body
      // breaks off or the app stops reading it.
      return Promise.resolve(
        unavailable(
          record.state !== "failed"
            ? "the response has not finished yet"
            : record.response
              ? "the response failed before its body finished"
              : "the request failed before a response arrived"
        )
      );
    } else if (record.encodedDataLength === 0) {
      return Promise.resolve(unavailable(NO_RESPONSE_BODY));
    }

    const cacheKey = `${kind}:${id}`;
    const cached = bodies.get(cacheKey);
    if (cached) {
      // A read moves its body to the newest end, so the bodies read last are kept.
      bodies.delete(cacheKey);
      bodies.set(cacheKey, cached);
      return shownOf(cached, kind);
    }
    if (link.liveConnection() !== record.connection) {
      return Promise.resolve(unavailable(closedReason(record.connection)));
    }

    let adoptAnswer!: (answer: Promise<NativeNetworkBody>) => void;
    const answer = new Promise<NativeNetworkBody>((resolve) => {
      adoptAnswer = resolve;
    });
    let markSent!: () => void;
    const sent = new Promise<void>((resolve) => {
      markSent = resolve;
    });
    const read: BodyRead = { sent, answer };
    bodies.set(cacheKey, read);
    while (bodies.size > MAX_CACHED_BODIES) bodies.delete(bodies.keys().next().value!);
    // Only a body is kept: every reason may change at the next read.
    void answer.then((body) => {
      if (!body.available && bodies.get(cacheKey) === read) bodies.delete(cacheKey);
    });
    void withKeyedLock(bodyReads, String(record.connection), () => {
      adoptAnswer(sendBodyRead(record, kind));
      markSent();
      // The lock is held until this read answers, or for a request body until
      // its wait ends: the next read goes out while this one may stay open.
      return kind === "post" ? withinWait(answer) : answer;
    });
    return shownOf(read, kind);
  }

  function sendBodyRead(
    record: NativeNetworkRecord,
    kind: "response" | "post"
  ): Promise<NativeNetworkBody> {
    const method = kind === "response" ? "Network.getResponseBody" : "Network.getRequestPostData";
    // A throw would leave the cached read open for good, so it answers as a rejection.
    return new Promise<unknown>((resolve) => {
      resolve(
        link.request(
          record.connection,
          method,
          { requestId: record.layerId },
          kind === "response" ? RESPONSE_BODY_TIMEOUT_MS : POST_DATA_TIMEOUT_MS
        )
      );
    }).then(
      (result) => toBody(result, kind),
      (err: unknown) => unavailable(failureReason(record, kind, method, err))
    );
  }

  function failureReason(
    record: NativeNetworkRecord,
    kind: "response" | "post",
    method: string,
    err: unknown
  ): string {
    const message = err instanceof Error ? err.message : String(err);
    switch (getFailureSignal(err)?.error_code) {
      case FAILURE_CODES.NDJSON_CDP_CONNECTION_CLOSED:
        return closedReason(record.connection);
      case FAILURE_CODES.NDJSON_CDP_REQUEST_TIMEOUT:
        if (kind === "post") return STILL_SENDING;
        break;
      case FAILURE_CODES.NDJSON_CDP_REQUEST_FAILED: {
        // The agent's own answer, after the requester's "<label>: <method> failed: ".
        const marker = `${method} failed: `;
        const at = message.indexOf(marker);
        const detail = at === -1 ? message : message.slice(at + marker.length);
        // The agent answers a body it does not hold with an error that says so.
        if (/^no /i.test(detail)) {
          return kind === "post" ? REQUEST_BODY_GONE : RESPONSE_BODY_GONE;
        }
        return `the agent did not return the body: ${detail}`;
      }
    }
    return `the agent did not return the body: ${message}`;
  }

  return {
    state,

    fold(connection, method, params) {
      if (typeof params !== "object" || params === null) return;
      const p = params as Record<string, unknown>;
      const layerId = typeof p.requestId === "string" ? p.requestId : null;
      if (!layerId || layerId.length > MAX_LAYER_ID_CHARS) return;

      if (method === "Network.requestWillBeSent") {
        // A redirect hop of a request already recorded, not a new request.
        if (p.redirectResponse !== undefined && p.redirectResponse !== null) return;
        startRecord(connection, layerId, p);
        return;
      }
      const record = byLayerId.get(keyOf(connection, layerId));
      if (!record) return;
      switch (method) {
        case "Network.responseReceived": {
          const r = asObject(p.response);
          const status = typeof r.status === "number" ? r.status : 0;
          record.state = "headers";
          record.response = {
            // The URL of the final response, after any redirects.
            url: capString(asString(r.url)) || record.request.url,
            status,
            statusText: STATUS_CODES[status] ?? "",
            headers: headerMap(r.headers),
            mimeType: capString(asString(r.mimeType)),
          };
          if (typeof p.type === "string") record.resourceType = capString(p.type, 100);
          break;
        }
        case "Network.loadingFinished":
          // A request in flight at a clear lists again once it settles, so
          // polling with clear sees it finish.
          cleared.delete(record);
          record.state = "complete";
          if (typeof p.encodedDataLength === "number")
            record.encodedDataLength = p.encodedDataLength;
          setDuration(record, p);
          break;
        case "Network.loadingFailed":
          cleared.delete(record);
          record.state = "failed";
          record.errorText = capString(asString(p.errorText)) || "Unknown error";
          setDuration(record, p);
          break;
        default:
          // Body chunks and anything else add nothing to the record.
          return;
      }
      resize(record);
    },

    holdsRecordsOf: (connection) => records.some((record) => record.connection === connection),

    connectionClosed(connection, check) {
      const ended =
        check.superseded ||
        check.running === false ||
        (check.runningPid !== undefined &&
          check.connectionPid !== undefined &&
          check.runningPid !== check.connectionPid);
      if (ended) endedConnections.add(connection);
      // Collected first: re-measuring a record can evict the oldest, which
      // would shift the array under a loop over it and skip a record.
      const open = records.filter((r) => r.connection === connection && isOpen(r));
      for (const record of open) {
        record.state = "failed";
        record.errorText = ended ? PROCESS_ENDED : NOT_RECONNECTED;
        cleared.delete(record);
      }
      for (const record of open) resize(record);
    },

    records: (port) =>
      records.filter((r) => !cleared.has(r) && !isMetroTraffic(r.request.url, port)),

    record: (id) => byId.get(id),

    clear() {
      // Also hides the records the clearing call did not return because of
      // its limit. A request in flight keeps folding its events and lists
      // again once it settles.
      for (const record of records) cleared.add(record);
    },

    responseBody: (id) => readBody(id, "response"),
    requestPostData: (id) => readBody(id, "post"),
  };
}

/** A body read: `sent` settles once its request went out, `answer` with the app's answer. */
interface BodyRead {
  sent: Promise<void>;
  answer: Promise<NativeNetworkBody>;
}

/**
 * What one caller of a body read gets: a request body waits at most 5 s from
 * when its request went out, so a read waiting behind another one on the
 * connection is not answered "still sending" before the app was asked.
 */
function shownOf(read: BodyRead, kind: "response" | "post"): Promise<NativeNetworkBody> {
  return kind === "post" ? read.sent.then(() => withinWait(read.answer)) : read.answer;
}

/**
 * A request body read as the app answers it, or "still sending" after 5 s.
 * The read itself stays open, so a later wait can still get its answer.
 */
function withinWait(answer: Promise<NativeNetworkBody>): Promise<NativeNetworkBody> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(unavailable(STILL_SENDING)), POST_DATA_WAIT_MS);
    timer.unref();
    void answer.then((body) => {
      clearTimeout(timer);
      resolve(body);
    });
  });
}

/**
 * One native-devtools service's view of its device: the apps capture is on
 * for, and the records of every app that connected. Both are live, owned by
 * the service.
 */
interface IosNetworkCaptures {
  readonly udid: string;
  readonly bundleIds: ReadonlySet<string>;
  readonly stores: ReadonlyMap<string, IosNetworkRecords>;
}

/**
 * Every native-devtools service, so a reader that knows only an `ios-…` id or
 * a device can find the records without creating a service nobody asked for.
 */
const liveCaptures = new Set<IosNetworkCaptures>();

/** Registers a service's captures until the returned function is called. */
export function registerIosNetworkCaptures(captures: IosNetworkCaptures): () => void {
  liveCaptures.add(captures);
  return () => {
    liveCaptures.delete(captures);
  };
}

/** Ids are unique per tool-server, so the device that recorded one does not matter. */
export function findIosNativeRecord(
  id: string
): { records: IosNetworkRecords; record: NativeNetworkRecord } | undefined {
  for (const captures of liveCaptures) {
    for (const records of captures.stores.values()) {
      const record = records.record(id);
      if (record) return { records, record };
    }
  }
  return undefined;
}

/**
 * Capture is on for the app and the app connected at least once. An app that
 * never connected, such as a mistyped or uninstalled bundle id, has no process
 * that capture runs in.
 */
function capturing(captures: IosNetworkCaptures, bundleId: string): boolean {
  return captures.bundleIds.has(bundleId) && captures.stores.has(bundleId);
}

/** Bundle ids with native network capture on for the device. */
export function liveIosNetworkCaptures(deviceId: string): string[] {
  const key = deviceKeyOf(deviceId);
  const bundleIds = new Set<string>();
  for (const captures of liveCaptures) {
    if (deviceKeyOf(captures.udid) !== key) continue;
    for (const bundleId of captures.bundleIds) {
      if (capturing(captures, bundleId)) bundleIds.add(bundleId);
    }
  }
  return [...bundleIds].sort();
}

/** Udids of the devices with native network capture on for the app. */
export function liveIosNetworkCaptureDevices(bundleId: string): string[] {
  const udids = [...liveCaptures]
    .filter((captures) => capturing(captures, bundleId))
    .map((captures) => captures.udid);
  return [...new Set(udids)].sort();
}
