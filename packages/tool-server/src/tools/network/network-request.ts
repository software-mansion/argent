import * as zlib from "node:zlib";
import { z } from "zod";
import type { ServiceRef, ToolDefinition } from "@argent/registry";
import { canonicalDeviceId } from "../../utils/debugger/device-alias";
import { DEBUGGER_TOOL_CAPABILITY } from "../debugger/debugger-service-ref";
import {
  jsCapture,
  jsCapturePayload,
  type NetworkInspectorApi,
} from "../../blueprints/network-inspector";
import type { JsRuntimeDebuggerApi } from "../../blueprints/js-runtime-debugger";
import type { CDPClient } from "../../utils/debugger/cdp-client";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import type { NetworkRequestRecord } from "../../chromium-server/network";
import {
  ANDROID_NATIVE_REQUEST_ID,
  findAndroidNativeRecord,
  hasAndroidNetworkCapture,
} from "../../blueprints/android-network-inspector";
import {
  IOS_NATIVE_REQUEST_ID,
  MACOS_NATIVE_REQUEST_ID,
  findIosNativeRecord,
  hasIosNetworkCapture,
} from "../../blueprints/ios-network-records";
import { findMacosNativeRecord, hasMacosNetworkCapture } from "../../blueprints/macos-app";
import type { NativeNetworkBody, NativeNetworkRecord } from "../../utils/native-network-record";
import { resolveDevice } from "../../utils/device-info";
import {
  BINARY_BODY_TYPES,
  NETWORK_INTERCEPTOR_SCRIPT,
  makeNetworkDetailReadScript,
} from "../../utils/debugger/scripts/network-interceptor";
import { metroPortField } from "../../utils/debugger/metro-port";
import type { SecretRedactor } from "../../utils/secrets";
import { networkSecretRedactor, redactNetworkResult } from "./network-secrets";
import {
  isRedirect,
  jsCaptureDebuggerRef,
  jsReadPort,
  jsCaptureForRead,
  jsNoLog,
  jsNotStarted,
  reasonPhrase,
} from "./network-logs";

const SENSITIVE_HEADER_PATTERNS = [
  "auth",
  "cookie",
  "token",
  "secret",
  "key",
  "session",
  "credential",
  "password",
  "api-key",
  "apikey",
  "x-api-key",
];

function isSensitiveHeader(name: string, value?: string): boolean {
  const lower = name.toLowerCase();
  if (SENSITIVE_HEADER_PATTERNS.some((p) => lower.includes(p))) return true;
  // whatwg-fetch sends a [name, value] pair given as headers as "0: name,value".
  return (
    /^\d+$/.test(name) && value != null && isSensitiveHeader(String(value).split(",")[0]!.trim())
  );
}

function redactHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = isSensitiveHeader(key, value) ? "[REDACTED]" : value;
  }
  return result;
}

/**
 * Every native ID starts with its layer's prefix, and so does a truncated or
 * mistyped one.
 */
const NATIVE_ID_PREFIXES = { android: "android-", ios: "ios-", macos: "macos-" } as const;
type NativePlatform = keyof typeof NATIVE_ID_PREFIXES;

function nativeIdPlatform(requestId: string): NativePlatform | undefined {
  if (requestId.startsWith(NATIVE_ID_PREFIXES.android)) return "android";
  if (requestId.startsWith(NATIVE_ID_PREFIXES.ios)) return "ios";
  if (requestId.startsWith(NATIVE_ID_PREFIXES.macos)) return "macos";
  return undefined;
}

/** Where each native layer's IDs come from, and what its records are called. */
const NATIVE_LAYERS: Record<NativePlatform, { source: string; name: string }> = {
  android: { source: "an Android device", name: "Android" },
  ios: { source: "an iOS simulator", name: "iOS" },
  macos: { source: "a Mac app", name: "Mac app" },
};

/** Body chars kept, of a request or a response; the rest is truncated to limit context. */
const MAX_BODY_SIZE = 1000;

/**
 * Bytes an encoded body of a native layer may decode to. A few hundred bytes
 * of br can decode to gigabytes, and the decode blocks the tool-server while
 * it runs.
 */
const MAX_DECODED_BODY_BYTES = 16 * 1024 * 1024;

/** Heads a body cut to `shown` chars; `fullSize` is the size of the whole body, with its unit. */
function cutMarker(fullSize: string, mimeType?: string, shown = MAX_BODY_SIZE): string {
  // A body with no MIME type, as one the app sent with no Content-Type, names none.
  const mime = mimeType ? `, MIME: ${mimeType}` : "";
  return `[TRUNCATED: first ${shown} chars shown, full size: ${fullSize}${mime}]`;
}

