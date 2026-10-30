import { z } from "zod";
import type { ServiceRef, ToolDefinition } from "@argent/registry";
import { canonicalDeviceId } from "../../utils/debugger/device-alias";
import { DEBUGGER_TOOL_CAPABILITY } from "../debugger/debugger-service-ref";
import type { NetworkInspectorApi } from "../../blueprints/network-inspector";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { resolveDevice } from "../../utils/device-info";
import {
  NETWORK_INTERCEPTOR_SCRIPT,
  makeNetworkDetailReadScript,
} from "../../utils/debugger/scripts/network-interceptor";
import { metroPort, metroPortField } from "../../utils/debugger/metro-port";
import { isRedirect, reasonPhrase } from "./network-logs";

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

/** Body chars kept, of a request or a response; the rest is truncated to limit context. */
const MAX_BODY_SIZE = 1000;

/** Heads a body cut to MAX_BODY_SIZE chars; `fullSize` is the size of the whole body, with its unit. */
function cutMarker(fullSize: string, mimeType?: string): string {
  const mime = mimeType !== undefined ? `, MIME: ${mimeType}` : "";
  return `[TRUNCATED: first ${MAX_BODY_SIZE} chars shown, full size: ${fullSize}${mime}]`;
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
function truncatePostData(postData: string | undefined, truncated?: boolean): string | undefined {
  // A body the interceptor cut is always longer than MAX_BODY_SIZE.
  if (postData == null || postData.length <= MAX_BODY_SIZE) return postData;
  const fullSize = truncated ? `more than ${postData.length} chars` : `${postData.length} chars`;
  return `${cutMarker(fullSize)}\n${postData.slice(0, MAX_BODY_SIZE)}...`;
}

const zodSchema = z.object({
  port: metroPortField,
  device_id: z
    .string()
    .describe(
      "Device id from list-devices (iOS simulator UDID or Android serial), the same id used with debugger-connect."
    ),
  requestId: z.string().describe("The requestId from view-network-logs to get full details for"),
  includeBody: z
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
    postData?: string;
  };
  response?: {
    status: number;
    statusText: string;
    /** The final URL, when a redirect led away from the request URL. */
    redirectedTo?: string;
    headers: Record<string, string>;
    mimeType: string;
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
  description: `Get full details of a specific network request by its requestId (from view-network-logs).
Returns request/response headers (sensitive headers redacted), status, timing, the request body, and optionally the response body.
Request and response bodies over 1000 chars are cut to 1000 under a "[TRUNCATED: ...]" line that gives the full size; a binary response body is replaced by "[body omitted: binary <mime>, N bytes]". Use when you need headers, body, or timing for a specific request after listing logs.
Returns an error message string if the requestId is not found: use view-network-logs to get valid requestId values.`,
  readOnly: true,
  zodSchema,
  capability: DEBUGGER_TOOL_CAPABILITY,
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.device_id);
    if (device.platform === "chromium") {
      return { chromium: chromiumCdpRef(device) };
    }
    return {
      inspector: `NetworkInspector:${metroPort(params)}:${canonicalDeviceId(params.device_id)}`,
    };
  },
  async execute(services, params) {
    if (resolveDevice(params.device_id).platform === "chromium") {
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
          postData: truncatePostData(rec.postData),
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
              const body = out.base64Encoded ? utf8Text(Buffer.from(out.body, "base64")) : out.body;
              if (typeof body !== "string") {
                resp.body = `[body omitted: binary ${resp.mimeType || "data"}, ${body.length} bytes]`;
              } else {
                resp.body =
                  body.length > MAX_BODY_SIZE
                    ? `${cutMarker(`${body.length} chars`, resp.mimeType)}\n${body.slice(0, MAX_BODY_SIZE)}...`
                    : body;
              }
            }
          } catch {
            // Body not retained: navigated away, evicted, or never had one.
          }
        }
        details.response = resp;
      }
      return details;
    }

    const api = services.inspector as NetworkInspectorApi;

    // Idempotent: the script no-ops if already installed.
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
    };

    if (entry.request) {
      details.request = {
        url: entry.request.url,
        method: entry.request.method,
        headers: redactHeaders(entry.request.headers),
        postData: truncatePostData(entry.request.postData, entry.request.postDataTruncated),
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
        resp.body = `[body omitted: binary ${entry.response.mimeType || "data"}${size}]`;
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
          resp.body = `${cutMarker(fullSize, entry.response.mimeType)}\n${body.slice(0, MAX_BODY_SIZE)}...`;
        } else {
          resp.body = body;
        }
      }

      details.response = resp;
    }

    return details;
  },
};
