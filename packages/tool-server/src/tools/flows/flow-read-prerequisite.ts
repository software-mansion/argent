import { z } from "zod";
import * as fs from "node:fs/promises";
import type { ToolDefinition } from "@argent/registry";
import { getFlowPath, parseFlow } from "./flow-utils";

const zodSchema = z.object({
  name: z.string().describe('Name of the flow to inspect (e.g. "settings-explore")'),
  project_root: z
    .string()
    .describe(
      "Absolute path to the project root directory that contains `.argent/<name>.yaml`."
    ),
});

export const flowReadPrerequisiteTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { flow: string; executionPrerequisite: string }
> = {
  id: "flow-read-prerequisite",
  description: `Read the execution prerequisite of a saved flow without running it.
Returns the prerequisite description so you can verify the required state is met before calling flow-execute.
Use when you need to check what app/simulator state is required before executing a flow.
Fails if the flow file does not exist in the .argent/ directory.`,
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    const filePath = getFlowPath(params.project_root, params.name);
    const fileContent = await fs.readFile(filePath, "utf8");
    const flow = parseFlow(fileContent);

    return {
      flow: params.name,
      executionPrerequisite: flow.executionPrerequisite,
    };
  },
};