/**
 * The first `shown` chars of a body the preview cuts, with each secret value
 * replaced. The redaction runs on the shown text, after the cut, so a value it
 * ends inside leaves no start of it.
 */
function shownText(text: string, shown: number, redact: SecretRedactor): string {
  return redact(text.slice(0, shown), { cut: true });
}

/**
 * Every body is redacted where it is built, cut or whole, and so is the app
 * text in the notes around it (a MIME type, a Content-Encoding). The redaction
 * of the whole result skips it: a second pass would rewrite the numbers in the
 * preview's own header, such as `first 1000 chars shown`, with a short value.
 */
function truncateBody(body: string, mimeType: string, redact: SecretRedactor): string {
  return body.length > MAX_BODY_SIZE
    ? `${cutMarker(`${body.length} chars`, redact(mimeType))}\n${shownText(body, MAX_BODY_SIZE, redact)}...`
    : redact(body);
}

/**
 * The response body Chrome holds for a request. Chrome keeps no body for a fetch()
 * whose no-store response the page has not read to its end, though every byte of it
 * may have arrived and the recorder counts it finished. It still has those bytes
 * buffered and hands them over through Network.streamResourceContent.
 */
async function chromiumResponseBody(
  cdp: Pick<CDPClient, "send">,
  rec: NetworkRequestRecord
): Promise<{ body: string; base64Encoded: boolean } | undefined> {
  try {
    const out = (await cdp.send("Network.getResponseBody", { requestId: rec.requestId })) as {
      body?: string;
      base64Encoded?: boolean;
    };
    if (out.body != null) return { body: out.body, base64Encoded: out.base64Encoded === true };
  } catch {
    // Body not retained: navigated away, evicted, never had one, or not read yet.
  }
  // A body still arriving would come back cut short.
  if (!rec.finished || rec.failed) return undefined;
  try {
    const out = (await cdp.send("Network.streamResourceContent", {
      requestId: rec.requestId,
    })) as { bufferedData?: string };
    if (out.bufferedData != null) return { body: out.bufferedData, base64Encoded: true };
  } catch {
    // The request ended in Chrome already, or this Chrome has no such command.
  }
  return undefined;
}

/** The text of a body that CDP sent as base64, or its bytes when they are not UTF-8 text. */
function utf8Text(bytes: Buffer): string | Buffer {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return bytes;
  }
}

/** A request body cut to MAX_BODY_SIZE; `truncated` says the interceptor kept only its start. */
function truncatePostData(
  postData: string | undefined,
  truncated: boolean | undefined,
  redact: SecretRedactor
): string | undefined {
  // A body the interceptor cut is always longer than MAX_BODY_SIZE.
  if (postData == null) return postData;
  if (postData.length <= MAX_BODY_SIZE) return redact(postData);
  const fullSize = truncated ? `more than ${postData.length} chars` : `${postData.length} chars`;
  return `${cutMarker(fullSize)}\n${shownText(postData, MAX_BODY_SIZE, redact)}...`;
}

interface RawEntry {
  id: number;
  requestId: string;
  state: string;
  request?: {
    url: string;
    method: string;
    headers: Record<string, string>;
    postData?: string;
    /** The interceptor kept only the start of the body. */
    postDataTruncated?: boolean;
  };
  response?: {
    url: string;
    status: number;
    statusText: string;
    headers: Record<string, string>;
    mimeType: string;
  };
  resourceType?: string;
  encodedDataLength?: number;
  timestamp?: number;
  durationMs?: number;
  errorText?: string;
  responseBody?: string;
  /** The interceptor kept only the start of the body; encodedDataLength is its full size. */
  bodyTruncated?: boolean;
  /** The full length, in characters, of a text body the interceptor cut. */
  bodyLength?: number;
  /** A binary body the interceptor did not read; encodedDataLength is its size. */
  bodyOmitted?: boolean;
}

interface NetworkRequestDetails {
  requestId: string;
  state: string;
  resourceType?: string;
  durationMs?: number;
  encodedDataLength?: number;
  request?: {
    url: string;
    method: string;
    headers: Record<string, string>;
    /** Native layers: says what `headers` holds when it is not what went on the wire. */
    headersNote?: string;
    postData?: string;
  };
  /** Android native layer: the hops before the final response, oldest first. */
  redirects?: Array<{
    url: string;
    method: string;
    status: number;
    statusText: string;
    /** The headers sent on the wire with this hop, when the agent reported them. */
    requestHeaders?: Record<string, string>;
    /** The headers of this hop's response, such as Location; absent when it had none. */
    responseHeaders?: Record<string, string>;
  }>;
  response?: {
    /** Native layers: the final URL, after any redirects. */
    url?: string;
    status: number;
    statusText: string;
    /** The final URL, when a redirect led away from the request URL. */
    redirectedTo?: string;
    headers: Record<string, string>;
    mimeType: string;
    fromCache?: boolean;
    body?: string;
  };
  errorText?: string;
  initiator?: { type: string; url?: string; lineNumber?: number };
}

