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
  description: `Read the execution prerequisite of a saved flow without running it.
Use when you want to check what app/simulator state is required before running a flow, so you can prepare the correct state before calling flow-execute with prerequisiteAcknowledged: true.

Parameters: name — the name of the flow to inspect (e.g. "settings-explore").
Example: { "name": "login-flow" }
Returns { flow, executionPrerequisite }. Fails if the flow file does not exist in the .argent/ directory — verify the flow name or list available flows with profiler-load (mode: list).`,
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
