import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type {
  JsRuntimeDebuggerApi,
  NetworkLogEntry,
} from "../../blueprints/js-runtime-debugger";

/**
 * Header names (lowercase) that should be redacted to avoid leaking secrets.
 * Matches the same set as Radon IDE's redactSensitiveHeaders.
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

function redactHeaders(
  headers: Record<string, string>
): Record<string, string> {
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
  requestId: z
    .string()
    .describe(
      "The requestId from debugger-network-logs to get full details for"
    ),
  includeBody: z
    .boolean()
    .default(true)
    .describe(
      "Whether to attempt fetching the response body via CDP (Network.getResponseBody). Defaults to true."
    ),
});

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

export const debuggerNetworkRequestTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  NetworkRequestDetails | string
> = {
  id: "debugger-network-request",
  description: `Get full details of a specific network request by its requestId (from debugger-network-logs).
Returns request/response headers (sensitive headers redacted), status, timing, and optionally the response body.
Large response bodies are truncated. Use this after debugger-network-logs to inspect individual requests.`,
  zodSchema,
  services: (params) => ({
    debugger: `JsRuntimeDebugger:${params.port}`,
  }),
  async execute(services, params) {
    const api = services.debugger as JsRuntimeDebuggerApi;
    const entry = api.networkLogsById.get(params.requestId);

    if (!entry) {
      return `No network request found with requestId "${params.requestId}". Use debugger-network-logs to list available requests.`;
    }

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

      // Try to fetch the response body via CDP if requested and the request is done.
      if (params.includeBody && entry.state === "finished") {
        try {
          const bodyResult = (await api.cdp.send("Network.getResponseBody", {
            requestId: entry.requestId,
          })) as { body?: string; base64Encoded?: boolean } | undefined;

          if (bodyResult?.body != null) {
            const body = bodyResult.body;
            if (body.length > MAX_BODY_SIZE) {
              resp.body = `[TRUNCATED — original size: ${body.length} chars, MIME: ${entry.response.mimeType}]\n${body.slice(0, MAX_BODY_SIZE)}…`;
            } else {
              resp.body = body;
            }
          }
        } catch {
          // Network.getResponseBody may not be available or may fail for streamed/binary responses.
          // That's fine — we just omit the body.
        }
      }

      details.response = resp;
    }

    return details;
  },
};