const zodSchema = z.object({
  port: metroPortField,
  device_id: z
    .string()
    .describe(
      "Device ID for the log (or `logicalDeviceId` if JS capture used it)<flag:macos-apps>; Mac app: Mac app id</flag:macos-apps>."
    ),
  requestId: z
    .string()
    .describe(
      "Request ID from `view-network-logs`, `native-network-logs`, or `await-network-request`."
    ),
  includeBody: z.boolean().default(true).describe("Include response body (default true)."),
});

export const networkRequestTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  NetworkRequestDetails | string
> = {
  id: "view-network-request-details",
  description: `Read full details (status, timing, redacted headers, and bodies truncated to 1000 chars) for one captured HTTP request ID. Secret values exposed to Argent show as their {{secret:NAME}} placeholders; other credentials do not.
Use when inspecting payloads or headers of a request from a network log or \`await-network-request\`.
Returns request/response details, or a not-found message (refresh the log after JS reloads). Fails if the backing debugger/CDP target is unreachable.`,
  zodSchema,
  readOnly: true,
  interaction: {
    startedMsg: ({ params }) => `Reading network request ${params.requestId}`,
    completedMsg: ({ params }) => `Read network request ${params.requestId}`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to read network request ${params.requestId}: ${failureSignal.error_code}`,
  },
  capability: { ...DEBUGGER_TOOL_CAPABILITY, macos: { app: true, catalyst: true } },
  services: (params): Record<string, ServiceRef> => {
    /**
     * A native ID names its record without the device, so it
     * resolves whatever spelling of the device the caller passes: a Metro
     * logicalDeviceId from a shared Metro, an ext: id, or one that classifies
     * as another platform, Chromium included. It needs no debugger either.
     * A Chromium request ID never has this shape.
     */
    if (isNativeRequestId(params.requestId)) return {};
    const device = resolveDevice(params.device_id);
    if (device.platform === "chromium") {
      return { chromium: chromiumCdpRef(device) };
    }
    /**
     * A native ID prefix in any other shape was not issued by a native
     * layer, and the JS layer names its requests rn-net-<n>. No layer can hold
     * it, so saying that needs no debugger. Chromium's IDs are opaque, so
     * Chromium, above, still gets to answer for itself.
     */
    if (nativeIdPlatform(params.requestId)) return {};
    const payload = jsCapturePayload(jsReadPort(params), canonicalDeviceId(params.device_id)!);
    // JS capture starts on read for Vega, which network-capture-start does not cover.
    if (device.platform === "vega") return { inspector: `NetworkInspector:${payload}` };
    // A read never starts capture: before a start it reaches nothing in the app.
    const capture = jsCapture(payload);
    return capture ? { debugger: jsCaptureDebuggerRef(params, capture) } : {};
  },
  async execute(services, params, ctx) {
    const redact = networkSecretRedactor(ctx);
    const details = await readDetails(services, params, redact);
    // A string is argent's own message, which quotes no app data.
    if (typeof details === "string") return details;
    // Argent's own id and state, which a short secret value must not break.
    return redactNetworkResult(details, redact, [
      "requestId",
      "state",
      "request.postData",
      "response.body",
    ]);
  },
};

async function readDetails(
  services: Record<string, unknown>,
  params: z.infer<typeof zodSchema>,
  redact: SecretRedactor
): Promise<NetworkRequestDetails | string> {
  if (ANDROID_NATIVE_REQUEST_ID.test(params.requestId)) {
    const found = findAndroidNativeRecord(params.requestId);
    return found
      ? nativeRequestDetails(found.record, found.inspector, params.includeBody, redact)
      : nativeNotFound(params.requestId, params.device_id, "android");
  }
  if (IOS_NATIVE_REQUEST_ID.test(params.requestId)) {
    const found = findIosNativeRecord(params.requestId);
    return found
      ? nativeRequestDetails(found.record, found.records, params.includeBody, redact)
      : nativeNotFound(params.requestId, params.device_id, "ios");
  }
  if (MACOS_NATIVE_REQUEST_ID.test(params.requestId)) {
    const found = findMacosNativeRecord(params.requestId);
    return found
      ? nativeRequestDetails(found.record, found.records, params.includeBody, redact)
      : nativeNotFound(params.requestId, params.device_id, "macos");
  }

  const device = resolveDevice(params.device_id);
  if (device.platform === "chromium") {
    const chromium = services.chromium as ChromiumCdpApi;
    const rec = chromium.server.network.get(params.requestId);
    if (!rec) {
      return `Request ${params.requestId} not found. Use view-network-logs to list available requests.`;
    }
    const details: NetworkRequestDetails = {
      requestId: rec.requestId,
      state: rec.failed ? "failed" : rec.status != null ? "complete" : "pending",
      resourceType: rec.resourceType,
      durationMs: rec.durationMs != null ? Math.round(rec.durationMs) : undefined,
      encodedDataLength: rec.encodedDataLength,
      errorText: rec.errorText,
      initiator: rec.initiator,
    };
    if (rec.url) {
      details.request = {
        url: rec.url,
        method: rec.method,
        headers: redactHeaders(rec.requestHeaders),
        postData: truncatePostData(rec.postData, false, redact),
      };
    }
    if (rec.status != null) {
      const resp: NetworkRequestDetails["response"] = {
        status: rec.status,
        statusText: rec.statusText ?? "",
        headers: redactHeaders(rec.responseHeaders),
        mimeType: rec.mimeType ?? "",
      };
      if (params.includeBody) {
        const out = await chromiumResponseBody(chromium.cdp, rec);
        if (out) {
          const body = out.base64Encoded ? utf8Text(Buffer.from(out.body, "base64")) : out.body;
          if (typeof body !== "string") {
            resp.body = `[body omitted: binary ${redact(resp.mimeType) || "data"}, ${body.length} bytes]`;
          } else {
            resp.body = truncateBody(body, resp.mimeType, redact);
          }
        }
      }
      details.response = resp;
    }
    return details;
  }

  const nativePlatform = nativeIdPlatform(params.requestId);
  if (nativePlatform) return nativeNotFound(params.requestId, params.device_id, nativePlatform);

  let cdp: CDPClient;
  let noLog: string | undefined;
  if (device.platform === "vega") {
    const api = services.inspector as NetworkInspectorApi;
    // Idempotent: the script no-ops if already installed.
    await api.cdp.evaluate(NETWORK_INTERCEPTOR_SCRIPT).catch(() => {});
    cdp = api.cdp;
  } else {
    const port = jsReadPort(params);
    const deviceId = canonicalDeviceId(params.device_id)!;
    const dbg = services.debugger as JsRuntimeDebuggerApi | undefined;
    const capture = dbg && jsCaptureForRead(jsCapturePayload(port, deviceId), dbg.runtimeApp);
    if (!dbg || !capture) {
      return jsNotStarted(
        deviceId,
        port,
        "list the requests with view-network-logs",
        `Request ${params.requestId} not found. `
      );
    }
    cdp = dbg.cdp;
    noLog = `Request ${params.requestId} not found. ${jsNoLog(capture)}`;
  }

  const script = makeNetworkDetailReadScript(params.requestId);
  const raw = await cdp.evaluate(script);
  const data = JSON.parse(raw as string) as RawEntry | { error: string; installed?: false };

  if ("error" in data) {
    if (data.installed === false && noLog) return noLog;
    return `${data.error}. Use view-network-logs to list available requests.`;
  }

  const entry = data as RawEntry;

  const details: NetworkRequestDetails = {
    requestId: entry.requestId,
    state: entry.state,
    resourceType: entry.resourceType,
    durationMs: entry.durationMs,
    encodedDataLength: entry.encodedDataLength,
    errorText: entry.errorText,
  };

  if (entry.request) {
    details.request = {
      url: entry.request.url,
      method: entry.request.method,
      headers: redactHeaders(entry.request.headers),
      postData: truncatePostData(entry.request.postData, entry.request.postDataTruncated, redact),
    };
  }

  if (entry.response) {
    const resp: NetworkRequestDetails["response"] = {
      status: entry.response.status,
      statusText: reasonPhrase(entry.response.status),
      headers: redactHeaders(entry.response.headers),
      mimeType: entry.response.mimeType,
    };
    if (isRedirect(entry.request?.url, entry.response.url)) {
      resp.redirectedTo = entry.response.url;
    }

    if (params.includeBody && entry.bodyOmitted) {
      // A length in characters, of a binary body read as text, is close to its size in bytes.
      const size =
        entry.encodedDataLength != null
          ? `, ${entry.encodedDataLength} bytes`
          : entry.bodyLength != null
            ? `, ~${entry.bodyLength} bytes`
            : "";
      resp.body = `[body omitted: binary ${redact(entry.response.mimeType) || "data"}${size}]`;
    } else if (params.includeBody && entry.responseBody != null) {
      const body = entry.responseBody;
      if (body.length > MAX_BODY_SIZE) {
        const fullSize = !entry.bodyTruncated
          ? `${body.length} chars`
          : entry.encodedDataLength != null
            ? `${entry.encodedDataLength} bytes`
            : entry.bodyLength != null
              ? `${entry.bodyLength} chars`
              : `more than ${body.length} chars`;
        resp.body = `${cutMarker(fullSize, redact(entry.response.mimeType))}\n${shownText(body, MAX_BODY_SIZE, redact)}...`;
      } else {
        resp.body = redact(body);
      }
    }

    details.response = resp;
  }

  return details;
}

function isNativeRequestId(requestId: string): boolean {
  return (
    ANDROID_NATIVE_REQUEST_ID.test(requestId) ||
    IOS_NATIVE_REQUEST_ID.test(requestId) ||
    MACOS_NATIVE_REQUEST_ID.test(requestId)
  );
}

/**
 * The answer to a native ID no layer holds names a tool the caller's device
 * can list with: native-network-logs refuses Chromium and Vega, and on a Mac
 * app it lists only that app's macos- IDs. There it also says where the ID
 * came from, because view-network-logs never lists one. A
 * device ID of another platform keeps the native hint: it can be the
 * logicalDeviceId of a device on a shared Metro, and native-network-logs
 * accepts it.
 */
function nativeNotFound(requestId: string, deviceId: string, layer: NativePlatform): string {
  const { platform } = resolveDevice(deviceId);
  const prefix = NATIVE_ID_PREFIXES[layer];
  const { source, name } = NATIVE_LAYERS[layer];
  if (platform === "chromium" || platform === "vega") {
    return `Request ${requestId} not found. ${layer === "macos" ? "A" : "An"} ${prefix} ID comes from ${source}. Use view-network-logs to list this device's requests.`;
  }
  // A Mac app's native layer lists macos- IDs only: an ios- or android- ID is another device's.
  if (platform === "macos" && layer !== "macos") {
    return `Request ${requestId} not found. An ${prefix} ID comes from ${source}. Use native-network-logs or view-network-logs to list this Mac app's requests.`;
  }
  const captured =
    layer === "android"
      ? hasAndroidNetworkCapture()
      : layer === "ios"
        ? hasIosNetworkCapture()
        : hasMacosNetworkCapture();
  return captured
    ? `Request ${requestId} not found. Use native-network-logs to list the requests the ${name} native layer recorded.`
    : `Request ${requestId} not found. Native network capture is not started, so no requests are recorded. Call network-capture-start with udid and bundleId, repeat the action, then list the requests with native-network-logs.`;
}

