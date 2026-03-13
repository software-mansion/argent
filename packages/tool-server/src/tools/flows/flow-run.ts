import { z } from "zod";
import * as fs from "node:fs/promises";
import type { Registry, ToolDefinition } from "@argent/registry";
import { getFlowPath, parseFlow, type FlowStep } from "./flow-utils";

const zodSchema = z.object({
  name: z.string().describe("Name of the flow to run (e.g. \"settings-explore\")"),
});

type StepResult =
  | { kind: "echo"; message: string }
  | { kind: "tool"; tool: string; result: unknown; outputHint?: string }
  | { kind: "tool"; tool: string; error: string };

export type FlowRunResult = {
  flow: string;
  steps: StepResult[];
};

export function createRunFlowTool(
  registry: Registry,
): ToolDefinition<z.infer<typeof zodSchema>, FlowRunResult> {
  return {
    id: "flow-execute",
    description: `Run a saved flow from the .argent/ directory.
Each step is executed in order: tool calls are dispatched through the registry,
echo steps print a message. Returns the result of every step, including images.`,
    zodSchema,
    services: () => ({}),
    async execute(_services, params) {
      const filePath = await getFlowPath(params.name);
      const fileContent = await fs.readFile(filePath, "utf8");
      const parsed = parseFlow(fileContent);

      const steps: StepResult[] = [];

      for (let i = 0; i < parsed.length; i++) {
        const step = parsed[i] as FlowStep;

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

      return { flow: params.name, steps };
    },
  };
}
