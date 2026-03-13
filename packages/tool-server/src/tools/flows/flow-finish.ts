import { z } from "zod";
import * as fs from "node:fs/promises";
import type { ToolDefinition } from "@argent/registry";
import { getFlowPath, getActiveFlow, clearActiveFlow, parseFlow } from "./flow-utils";

const zodSchema = z.object({});

export const flowFinishTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { message: string; path: string; steps: number; summary: string[]; flowFile: string }
> = {
  id: "flow-finish",
  description: `Finish recording the active flow. Returns a summary of all recorded steps.

You can still hand-edit the .flow file afterwards to remove or reorder steps.`,
  zodSchema,
  services: () => ({}),
  async execute(_services, _params) {
    const flowName = getActiveFlow();
    const filePath = await getFlowPath(flowName);
    const flowFile = await fs.readFile(filePath, "utf8");
    const steps = parseFlow(flowFile);

    const summary = steps.map((step, i) => {
      if (step.kind === "echo") {
        return `${i + 1}. echo: ${step.message}`;
      }
      return `${i + 1}. tool: ${step.name} ${JSON.stringify(step.args)}`;
    });

    clearActiveFlow();

    return {
      message: `Finished recording "${flowName}" flow (${steps.length} steps)`,
      path: filePath,
      steps: steps.length,
      summary,
      flowFile,
    };
  },
};
