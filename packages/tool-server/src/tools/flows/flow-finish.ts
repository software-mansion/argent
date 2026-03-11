import { z } from "zod";
import * as fs from "node:fs/promises";
import type { ToolDefinition } from "@argent/registry";
import { getFlowPath, parseFlow } from "./flow-utils";

const zodSchema = z.object({
  name: z.string().describe("Flow name to finalise"),
});

export const flowFinishTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { path: string; steps: number; summary: string[] }
> = {
  id: "flow_finish",
  description: `Finish building a flow. Reads the flow file back and returns a summary of all steps.
No writes are performed — the file is already complete after flow_add_step calls.`,
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    const filePath = await getFlowPath(params.name);
    const content = await fs.readFile(filePath, "utf8");
    const steps = parseFlow(content);

    const summary = steps.map((step, i) => {
      if (step.kind === "echo") {
        return `${i + 1}. echo: ${step.message}`;
      }
      return `${i + 1}. tool: ${step.name} ${JSON.stringify(step.args)}`;
    });

    return { path: filePath, steps: steps.length, summary };
  },
};
