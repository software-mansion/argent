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
  description: `Start recording a new flow. Use when you want to script a repeatable sequence of simulator interactions, e.g. a "login-flow". Parameters: name and executionPrerequisite (required app state). Returns { message, flowFile }. Creates a .yaml file in the .argent/ directory. Fails if another flow recording is already active. After starting, use flow-add-step to append tool calls — each step is executed LIVE so you can verify it works before it gets recorded.`,
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
