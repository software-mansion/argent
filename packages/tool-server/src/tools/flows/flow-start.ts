import { z } from "zod";
import * as fs from "node:fs/promises";
import type { ToolDefinition } from "@argent/registry";
import { getFlowsDir, getFlowPath } from "./flow-utils";

const zodSchema = z.object({
  name: z.string().describe("Flow name (used as the filename, no extension)"),
});

export const flowStartTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { created: string }
> = {
  id: "flow_start",
  description: `Create a new flow file in the .argent/ directory at the git root.
A flow is a simple script where each line is either an MCP tool call or an echo.
Use flow_add_step to append steps, then flow_finish to confirm.`,
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    const dir = await getFlowsDir();
    await fs.mkdir(dir, { recursive: true });

    const filePath = await getFlowPath(params.name);
    // Overwrite / create fresh
    await fs.writeFile(filePath, "", "utf8");

    return { created: filePath };
  },
};
