import { z } from "zod";
import type { Registry, ToolDefinition } from "@argent/registry";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ALLOWED_TOOLS = new Set([
  "gesture-tap",
  "gesture-swipe",
  "gesture-custom",
  "gesture-pinch",
  "gesture-rotate",
  "button",
  "keyboard",
  "rotate",
]);

const zodSchema = z.object({
  udid: z.string().describe("Simulator UDID (shared across all steps)"),
  steps: z
    .array(
      z.object({
        tool: z
          .string()
          .describe(
            "Tool name — one of: gesture-tap, gesture-swipe, gesture-custom, gesture-pinch, gesture-rotate, button, keyboard, rotate"
          ),
        args: z
          .record(z.unknown())
          .describe("Tool arguments (excluding udid, which is injected automatically)"),
        delayMs: z
          .number()
          .optional()
          .describe("Wait time in ms after this step before the next (default 100)"),
      })
    )
    .min(1)
    .describe("Ordered list of interaction steps to execute sequentially"),
});

type StepResult = { tool: string; result: unknown } | { tool: string; error: string };

type RunSequenceResult = {
  completed: number;
  total: number;
  steps: StepResult[];
};

export function createRunSequenceTool(
  registry: Registry
): ToolDefinition<z.infer<typeof zodSchema>, RunSequenceResult> {
  return {
    id: "run-sequence",
    description: `Execute multiple simulator interaction steps in a single call without observing the screen between them.
Use when all steps are known in advance and no intermediate screen state needs checking — e.g. scrolling a list multiple times, typing text then pressing enter, or rotating back and forth. Do NOT use if any step depends on the result of a previous one; call tools individually instead.

Parameters: udid — shared simulator UDID; steps — array of { tool, args (udid auto-injected), delayMs? }.
Allowed tools: gesture-tap { x, y }, gesture-swipe { fromX, fromY, toX, toY }, gesture-custom { events, interpolate? }, gesture-pinch { centerX, centerY, startDistance, endDistance }, gesture-rotate { centerX, centerY, radius, startAngle, endAngle }, button { button }, keyboard { text?, key? }, rotate { orientation }.
Example: { "udid": "A1B2C3D4-E5F6-7890-ABCD-EF1234567890", "steps": [{ "tool": "keyboard", "args": { "text": "hello" } }, { "tool": "keyboard", "args": { "key": "enter" } }] }
Returns { completed, total, steps: [...results] }. Stops on the first error and returns partial results. Fails if an unlisted tool name is provided.`,
    zodSchema,
    services: (params) => ({
      simulatorServer: `SimulatorServer:${params.udid}`,
    }),
    async execute(_services, params) {
      const { udid, steps } = params;
      const results: StepResult[] = [];

      for (const step of steps) {
        if (!ALLOWED_TOOLS.has(step.tool)) {
          results.push({
            tool: step.tool,
            error: `Tool "${step.tool}" is not allowed in run-sequence. Allowed: ${[...ALLOWED_TOOLS].join(", ")}`,
          });
          break;
        }

        try {
          const toolArgs = { ...step.args, udid };
          const result = await registry.invokeTool(step.tool, toolArgs);
          results.push({ tool: step.tool, result });
        } catch (err) {
          results.push({
            tool: step.tool,
            error: err instanceof Error ? err.message : String(err),
          });
          break;
        }

        const delay = step.delayMs ?? 100;
        if (delay > 0) await sleep(delay);
      }

      return {
        completed: results.filter((r) => "result" in r).length,
        total: steps.length,
        steps: results,
      };
    },
  };
}
