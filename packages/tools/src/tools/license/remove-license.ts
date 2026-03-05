import { z } from "zod";
import type { ToolDefinition } from "@radon-lite/registry";
import { removeToken } from "../../license";

const zodSchema = z.object({});

export const removeLicenseTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { removed: true }
> = {
  id: "remove-license",
  description:
    "Removes the stored Radon Lite license token from the Keychain. Useful for testing the activation flow. After calling this tool, gated tools will return a 402 until activate-sso or activate-license-key is called again.",
  zodSchema,
  services: () => ({}),
  async execute() {
    await removeToken();
    return { removed: true };
  },
};
