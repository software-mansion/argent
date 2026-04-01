import { z } from "zod";
import * as fs from "node:fs/promises";
import type { ToolDefinition } from "@argent/registry";
import {
  getFlowsDir,
  getFlowPath,
  getActiveFlowOrNull,
  setActiveFlow,
  serializeFlow,
} from "./flow-utils";

const zodSchema = z.object({
  name: z.string().describe('Name for this flow (e.g. "settings-explore")'),
  executionPrerequisite: z
    .string()
    .describe(
      'Describes the required app/simulator state before running this flow (e.g. "App on home screen after a fresh reload", "Settings app open on General page")'
    ),
});

export const flowStartRecordingTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { message: string; previousFlow?: string; flowFile: string }
> = {
  id: "flow-start-recording",
  description: `Start recording a new named flow and create its .yaml file in the .argent/ directory.
Use when you want to capture a reusable sequence of MCP tool calls that can be replayed later with flow-execute — for regression testing, A/B profiling, or repeating multi-step UI interactions.

Parameters: name — flow name used as the file key (e.g. "settings-explore"); executionPrerequisite — required app state before the flow can run (e.g. "App on home screen after a fresh reload").
Example: { "name": "login-flow", "executionPrerequisite": "App on login screen" }
Returns { message, flowFile }. After starting, append steps with flow-add-step, add labels with flow-add-echo, then call flow-finish-recording. Fails if the .argent/ directory cannot be created (permissions error). If a step was recorded by mistake, edit the .yaml file directly to remove it.`,
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    const previousFlow = getActiveFlowOrNull();

    const dir = await getFlowsDir();
    await fs.mkdir(dir, { recursive: true });

    const filePath = await getFlowPath(params.name);
    const flowFile = serializeFlow({
      executionPrerequisite: params.executionPrerequisite,
      steps: [],
    });
    await fs.writeFile(filePath, flowFile, "utf8");
    setActiveFlow(params.name);

    if (previousFlow && previousFlow !== params.name) {
      return {
        message:
          `Switched active flow from "${previousFlow}" to "${params.name}". ` +
          `Recording "${previousFlow}" was abandoned - but the flow .yaml file has been saved to disk. ` +
          `Now recording "${params.name}".`,
        previousFlow,
        flowFile,
      };
    }

    return {
      message: `Started recording "${params.name}" flow`,
      flowFile,
    };
  },
};
