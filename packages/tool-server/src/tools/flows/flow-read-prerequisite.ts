import { z } from "zod";
import * as fs from "node:fs/promises";
import type { FileInputSpec, ToolDefinition } from "@argent/registry";
import { parseFlow } from "./flow-utils";
import { resolveFlowFilePath } from "./flow-run";

const zodSchema = z.object({
  name: z.string().describe('Name of the flow to inspect (e.g. "settings-explore")'),
  project_root: z
    .string()
    .describe(
      "Absolute path to the project root directory that contains `.argent/flows/<name>.yaml`."
    ),
  flow_file: z
    .string()
    .optional()
    .describe(
      "Path to the flow .yaml as readable by the tool-server. Internal — the argent client derives it from project_root and name automatically; leave unset."
    ),
});

// Same boundary contract as flow-execute: the YAML is the agent's file.
const fileInputs: FileInputSpec[] = [
  { target: "flow_file", path: "${project_root}/.argent/flows/${name}.yaml", kind: "file" },
];

export const flowReadPrerequisiteTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { flow: string; executionPrerequisite: string }
> = {
  id: "flow-read-prerequisite",
  description: `Read the execution prerequisite of a saved flow without running it.
Returns the prerequisite description so you can verify the required state is met before calling flow-execute.
Use when you need to check what app/simulator state is required before executing a flow.
Fails if the flow file does not exist in the .argent/flows/ directory.`,
  zodSchema,
  fileInputs,
  services: () => ({}),
  async execute(_services, params) {
    const filePath = resolveFlowFilePath(params);
    const fileContent = await fs.readFile(filePath, "utf8");
    const flow = parseFlow(fileContent);

    return {
      flow: params.name,
      executionPrerequisite: flow.executionPrerequisite,
    };
  },
};
