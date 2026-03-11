import { z } from "zod";
import * as fs from "node:fs/promises";
import type { ToolDefinition } from "@argent/registry";
import { getFlowPath, serializeStep } from "./flow-utils";

const zodSchema = z.object({
  name: z.string().describe("Flow name to append to"),
  command: z.string().describe("MCP tool name (e.g. \"tap\")"),
  arguments: z
    .record(z.unknown())
    .optional()
    .describe("Arguments for the tool call as a JSON object"),
});

export const flowAddStepTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { appended: string }
> = {
  id: "flow_add_step",
  description: "Append a tool call step to an existing flow.",
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    const filePath = await getFlowPath(params.name);
    const line = serializeStep({
      kind: "tool",
      name: params.command,
      args: (params.arguments ?? {}) as Record<string, unknown>,
    });
    await fs.appendFile(filePath, line + "\n", "utf8");
    return { appended: line };
  },
};
