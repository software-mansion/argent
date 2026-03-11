import { z } from "zod";
import * as fs from "node:fs/promises";
import type { Registry, ToolDefinition } from "@argent/registry";
import { getFlowPath, parseFlow, type FlowStep } from "./flow-utils";

const zodSchema = z.object({
  name: z.string().describe("Name of the flow to run"),
});

export type StepResult =
  | { step: number; kind: "echo"; message: string }
  | { step: number; kind: "tool"; tool: string; result: unknown }
  | { step: number; kind: "tool"; tool: string; error: string };

export function createRunFlowTool(
  registry: Registry,
): ToolDefinition<
  z.infer<typeof zodSchema>,
  { flow: string; steps: number; results: StepResult[] }
> {
  return {
    id: "run_flow",
    description: `Run a saved flow from the .argent/ directory.
Each step is executed in order: tool calls are dispatched through the registry,
echo steps print a message. Returns the result of every step.`,
    zodSchema,
    services: () => ({}),
    async execute(_services, params) {
      const filePath = await getFlowPath(params.name);
      const content = await fs.readFile(filePath, "utf8");
      const steps = parseFlow(content);

      const results: StepResult[] = [];

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i] as FlowStep;
        const stepNum = i + 1;

        if (step.kind === "echo") {
          results.push({ step: stepNum, kind: "echo", message: step.message });
          continue;
        }

        try {
          const result = await registry.invokeTool(step.name, step.args);
          results.push({ step: stepNum, kind: "tool", tool: step.name, result });
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          results.push({ step: stepNum, kind: "tool", tool: step.name, error });
          // Stop execution on first error
          break;
        }
      }

      return { flow: params.name, steps: steps.length, results };
    },
  };
}