/** The body reads of a native layer's store. */
interface NativeBodies {
  responseBody(id: string): Promise<NativeNetworkBody>;
  requestPostData(id: string): Promise<NativeNetworkBody>;
}

async function nativeRequestDetails(
  record: NativeNetworkRecord,
  bodies: NativeBodies,
  includeBody: boolean,
  redact: SecretRedactor
): Promise<NetworkRequestDetails> {
  const { wireHeaders } = record.request;
  /**
   * The body's headers come from the hop that carried it: the first one. A
   * 301, 302 or 303 follow-up is a GET without them. The wire headers carry
   * what the app's code may have left out, such as a Content-Type.
   */
  const bodyHeaders = record.redirects?.[0]?.requestHeaders ?? wireHeaders ?? {};
  const requestHeader = (name: string): string =>
    headerValue(bodyHeaders, name) || headerValue(record.request.headers, name);

  const request: NonNullable<NetworkRequestDetails["request"]> = {
    url: record.request.url,
    method: record.request.method,
    headers: redactHeaders(wireHeaders ?? record.request.headers),
  };
  const headersNote = requestHeadersNote(record);
  if (headersNote) request.headersNote = headersNote;
  if (record.request.hasPostData) {
    request.postData = await readNativeBody(
      () => bodies.requestPostData(record.id),
      {
        contentType: requestHeader("content-type"),
        contentEncoding: requestHeader("content-encoding"),
        wholeSize: sizeInBytes(
          Number(requestHeader("content-length") || NaN),
          "as the app sent them"
        ),
      },
      redact
    );
  }

  const details: NetworkRequestDetails = {
    requestId: record.id,
    state: record.state,
    resourceType: record.resourceType,
    durationMs: record.timing.durationMs,
    encodedDataLength: record.encodedDataLength,
    errorText: record.errorText,
    request,
  };

  if (record.redirects?.length) {
    details.redirects = record.redirects.map((hop) => ({
      url: hop.url,
      method: hop.method,
      status: hop.status,
      statusText: hop.statusText,
      ...(hop.requestHeaders ? { requestHeaders: redactHeaders(hop.requestHeaders) } : {}),
      ...(Object.keys(hop.headers).length > 0
        ? { responseHeaders: redactHeaders(hop.headers) }
        : {}),
    }));
  }

  if (record.response) {
    const resp: NetworkRequestDetails["response"] = {
      url: record.response.url,
      status: record.response.status,
      statusText: record.response.statusText,
      headers: redactHeaders(record.response.headers),
      mimeType: record.response.mimeType,
    };
    if (record.response.fromCache) resp.fromCache = true;
    if (includeBody) {
      resp.body = await readNativeBody(
        () => bodies.responseBody(record.id),
        {
          mimeType: record.response.mimeType,
          contentType: headerValue(record.response.headers, "content-type"),
          // An iOS or Mac app response body is read decoded, so its Content-Encoding is not applied again.
          contentEncoding:
            record.layer === "ios-native" || record.layer === "macos-native"
              ? ""
              : headerValue(record.response.headers, "content-encoding"),
          wholeSize: sizeInBytes(record.encodedDataLength ?? NaN, "as the app received them"),
        },
        redact
      );
    }
    details.response = resp;
  }

  return details;
}

