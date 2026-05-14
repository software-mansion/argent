import { z } from "zod";
import * as fs from "node:fs/promises";
import type { ToolDefinition } from "@argent/registry";
import {
  getFlowsDir,
  getFlowPath,
  getActiveFlowOrNull,
  setActiveFlow,
  setActiveProjectRoot,
  serializeFlow,
} from "./flow-utils";

const zodSchema = z.object({
  name: z.string().describe('Name for this flow (e.g. "settings-explore")'),
  project_root: z
    .string()
    .describe(
      "Absolute path to the project root directory (the directory that contains or should contain `.argent/flows/`). The flow file is created at `<project_root>/.argent/flows/<name>.yaml`."
    ),
  executionPrerequisite: z
    .string()
    .describe(
      'Describes the required app/device state before running this flow (e.g. "App on home screen after a fresh reload", "Settings app open on General page")'
    ),
});

export const flowStartRecordingTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { message: string; previousFlow?: string; flowFile: string }
> = {
  id: "flow-start-recording",
  description: `Start recording a new flow. Creates a .yaml file in the .argent/flows/ directory.
Use when you want to capture a reusable sequence of device interactions (iOS simulator or Android emulator) for later replay.
Returns { message, flowFile } and optionally { previousFlow } if a prior recording was abandoned.
Fails if the .argent/flows/ directory cannot be created or the flow file cannot be written.

After starting, use flow-add-step to append tool calls — each step is executed
LIVE so you can verify it works before it gets recorded. Use flow-add-echo
to add labels. Call flow-finish-recording when done.

If a recorded step turns out to be wrong, you can edit the .yaml file directly
to remove or reorder steps.`,
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    setActiveProjectRoot(params.project_root);
    const previousFlow = getActiveFlowOrNull();

    const dir = getFlowsDir();
    await fs.mkdir(dir, { recursive: true });

    const filePath = getFlowPath(params.name);
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
