import * as zlib from "node:zlib";
import { z } from "zod";
import type { ServiceRef, ToolDefinition } from "@argent/registry";
import { canonicalDeviceId } from "../../utils/debugger/device-alias";
import { DEBUGGER_TOOL_CAPABILITY } from "../debugger/debugger-service-ref";
import type { NetworkInspectorApi } from "../../blueprints/network-inspector";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import {
  ANDROID_NATIVE_REQUEST_ID,
  findAndroidNativeRecord,
  type AndroidNativeRecord,
  type AndroidNetworkBody,
} from "../../blueprints/android-network-inspector";
import { resolveDevice } from "../../utils/device-info";
import {
  NETWORK_INTERCEPTOR_SCRIPT,
  makeNetworkDetailReadScript,
} from "../../utils/debugger/scripts/network-interceptor";
import { metroPort, metroPortField } from "../../utils/debugger/metro-port";

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

function isSensitiveHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return SENSITIVE_HEADER_PATTERNS.some((p) => lower.includes(p));
}

function redactHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = isSensitiveHeader(key) ? "[REDACTED]" : value;
  }
  return result;
}

/** Response body chars kept; the rest is truncated to limit context. */
const MAX_BODY_SIZE = 1000;

/**
 * Bytes an encoded body of the Android native layer may decode to. A few
 * hundred bytes of br can decode to gigabytes, and the decode blocks the
 * tool-server while it runs.
 */
const MAX_DECODED_BODY_BYTES = 16 * 1024 * 1024;

function truncateBody(body: string, mimeType: string): string {
  return body.length > MAX_BODY_SIZE
    ? `[TRUNCATED — original size: ${body.length} chars, MIME: ${mimeType}]\n${body.slice(0, MAX_BODY_SIZE)}...`
    : body;
}

const zodSchema = z.object({
  port: metroPortField,
  device_id: z
    .string()
    .describe(
      "Device id from list-devices (iOS simulator UDID or Android serial), the same id used with debugger-connect. For an ID starting with android- (from native-network-logs), any id of that device works and no debugger connection is needed."
    ),
  requestId: z
    .string()
    .describe(
      "The requestId to get full details for: an ID from view-network-logs, or on Android an ID starting with android- from native-network-logs"
    ),
  includeBody: z.coerce
    .boolean()
    .default(true)
    .describe("Whether to include the response body (if captured). Defaults to true."),
});

interface RawEntry {
  id: number;
  requestId: string;
  state: string;
  request?: {
    url: string;
    method: string;
    headers: Record<string, string>;
    postData?: string;
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
  wallTime?: number;
  durationMs?: number;
  errorText?: string;
  initiator?: { type: string; url?: string; lineNumber?: number };
  responseBody?: string;
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
    /** Android native layer: says what `headers` holds when it is not what went on the wire. */
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
    /** Android native layer: the final URL, after any redirects. */
    url?: string;
    status: number;
    statusText: string;
    headers: Record<string, string>;
    mimeType: string;
    fromCache?: boolean;
    body?: string;
  };
  errorText?: string;
  initiator?: { type: string; url?: string; lineNumber?: number };
}

