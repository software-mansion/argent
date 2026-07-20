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

/**
 * Header names (lowercase) that should be redacted to avoid leaking secrets.
 */
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

/** Max response body content size shown to AI to avoid context bloat. */
const MAX_BODY_SIZE = 1000;

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port"),
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

export const networkRequestTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  NetworkRequestDetails | string
> = {
  id: "view-network-request-details",
  description: `Get full details of a specific network request by its requestId (from view-network-logs).
Returns request/response headers (sensitive headers redacted), status, timing, and optionally the response body.
Large response bodies are truncated. Use when you need headers, body, or timing for a specific request after listing logs.
Returns an error message string if the requestId is not found — use view-network-logs to get valid requestId values.`,
  zodSchema,
  // Companion to view-network-logs: RN via the injected interceptor, Chromium
  // via the native CDP Network recording. Dispatched on the device id.
  capability: DEBUGGER_TOOL_CAPABILITY,
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.device_id);
    if (device.platform === "chromium") {
      return { chromium: chromiumCdpRef(device) };
    }
    return { inspector: `NetworkInspector:${params.port}:${canonicalDeviceId(params.device_id)}` };
  },
  async execute(services, params) {
    // Chromium: build details from the server-side CDP Network recording, and
    // fetch the response body on demand via Network.getResponseBody.
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
              resp.body =
                body.length > MAX_BODY_SIZE
                  ? `[TRUNCATED — original size: ${body.length} chars, MIME: ${resp.mimeType}]\n${body.slice(0, MAX_BODY_SIZE)}...`
                  : body;
            }
          } catch {
            // Body not retained (page navigated, evicted, or never had one).
          }
        }
        details.response = resp;
      }
      return details;
    }

    const api = services.inspector as NetworkInspectorApi;

    // Ensure the interceptor is installed (idempotent).
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
        const body = entry.responseBody;
        if (body.length > MAX_BODY_SIZE) {
          resp.body = `[TRUNCATED — original size: ${body.length} chars, MIME: ${entry.response.mimeType}]\n${body.slice(0, MAX_BODY_SIZE)}...`;
        } else {
          resp.body = body;
        }
      }

      details.response = resp;
    }

    return details;
  },
};
