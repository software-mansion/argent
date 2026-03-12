import { z } from "zod";
import * as fs from "node:fs/promises";
import type { ToolDefinition } from "@argent/registry";
import { getFlowsDir, getFlowPath } from "./flow-utils";

const zodSchema = z.object({
  name: z.string().describe("Flow name (used as the filename, no extension)"),
});

export const flowStartTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { created: string; flowFile: string }
> = {
  id: "flow_start",
  description: `Create a new flow file in the .argent/ directory at the git root.

A flow is a recorded sequence of MCP tool calls. Use flow_add_step to append
steps — each step is executed LIVE so you can verify it works before it gets
recorded. Use flow_insert_echo to add labels. Call flow_finish when done.

If a recorded step turns out to be wrong, you can edit the .flow file by hand
afterwards to remove or reorder lines.`,
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    const dir = await getFlowsDir();
    await fs.mkdir(dir, { recursive: true });

    const filePath = await getFlowPath(params.name);
    // Overwrite / create fresh
    await fs.writeFile(filePath, "", "utf8");

    return { created: filePath, flowFile: "" };
  },
};
