import { z } from "zod";
import * as fs from "node:fs/promises";
import type { ToolDefinition } from "@argent/registry";
import { getFlowPath, getActiveFlow, clearActiveFlow, parseFlow } from "./flow-utils";

const zodSchema = z.object({
  project_root: z
    .string()
    .describe(
      "Absolute path to the project root directory (same path passed to flow-start-recording)."
    ),
});

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
  description: `Finish recording the active flow. Returns a summary of all recorded steps and the final YAML content. Use when you have added all desired steps and want to finalize the flow file. Fails if no active flow recording is in progress.
You can still edit the .yaml file directly afterwards to remove or reorder steps.`,
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    const flowName = getActiveFlow();
    const filePath = getFlowPath(params.project_root, flowName);
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