/**
 * Says what the request headers are when they are not simply what went on
 * the wire: without that, an absent Cookie or User-Agent reads as "not sent".
 */
function requestHeadersNote(record: NativeNetworkRecord): string | undefined {
  if (record.request.wireHeaders) {
    return record.redirects?.length
      ? "url and method are those of the request the app made. These headers were sent on the wire with the last request, to the final URL, after the hops in redirects."
      : undefined;
  }
  if (record.response?.fromCache) {
    return "These are the headers the app set. The response came from the cache, so no request went on the wire.";
  }
  return "These are the headers the app set. The headers sent on the wire (such as Cookie and User-Agent) were not reported for this request.";
}

interface NativeBodyFraming {
  /** The MIME type shown; defaults to the type in `contentType`. */
  mimeType?: string;
  /** The body's Content-Type header, which may name a charset. */
  contentType: string;
  contentEncoding: string;
  /**
   * The whole body's size, shown when the agent kept only its start, and when
   * an inline body is omitted as binary.
   */
  wholeSize?: string;
}

async function readNativeBody(
  read: () => Promise<NativeNetworkBody>,
  framing: NativeBodyFraming,
  redact: SecretRedactor
): Promise<string> {
  const mimeType = framing.mimeType ?? framing.contentType.split(";")[0]!.trim();
  let body: NativeNetworkBody;
  try {
    body = await read();
  } catch (err) {
    return `[unavailable: ${redact(err instanceof Error ? err.message : String(err))}]`;
  }
  if (!body.available) return `[unavailable: ${redact(body.reason ?? "no body")}]`;
  // A request body that the upload cut has no known whole size.
  if (body.incomplete) framing = { ...framing, wholeSize: undefined };
  if (body.inlineChars !== undefined) {
    return inlineBody(body.body, body.inlineChars, body.truncated, mimeType, framing, redact);
  }
  const asSent = (): string => {
    const text = inDeclaredCharset(body.body, framing.contentType, body.truncated);
    return body.truncated
      ? cutByAgent(text, mimeType, Buffer.byteLength(body.body), framing, redact, body.incomplete)
      : truncateBody(text, mimeType, redact);
  };
  // A text body with no Content-Encoding reads as it came, with no copy of its bytes.
  if (!body.base64Encoded && contentCodings(framing.contentEncoding).length === 0) return asSent();
  // A body sent as text has the body's own bytes as UTF-8, so its Content-Encoding applies to them.
  const kept = Buffer.from(body.body, body.base64Encoded ? "base64" : "utf8");
  const bytes = decodeContent(kept, framing.contentEncoding, body.truncated);
  if (!bytes) return decodesTooLarge(framing, redact);
  if (!body.base64Encoded && bytes === kept) return asSent();
  const text = decodeText(bytes, charsetOf(framing.contentType), body.truncated);
  if (text === null) {
    return body.truncated
      ? `[body omitted: binary ${redact(mimeType) || "data"}, ${framing.wholeSize ?? "size unknown"}; ${agentKept(kept.length, body.incomplete)}]`
      : `[body omitted: binary ${redact(mimeType) || "data"}, ${bytes.length} bytes]`;
  }
  return body.truncated
    ? cutByAgent(text, mimeType, kept.length, framing, redact, body.incomplete)
    : truncateBody(text, mimeType, redact);
}

