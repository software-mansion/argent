import { z } from "zod";
import * as fs from "node:fs/promises";
import type { ToolDefinition } from "@argent/registry";
import { getFlowsDir, getFlowPath, setActiveFlow } from "./flow-utils";

const zodSchema = z.object({
  name: z.string().describe("Name for this flow (e.g. \"settings-explore\")"),
});

export const flowStartTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { message: string; flowFile: string }
> = {
  id: "flow-start",
  description: `Start recording a new flow. Creates a .yaml file in the .argent/ directory.

After starting, use flow-add-step to append tool calls — each step is executed
LIVE so you can verify it works before it gets recorded. Use flow-add-echo
to add labels. Call flow-finish when done.

If a recorded step turns out to be wrong, you can edit the .yaml file by hand
afterwards to remove or reorder lines.`,
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    const dir = await getFlowsDir();
    await fs.mkdir(dir, { recursive: true });

    const filePath = await getFlowPath(params.name);
    await fs.writeFile(filePath, "", "utf8");
    setActiveFlow(params.name);

    return { message: `Started recording "${params.name}" flow`, flowFile: "" };
  },
};
