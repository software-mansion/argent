import { z } from "zod";
import * as fs from "node:fs/promises";
import type { ToolDefinition } from "@argent/registry";
import {
  getFlowPath,
  getActiveFlow,
  getRecordingSession,
  clearActiveFlow,
  clientFileDirective,
  parseFlow,
  serializeFlow,
  type FlowSavedTo,
} from "./flow-utils";

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
    savedTo: FlowSavedTo;
  }
> = {
  id: "flow-finish-recording",
  description: `Finish recording the active flow. Returns a summary of all recorded steps and the final YAML content. Use when you have added all desired steps and want to finalize the flow file. Fails if no active flow recording is in progress.
You can still edit the .yaml file directly afterwards to remove or reorder steps.`,
  zodSchema,
  services: () => ({}),
  async execute(_services, _params) {
    const flowName = getActiveFlow();
    const session = getRecordingSession();

    // Host mode re-reads the file so manual edits made during the recording
    // survive into the summary; in client mode this host never has the file,
    // so the in-memory copy is the truth and travels back in the directive.
    const filePath = session?.filePath ?? getFlowPath(flowName);
    let flowFile: string;
    let savedTo: FlowSavedTo;
    if (session?.persist === "client") {
      flowFile = serializeFlow(session.flow);
      savedTo = clientFileDirective(filePath, flowFile);
    } else {
      flowFile = await fs.readFile(filePath, "utf8");
      savedTo = filePath;
    }
    const flow = parseFlow(flowFile);

    const summary = flow.steps.map((step, i) => {
      const n = i + 1;
      switch (step.kind) {
        case "echo":
          return `${n}. echo: ${step.message}`;
        case "run":
          return `${n}. run: ${step.flow}`;
        case "tap":
          return `${n}. tap: ${JSON.stringify(step.selector)}`;
        case "type":
          return `${n}. type: ${JSON.stringify(step.into)} ← "${step.text}"`;
        case "await":
          return `${n}. await: ${step.condition} ${JSON.stringify(step.selector)}`;
        case "assert":
          return `${n}. assert: ${step.condition} ${JSON.stringify(step.selector)}`;
        case "snapshot":
          return `${n}. snapshot: ${step.name}`;
        case "tool":
        default:
          return `${n}. tool: ${step.name} ${JSON.stringify(step.args)}`;
      }
    });

    clearActiveFlow();

    return {
      message: `Finished recording "${flowName}" flow (${flow.steps.length} steps)`,
      path: filePath,
      executionPrerequisite: flow.executionPrerequisite,
      steps: flow.steps.length,
      summary,
      flowFile,
      savedTo,
    };
  },
};