/**
 * A body the agent sent as text, because its bytes are valid UTF-8. UTF-16
 * bytes with no BOM often are. Its UTF-8 bytes are the body's own, so they
 * decode in the declared charset, as the bytes of a base64 body do.
 */
function inDeclaredCharset(text: string, contentType: string, truncated: boolean): string {
  if (namesUtf8(contentType)) return text;
  return decodeText(Buffer.from(text, "utf8"), charsetOf(contentType), truncated) ?? text;
}

/** A Content-Type that names no charset, or UTF-8: a text body reads as the agent sent it. */
function namesUtf8(contentType: string): boolean {
  const charset = charsetOf(contentType);
  return !charset || /^utf-?8$/i.test(charset);
}

/**
 * A request body that came with the request, which the host holds. The agent
 * sends a body this way only when it is UTF-8 text, so a body of a binary type
 * is omitted by its type. Its bytes decode in the declared charset, as those of
 * a body the agent gives by a read do. `truncated` says the host kept only the
 * start of the body, which is `wholeChars` long when read as UTF-8.
 */
function inlineBody(
  text: string,
  wholeChars: number,
  truncated: boolean,
  mimeType: string,
  framing: NativeBodyFraming,
  redact: SecretRedactor
): string {
  if (BINARY_BODY_TYPES.test(mimeType.toLowerCase())) {
    return `[body omitted: binary ${redact(mimeType)}, ${framing.wholeSize ?? "size unknown"}]`;
  }
  // A body with no Content-Encoding reads as it came, with no copy of its bytes.
  const sent = contentCodings(framing.contentEncoding).length ? Buffer.from(text, "utf8") : null;
  const bytes = sent && decodeContent(sent, framing.contentEncoding, truncated);
  if (sent && !bytes) return decodesTooLarge(framing, redact);
  const encoded = bytes && bytes !== sent ? bytes : null;
  const decoded = encoded
    ? decodeText(encoded, charsetOf(framing.contentType), truncated)
    : inDeclaredCharset(text, framing.contentType, truncated);
  if (decoded === null) {
    const size = truncated ? (framing.wholeSize ?? "size unknown") : `${encoded!.length} bytes`;
    return `[body omitted: binary ${redact(mimeType) || "data"}, ${size}]`;
  }
  if (!truncated) return truncateBody(decoded, mimeType, redact);
  // In another charset, or under a Content-Encoding, the whole body has more chars than its kept start.
  const fullSize =
    !encoded && namesUtf8(framing.contentType)
      ? `${wholeChars} chars`
      : `more than ${decoded.length} chars`;
  const shown = Math.min(decoded.length, MAX_BODY_SIZE);
  // The host kept only the start, so the text ends at a cut even when all of it shows.
  return `${cutMarker(fullSize, redact(mimeType), shown)}\n${shownText(decoded, shown, redact)}${decoded.length > shown ? "..." : ""}`;
}

