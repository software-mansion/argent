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
  description: `Finish recording the active flow and close the recording session, returning a summary of all recorded steps.
Use when you have added all desired steps and are ready to save the flow for later replay with flow-execute. You can still edit the .yaml file directly after finishing to remove or reorder steps.

Parameters: none — this tool takes no parameters (call with an empty object).
Example: {}
Returns { message, path, executionPrerequisite, steps: <count>, summary: [...], flowFile }. Fails if no active recording session exists (error: "no active flow") — call flow-start-recording first to begin a session.`,
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
