import { z } from "zod";
import type { InvokeToolOptions, ToolDefinition } from "@argent/registry";

const RADON_AI_URL = "https://radon-ai-backend.swmansion.com/";
const PLACEHOLDER_CALL_ID = "3241";
const REQUEST_TIMEOUT_MS = 30_000;

const zodSchema = z.object({
  text: z
    .string()
    .describe("The query or question to search the React Native documentation for"),
  token: z.string().optional().describe("JWT license token (injected automatically)"),
});

export const queryDocumentationTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { content: string }
> = {
  id: "query-documentation",
  description:
    "Search React Native documentation and return relevant excerpts or answers. Useful for looking up API references, component props, hooks, and guides. Requires an active Argent license.",
  zodSchema,
  services: () => ({}),
  async execute(_services, params, options?: InvokeToolOptions) {
    const url = new URL("/api/tool_calls/", RADON_AI_URL);

    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = options?.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.token ?? ""}`,
        },
        body: JSON.stringify({
          tool_calls: [
            {
              name: "query_documentation",
              id: PLACEHOLDER_CALL_ID,
              args: { text: params.text },
            },
          ],
        }),
        signal,
      });
    } catch (cause) {
      throw new Error("Network failure contacting Radon AI backend", { cause: cause as Error });
    }

    if (response.status === 401) {
      throw new Error(
        "Authorization failed. Make sure your Argent license is active (use activate-sso or activate-license-key)."
      );
    }

    if (!response.ok) {
      throw new Error(`Radon AI backend responded with status ${response.status}`);
    }

    const result = await response.json() as { tool_results: { content: string }[] };

    if (!result.tool_results?.length) {
      throw new Error("Radon AI backend returned an empty response");
    }

    return { content: result.tool_results[0].content };
  },
};