function decodesTooLarge(framing: NativeBodyFraming, redact: SecretRedactor): string {
  return `[unavailable: the ${redact(framing.contentEncoding.trim())} body decodes to more than ${MAX_DECODED_BODY_BYTES / (1024 * 1024)} MiB]`;
}

/**
 * A body the agent cut short, or a request body that the upload cut: its own
 * length is the cut's, so the size shown is the whole body's, in bytes, when
 * the record knows it.
 */
function cutByAgent(
  text: string,
  mimeType: string,
  keptBytes: number,
  framing: NativeBodyFraming,
  redact: SecretRedactor,
  incomplete?: boolean
): string {
  const shown = Math.min(text.length, MAX_BODY_SIZE);
  const fullSize = `${framing.wholeSize ?? "unknown"}; ${agentKept(keptBytes, incomplete)}`;
  // The agent kept only the start, so the text ends at a cut even when all of it shows.
  return `${cutMarker(fullSize, redact(mimeType), shown)}\n${shownText(text, shown, redact)}${text.length > shown ? "..." : ""}`;
}

function agentKept(keptBytes: number, incomplete?: boolean): string {
  return incomplete
    ? `the upload ended after the first ${keptBytes} bytes, before the app's body stream reached its end`
    : `the agent kept only the first ${keptBytes} bytes`;
}

