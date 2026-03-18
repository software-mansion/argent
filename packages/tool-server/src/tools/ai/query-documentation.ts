import { z } from "zod";
import type { InvokeToolOptions, ToolDefinition } from "@argent/registry";
import { activateWithSSO, readToken } from "../../utils/license";

const RADON_AI_URL = "https://radon-ai-backend.swmansion.com/";
const PLACEHOLDER_CALL_ID = "3241";
const REQUEST_TIMEOUT_MS = 30_000;

const zodSchema = z.object({
  text: z
    .string()
    .describe(
      "The query or question to search the React Native documentation for",
    ),
  token: z
    .string()
    .optional()
    .describe("JWT license token (injected automatically)"),
});

const QUERY_DOCS_URL = new URL("/api/tool_calls/", RADON_AI_URL);

async function fetchDocumentation(
  text: string,
  token: string | null,
  signal?: AbortSignal,
) {
  return fetch(QUERY_DOCS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token ?? ""}`,
    },
    body: JSON.stringify({
      tool_calls: [
        {
          name: "query_documentation",
          id: PLACEHOLDER_CALL_ID,
          args: { text },
        },
      ],
    }),
    signal,
  });
}

export const queryDocumentationTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { content: string }
> = {
  id: "query-documentation",
  description:
    "Search React Native documentation and return relevant excerpts or answers. Useful for looking up API references, component props, hooks, and guides.",
  zodSchema,
  services: () => ({}),
  async execute(_services, params, options?: InvokeToolOptions) {
    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = options?.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;

    let response: Response;

    try {
      response = await fetchDocumentation(
        params.text,
        params.token ?? (await readToken()),
        signal,
      );
    } catch (cause) {
      throw new Error("Network failure contacting Radon AI backend", {
        cause: cause as Error,
      });
    }

    if (response.status === 401) {
      const ssoResult = await activateWithSSO();
      if (ssoResult.success) {
        const newToken = await readToken();
        response = await fetchDocumentation(params.text, newToken, signal);
      } else {
        // SSO Login aborted, failed to open, either way the following response is universal to all these cases.
        throw new Error(
          `Argent license required. Login or activate your license to continue. Open ${ssoResult.ssoUrl} to sign in to your account.`,
        );
      }
    }

    if (!response.ok) {
      throw new Error(
        `Radon AI backend responded with status ${response.status}.`,
      );
    }

    let result: { tool_results?: { content: string }[] };

    try {
      result = (await response.json()) as {
        tool_results: { content: string }[];
      };
    } catch {
      throw new Error("Radon AI backend returned malformed JSON");
    }

    if (!result.tool_results?.length) {
      throw new Error("Radon AI backend returned an empty response");
    }

    return { content: result.tool_results[0].content };
  },
};
