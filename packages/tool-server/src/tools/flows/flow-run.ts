import { z } from "zod";
import * as fs from "node:fs/promises";
import type { Registry, ToolDefinition } from "@argent/registry";
import { getFlowPath, parseFlow, type FlowStep } from "./flow-utils";

const zodSchema = z.object({
  name: z.string().describe('Name of the flow to run (e.g. "settings-explore")'),
  prerequisiteAcknowledged: z
    .boolean()
    .optional()
    .describe(
      "Set to true to confirm the execution prerequisite has been met. Required when the flow defines an executionPrerequisite."
    ),
});

type StepResult =
  | { kind: "echo"; message: string }
  | { kind: "tool"; tool: string; result: unknown; outputHint?: string }
  | { kind: "tool"; tool: string; error: string };

export type FlowRunResult = {
  flow: string;
  executionPrerequisite: string;
  steps: StepResult[];
};

export type FlowPrerequisiteNotice = {
  flow: string;
  notice: string;
  executionPrerequisite: string;
};

export function createRunFlowTool(
  registry: Registry
): ToolDefinition<z.infer<typeof zodSchema>, FlowRunResult | FlowPrerequisiteNotice> {
  return {
    id: "flow-execute",
    description: `Run a saved flow from the .argent/ directory. Use when you want to replay a recorded sequence, e.g. a "login-flow". Parameters: name (flow name) and optional prerequisiteAcknowledged (boolean). Returns the result of every step, including images. Tool calls dispatched through the registry, echo steps print a message. Fails if the flow file does not exist or a prerequisite is unacknowledged. Use flow-read-prerequisite to inspect the prerequisite first.`,
    zodSchema,
    services: () => ({}),
    async execute(_services, params) {
      const filePath = await getFlowPath(params.name);
      const fileContent = await fs.readFile(filePath, "utf8");
      const flow = parseFlow(fileContent);

      if (flow.executionPrerequisite && !params.prerequisiteAcknowledged) {
        return {
          flow: params.name,
          notice:
            "This flow has an execution prerequisite that must be fulfilled before it can run. " +
            "Verify the prerequisite is met and call flow-execute again with prerequisiteAcknowledged set to true.",
          executionPrerequisite: flow.executionPrerequisite,
        };
      }

      const steps: StepResult[] = [];

      for (let i = 0; i < flow.steps.length; i++) {
        const step = flow.steps[i] as FlowStep;

        if (step.kind === "echo") {
          steps.push({ kind: "echo", message: step.message });
          continue;
        }

        const toolDef = registry.getTool(step.name);

        try {
          const result = await registry.invokeTool(step.name, step.args);
          steps.push({
            kind: "tool",
            tool: step.name,
            result,
            outputHint: toolDef?.outputHint,
          });
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          steps.push({ kind: "tool", tool: step.name, error });
          break;
        }
      }

      return {
        flow: params.name,
        executionPrerequisite: flow.executionPrerequisite,
        steps,
      };
    },
  };
}
