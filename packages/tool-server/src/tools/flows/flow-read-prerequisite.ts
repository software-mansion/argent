import { z } from "zod";
import * as fs from "node:fs/promises";
import type { ToolDefinition } from "@argent/registry";
import { getFlowPath, parseFlow } from "./flow-utils";

const zodSchema = z.object({
  name: z.string().describe('Name of the flow to inspect (e.g. "settings-explore")'),
});

export const flowReadPrerequisiteTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { flow: string; executionPrerequisite: string }
> = {
  id: "flow-read-prerequisite",
  description: `Read the execution prerequisite of a saved flow without running it. Use when you need to check what app state is required before replaying a flow, e.g. "settings-explore". Parameters: name (flow filename without extension). Returns { flow, executionPrerequisite } so you can verify the required state is met before calling flow-execute. Fails if the flow file does not exist.`,
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    const filePath = await getFlowPath(params.name);
    const fileContent = await fs.readFile(filePath, "utf8");
    const flow = parseFlow(fileContent);

    return {
      flow: params.name,
      executionPrerequisite: flow.executionPrerequisite,
    };
  },
};
