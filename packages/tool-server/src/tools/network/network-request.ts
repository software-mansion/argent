import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { NetworkInspectorApi } from "../../blueprints/network-inspector";
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
  description: `Get full details of a specific network request by its requestId, including headers, status, timing, and response body.
Use when you need to inspect the exact request/response payload for a specific API call identified in view-network-logs.

Parameters: port — Metro TCP port (default 8081); requestId — the ID string from view-network-logs (e.g. "abc-123"); includeBody — whether to include response body (default true, truncated at 1000 chars).
Example: { "port": 8081, "requestId": "abc-123-def-456" }
Returns { requestId, state, request: { url, method, headers }, response: { status, headers, body } }. Sensitive headers (auth, cookie, token) are redacted. Returns an error string if the requestId is not found — call view-network-logs first to get valid IDs.`,
  zodSchema,
  services: (params) => ({
    inspector: `NetworkInspector:${params.port}`,
  }),
  async execute(services, params) {
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
