import * as zlib from "node:zlib";
import { z } from "zod";
import type { DeviceInfo, ServiceRef, ToolDefinition } from "@argent/registry";
import { canonicalDeviceId } from "../../utils/debugger/device-alias";
import { DEBUGGER_TOOL_CAPABILITY } from "../debugger/debugger-service-ref";
import type { NetworkInspectorApi } from "../../blueprints/network-inspector";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import {
  ANDROID_NATIVE_REQUEST_ID,
  findAndroidNativeRecord,
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
      "Device id from list-devices (iOS simulator UDID or Android serial) — the same id used with debugger-connect."
    ),
  requestId: z.string().describe("The requestId from view-network-logs to get full details for"),
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
    postData?: string;
  };
  response?: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    mimeType: string;
    body?: string;
  };
  errorText?: string;
  initiator?: { type: string; url?: string; lineNumber?: number };
}

function isAndroidNativeRequest(device: DeviceInfo, requestId: string): boolean {
  return device.platform === "android" && ANDROID_NATIVE_REQUEST_ID.test(requestId);
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
  description: `Get full details of a specific network request by its requestId from view-network-logs or native-network-logs.
Android native requests use android-N IDs and include the request body.
Returns request/response headers (sensitive headers redacted), status, timing, and optionally the response body.
Large response bodies are truncated. Use when you need headers, body, or timing for a specific request after listing logs.
If the requestId is not found, list requests again with the tool that supplied the ID.`,
  zodSchema,
  capability: DEBUGGER_TOOL_CAPABILITY,
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.device_id);
    if (device.platform === "chromium") {
      return { chromium: chromiumCdpRef(device) };
    }
    if (isAndroidNativeRequest(device, params.requestId)) return {};
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

    if (isAndroidNativeRequest(device, params.requestId)) {
      return androidNativeRequestDetails(
        canonicalDeviceId(params.device_id) ?? device.id,
        params.requestId,
        params.includeBody
      );
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
  deviceId: string,
  requestId: string,
  includeBody: boolean
): Promise<NetworkRequestDetails | string> {
  const found = findAndroidNativeRecord(deviceId, requestId);
  if (!found) {
    return `Request ${requestId} not found. Use native-network-logs to list the requests the Android native layer recorded.`;
  }
  const { inspector, record } = found;

  const request: NonNullable<NetworkRequestDetails["request"]> = {
    url: record.request.url,
    method: record.request.method,
    headers: redactHeaders(record.request.headers),
  };
  if (record.request.hasPostData) {
    request.postData = await readAndroidBody(
      () => inspector.requestPostData(record.id),
      contentTypeOf(record.request.headers)
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

  if (record.response) {
    const resp: NetworkRequestDetails["response"] = {
      status: record.response.status,
      statusText: record.response.statusText,
      headers: redactHeaders(record.response.headers),
      mimeType: record.response.mimeType,
    };
    if (includeBody) {
      resp.body = await readAndroidBody(
        () => inspector.responseBody(record.id),
        record.response.mimeType,
        headerValue(record.response.headers, "content-encoding")
      );
    }
    details.response = resp;
  }

  return details;
}

async function readAndroidBody(
  read: () => Promise<AndroidNetworkBody>,
  mimeType: string,
  contentEncoding = ""
): Promise<string> {
  let body: AndroidNetworkBody;
  try {
    body = await read();
  } catch (err) {
    return `[unavailable: ${err instanceof Error ? err.message : String(err)}]`;
  }
  if (!body.available) return `[unavailable: ${body.reason ?? "no body"}]`;
  if (!body.base64Encoded) return truncateBody(body.body, mimeType);

  const bytes = decodeContent(Buffer.from(body.body, "base64"), contentEncoding);
  if (!bytes) {
    return `[unavailable: the ${contentEncoding.trim()} body decodes to more than ${MAX_DECODED_BODY_BYTES / (1024 * 1024)} MiB]`;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return `[binary: ${bytes.length} bytes, MIME: ${mimeType || "unknown"}]`;
  }
  return truncateBody(text, mimeType);
}

/**
 * Decodes an Android native body by the response's Content-Encoding. A body
 * that does not decode reads as it came.
 */
function decodeContent(bytes: Buffer, contentEncoding: string): Buffer | null {
  const options = { maxOutputLength: MAX_DECODED_BODY_BYTES };
  try {
    switch (contentEncoding.trim().toLowerCase()) {
      case "gzip":
        return zlib.gunzipSync(bytes, options);
      case "br":
        return zlib.brotliDecompressSync(bytes, options);
      case "zstd":
        // Node 22.15 and 23.8 added zstd; the tool-server also runs on Node 20.
        return typeof zlib.zstdDecompressSync === "function"
          ? zlib.zstdDecompressSync(bytes, options)
          : bytes;
      default:
        return bytes;
    }
  } catch (err) {
    return (err as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE" ? null : bytes;
  }
}

function headerValue(headers: Record<string, string>, wanted: string): string {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === wanted) return value;
  }
  return "";
}

function contentTypeOf(headers: Record<string, string>): string {
  return headerValue(headers, "content-type").split(";")[0]!.trim();
}