export const networkRequestTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  NetworkRequestDetails | string
> = {
  id: "view-network-request-details",
  interaction: {
    startedMsg: ({ params }) => `Reading network request ${params.requestId}`,
    completedMsg: ({ params }) => `Read network request ${params.requestId}`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to read network request ${params.requestId}: ${failureSignal.error_code}`,
  },
  description: `Get full details of a specific network request by its requestId.
IDs come from view-network-logs, or on Android from native-network-logs (IDs starting with android-). An android- ID needs no debugger connection and works with any device_id of that device. Its details also include the request body, the final URL and any redirects.
On iOS, native-network-logs returns each event in full, and this tool does not read those events.
Returns request/response headers (sensitive headers redacted), status, timing, and optionally the response body.
Large response bodies are truncated. Use when you need headers, body, or timing for a specific request after listing logs.
If the requestId is not found, list the requests again with view-network-logs, or native-network-logs for an android- ID.`,
  zodSchema,
  capability: DEBUGGER_TOOL_CAPABILITY,
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.device_id);
    if (device.platform === "chromium") {
      return { chromium: chromiumCdpRef(device) };
    }
    /**
     * An android- ID names its record without the device, so it resolves
     * whatever spelling of the device the caller passes: a Metro
     * logicalDeviceId from a shared Metro, an ext: id, or one that classifies
     * as another platform. It needs no debugger either.
     */
    if (ANDROID_NATIVE_REQUEST_ID.test(params.requestId)) return {};
    return {
      inspector: `NetworkInspector:${metroPort(params)}:${canonicalDeviceId(params.device_id)}`,
    };
  },
  async execute(services, params) {
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
          postData: rec.postData,
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
          try {
            const out = (await chromium.cdp.send("Network.getResponseBody", {
              requestId: rec.requestId,
            })) as { body?: string; base64Encoded?: boolean };
            if (out.body != null) {
              const body = out.base64Encoded
                ? Buffer.from(out.body, "base64").toString("utf8")
                : out.body;
              resp.body = truncateBody(body, resp.mimeType);
            }
          } catch {
            // Body not retained: navigated away, evicted, or never had one.
          }
        }
        details.response = resp;
      }
      return details;
    }

    if (ANDROID_NATIVE_REQUEST_ID.test(params.requestId)) {
      return androidNativeRequestDetails(params.requestId, params.includeBody);
    }

    const api = services.inspector as NetworkInspectorApi;

    // Idempotent — the script no-ops if already installed.
    await api.cdp.evaluate(NETWORK_INTERCEPTOR_SCRIPT).catch(() => {});

    const script = makeNetworkDetailReadScript(params.requestId);
    const raw = await api.cdp.evaluate(script);
    const data = JSON.parse(raw as string) as RawEntry | { error: string };

    if ("error" in data) {
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
      initiator: entry.initiator,
    };

    if (entry.request) {
      details.request = {
        url: entry.request.url,
        method: entry.request.method,
        headers: redactHeaders(entry.request.headers),
        postData: entry.request.postData,
      };
    }

    if (entry.response) {
      const resp: NetworkRequestDetails["response"] = {
        status: entry.response.status,
        statusText: entry.response.statusText,
        headers: redactHeaders(entry.response.headers),
        mimeType: entry.response.mimeType,
      };

      if (params.includeBody && entry.responseBody != null) {
        resp.body = truncateBody(entry.responseBody, entry.response.mimeType);
      }

      details.response = resp;
    }

    return details;
  },
};

async function androidNativeRequestDetails(
  requestId: string,
  includeBody: boolean
): Promise<NetworkRequestDetails | string> {
  const found = findAndroidNativeRecord(requestId);
  if (!found) {
    return `Request ${requestId} not found. Use native-network-logs to list the requests the Android native layer recorded.`;
  }
  const { inspector, record } = found;
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
    request.postData = await readAndroidBody(() => inspector.requestPostData(record.id), {
      contentType: requestHeader("content-type"),
      contentEncoding: requestHeader("content-encoding"),
      wholeSize: sizeInBytes(
        Number(requestHeader("content-length") || NaN),
        "as the app sent them"
      ),
    });
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
      resp.body = await readAndroidBody(() => inspector.responseBody(record.id), {
        mimeType: record.response.mimeType,
        contentType: headerValue(record.response.headers, "content-type"),
        contentEncoding: headerValue(record.response.headers, "content-encoding"),
        wholeSize: sizeInBytes(record.encodedDataLength ?? NaN, "as the app received them"),
      });
    }
    details.response = resp;
  }

  return details;
}

/**
 * Says what the request headers are when they are not simply what went on
 * the wire: without that, an absent Cookie or User-Agent reads as "not sent".
 */
function requestHeadersNote(record: AndroidNativeRecord): string | undefined {
  if (record.request.wireHeaders) {
    return record.redirects?.length
      ? "These are the headers sent on the wire with the last request, after the hops in redirects."
      : undefined;
  }
  if (record.response?.fromCache) {
    return "These are the headers the app set. The response came from the cache, so no request went on the wire.";
  }
  return "These are the headers the app set. The headers sent on the wire (such as Cookie and User-Agent) were not reported for this request.";
}

interface AndroidBodyFraming {
  /** The MIME type shown; defaults to the type in `contentType`. */
  mimeType?: string;
  /** The body's Content-Type header, which may name a charset. */
  contentType: string;
  contentEncoding: string;
  /** The whole body's size, shown when the agent kept only its start. */
  wholeSize?: string;
}

async function readAndroidBody(
  read: () => Promise<AndroidNetworkBody>,
  framing: AndroidBodyFraming
): Promise<string> {
  const mimeType = framing.mimeType ?? framing.contentType.split(";")[0]!.trim();
  let body: AndroidNetworkBody;
  try {
    body = await read();
  } catch (err) {
    return `[unavailable: ${err instanceof Error ? err.message : String(err)}]`;
  }
  if (!body.available) return `[unavailable: ${body.reason ?? "no body"}]`;
  if (!body.base64Encoded) {
    return body.truncated
      ? cutByAgent(body.body, mimeType, Buffer.byteLength(body.body), framing)
      : truncateBody(body.body, mimeType);
  }

  const kept = Buffer.from(body.body, "base64");
  const bytes = decodeContent(kept, framing.contentEncoding, body.truncated);
  if (!bytes) {
    return `[unavailable: the ${framing.contentEncoding.trim()} body decodes to more than ${MAX_DECODED_BODY_BYTES / (1024 * 1024)} MiB]`;
  }
  const text = decodeText(bytes, charsetOf(framing.contentType), body.truncated);
  if (text === null) {
    return body.truncated
      ? `[binary, ${cutSize(kept.length, framing)}, MIME: ${mimeType || "unknown"}]`
      : `[binary: ${bytes.length} bytes, MIME: ${mimeType || "unknown"}]`;
  }
  return body.truncated
    ? cutByAgent(text, mimeType, kept.length, framing)
    : truncateBody(text, mimeType);
}

/**
 * A body the agent cut short: its own length is the cut's, so the size shown
 * is the whole body's, in bytes, when the record knows it.
 */
function cutByAgent(
  text: string,
  mimeType: string,
  keptBytes: number,
  framing: AndroidBodyFraming
): string {
  const shown = text.length > MAX_BODY_SIZE ? `${text.slice(0, MAX_BODY_SIZE)}...` : text;
  return `[TRUNCATED — ${cutSize(keptBytes, framing)}, MIME: ${mimeType}]\n${shown}`;
}

function cutSize(keptBytes: number, framing: AndroidBodyFraming): string {
  return `original size: ${framing.wholeSize ?? "unknown"}; the agent kept only the first ${keptBytes} bytes`;
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
  const codings = contentEncoding
    .split(",")
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding !== "" && coding !== "identity");
  let decoded = bytes;
  for (const coding of codings.reverse()) {
    const next = decodeOne(decoded, coding, truncated);
    if (next === null) return null;
    if (next === undefined) return bytes;
    decoded = next;
  }
  return decoded;
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
        // Node 22.15 and 23.8 added zstd; the tool-server also runs on Node 20.
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
      return new TextDecoder(label, { fatal: true }).decode(bytes, { stream: truncated });
    } catch {
      // An unknown label, or bytes that are not this charset: try UTF-8.
    }
  }
  return null;
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
