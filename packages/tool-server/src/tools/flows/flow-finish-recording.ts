import { z } from "zod";
import * as fs from "node:fs/promises";
import type { ToolDefinition } from "@argent/registry";
import { getFlowPath, getActiveFlow, clearActiveFlow, parseFlow } from "./flow-utils";

const zodSchema = z.object({});

export const flowFinishRecordingTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  {
    message: string;
    path: string;
    executionPrerequisite: string;
    steps: number;
    summary: string[];
    flowFile: string;
  }
> = {
  id: "flow-finish-recording",
  description: `Finish recording the active flow. Use when you have added all desired steps and want to save the flow for later replay, e.g. after recording a login sequence. Parameters: none. Returns { message, path, steps, summary, flowFile }. You can still edit the .yaml file directly afterwards to remove or reorder steps. Fails if no flow recording is active.`,
  zodSchema,
  services: () => ({}),
  async execute(_services, _params) {
    const flowName = getActiveFlow();
    const filePath = await getFlowPath(flowName);
    const flowFile = await fs.readFile(filePath, "utf8");
    const flow = parseFlow(flowFile);

    const summary = flow.steps.map((step, i) => {
      if (step.kind === "echo") {
        return `${i + 1}. echo: ${step.message}`;
      }
      return `${i + 1}. tool: ${step.name} ${JSON.stringify(step.args)}`;
    });

    clearActiveFlow();

    return {
      message: `Finished recording "${flowName}" flow (${flow.steps.length} steps)`,
      path: filePath,
      executionPrerequisite: flow.executionPrerequisite,
      steps: flow.steps.length,
      summary,
      flowFile,
    };
  },
};