function sizeInBytes(bytes: number, how: string): string | undefined {
  return Number.isSafeInteger(bytes) && bytes > 0 ? `${bytes} bytes ${how}` : undefined;
}

/**
 * Decodes a body by its Content-Encoding. The codings are listed in the order
 * they were applied, so they come off last first. A body that does not decode
 * reads as it came; `null` means it decodes to more than the cap.
 */
function decodeContent(bytes: Buffer, contentEncoding: string, truncated = false): Buffer | null {
  let decoded = bytes;
  for (const coding of contentCodings(contentEncoding).reverse()) {
    const next = decodeOne(decoded, coding, truncated);
    if (next === null) return null;
    if (next === undefined) return bytes;
    decoded = next;
  }
  return decoded;
}

/** The codings a Content-Encoding names, in the order they were applied. */
function contentCodings(contentEncoding: string): string[] {
  return contentEncoding
    .split(",")
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding !== "" && coding !== "identity");
}

function decodeOne(bytes: Buffer, coding: string, truncated: boolean): Buffer | null | undefined {
  const maxOutputLength = MAX_DECODED_BODY_BYTES;
  /**
   * A body the agent cut short ends mid-stream. Flushing instead of finishing
   * decodes what is there rather than failing on the missing end.
   */
  const flush = (mode: number) => (truncated ? { finishFlush: mode } : {});
  try {
    let out: Buffer;
    switch (coding) {
      case "gzip":
        out = zlib.gunzipSync(bytes, { maxOutputLength, ...flush(zlib.constants.Z_SYNC_FLUSH) });
        break;
      case "br":
        out = zlib.brotliDecompressSync(bytes, {
          maxOutputLength,
          ...flush(zlib.constants.BROTLI_OPERATION_FLUSH),
        });
        break;
      case "zstd":
        // Node 22.15 and 23.8 added zstd; npm installs past `engines` on older Node.
        if (typeof zlib.zstdDecompressSync !== "function") return undefined;
        out = zlib.zstdDecompressSync(bytes, {
          maxOutputLength,
          ...flush(zlib.constants.ZSTD_e_flush),
        });
        break;
      default:
        return undefined;
    }
    // A cut too early to hold one whole block decodes to nothing.
    return truncated && out.length === 0 && bytes.length > 0 ? undefined : out;
  } catch (err) {
    return (err as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE" ? null : undefined;
  }
}

/**
 * Strict decode in the charset the Content-Type names, then in UTF-8: a label
 * Node does not know (`utf_8`, `latin-1`) or bytes that are not that charset
 * still read as text when they are UTF-8. `null` when neither decodes.
 * A body the agent cut short may end inside a multi-byte character: decoding
 * it as a stream leaves only that incomplete character out, and still fails
 * on any invalid byte.
 */
function decodeText(bytes: Buffer, charset: string, truncated: boolean): string | null {
  for (const label of new Set([charset.toLowerCase() || "utf-8", "utf-8"])) {
    try {
      const decoder = new TextDecoder(label, { fatal: true });
      if (decoder.encoding === "windows-1252") return decodeWindows1252(bytes);
      return decoder.decode(bytes, { stream: truncated });
    } catch {
      // An unknown label, or bytes that are not this charset: try UTF-8.
    }
  }
  return null;
}

/** windows-1252's characters for bytes 0x80-0x9F; every other byte is its ISO-8859-1 code point. */
const WINDOWS_1252_C1 =
  "\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178";

/**
 * windows-1252, which `latin1`, `iso-8859-1` and `us-ascii` also name.
 * TextDecoder decodes it as ISO-8859-1 in several Node releases the tool-server
 * runs on, 24.9.0 among them, so 0x80-0x9F would come out as control
 * characters instead of quotes, dashes and the euro sign. Remove
 * this only once every Node in the engines range passes
 * `new TextDecoder("windows-1252").decode(Buffer.of(0x80)) === "€"`.
 */
function decodeWindows1252(bytes: Buffer): string {
  return bytes
    .toString("latin1")
    .replace(/[\x80-\x9f]/g, (c) => WINDOWS_1252_C1[c.charCodeAt(0) - 0x80]!);
}

function charsetOf(contentType: string): string {
  for (const param of contentType.split(";").slice(1)) {
    const eq = param.indexOf("=");
    if (eq !== -1 && param.slice(0, eq).trim().toLowerCase() === "charset") {
      return param
        .slice(eq + 1)
        .trim()
        .replace(/^(["'])(.*)\1$/, "$2")
        .trim();
    }
  }
  return "";
}

function headerValue(headers: Record<string, string>, wanted: string): string {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === wanted) return value;
  }
  return "";
}
