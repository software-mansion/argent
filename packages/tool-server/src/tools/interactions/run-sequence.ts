import { z } from "zod";
import type { Registry, ToolDefinition } from "@argent/registry";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Unified tool names — simulator-server dispatches iOS vs Android internally,
// so every tool below works on both platforms with a consistent shape.
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
  udid: z
    .string()
    .describe(
      "Device id shared across all steps. iOS: simulator UDID (UUID shape). Android: adb serial (e.g. `emulator-5554`)."
    ),
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
    description: `Execute multiple interaction steps in a single call, on iOS or Android.
Use when you need sequential actions and do NOT need to observe the screen between them
(e.g. scrolling multiple times, typing then pressing enter, rotating back and forth).
Returns { completed, total, steps }. Stops on the first error and returns partial results.
No screenshot is captured automatically — call \`screenshot\` separately after the sequence if needed.

ONLY use this when every step is known in advance. If any step depends on the result of a previous one
(e.g. tapping a menu item that only appears after a prior tap), use individual tool calls instead.

Allowed tools and their args (udid is auto-injected — do NOT include it in args):

  gesture-tap:    { x, y }
  gesture-swipe:  { fromX, fromY, toX, toY, durationMs? }
  gesture-custom: { events: [...], interpolate? }
  gesture-pinch:  { centerX, centerY, startDistance, endDistance, angle?, durationMs? }
  gesture-rotate: { centerX, centerY, radius, startAngle, endAngle, durationMs? }
  button:         { button: "home"|"back"|... }
  keyboard:       { text?, key? }
  rotate:         { orientation: "Portrait"|... }`,
    zodSchema,
    services: () => ({}),
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
