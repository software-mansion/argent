import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";

const RADON_AI_URL = "https://radon-ai-backend.swmansion.com/";
const PLACEHOLDER_CALL_ID = "3241";

const zodSchema = z.object({
  library_npm_name: z
    .string()
    .describe("The npm package name of the library to describe (e.g. \"react-navigation\")"),
  token: z.string().optional().describe("JWT license token (injected automatically)"),
});

export const getLibraryDescriptionTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { content: string }
> = {
  id: "get-library-description",
  description:
    "Get a description of a React Native library by its npm package name. Returns documentation, usage notes, and API highlights sourced from the Radon AI backend. Requires an active Argent license.",
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    const url = new URL("/api/tool_calls/", RADON_AI_URL);

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
              name: "get_library_description",
              id: PLACEHOLDER_CALL_ID,
              args: { library_npm_name: params.library_npm_name },
            },
          ],
        }),
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
