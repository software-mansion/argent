import { z } from "zod";
import type { Registry, ToolCapability, ToolDefinition } from "@argent/registry";
import type { ServiceRef } from "@argent/registry";
import { simulatorServerRef } from "../../blueprints/simulator-server";
import { chromiumCdpRef } from "../../blueprints/chromium-cdp";
import { resolveDevice } from "../../utils/device-info";
import { assertSupported, UnsupportedOperationError } from "../../utils/capability";
import { sleep, DEFAULT_INTER_STEP_DELAY_MS } from "../../utils/timing";
import { invokeSubTool } from "../../utils/sub-invoke";

const ALLOWED_TOOLS = new Set([
  "gesture-tap",
  "gesture-swipe",
  "gesture-scroll",
  "gesture-drag",
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
      "Target device id from `list-devices` (iOS UDID, Android serial, or Chromium id) — shared across all steps."
    ),
  steps: z
    .array(
      z.object({
        tool: z
          .string()
          .describe(
            "Tool name — one of: gesture-tap, gesture-swipe, gesture-scroll, gesture-drag, gesture-custom, gesture-pinch, gesture-rotate, button, keyboard, rotate"
          ),
        args: z
          .record(z.string(), z.unknown())
          .describe("Tool arguments (excluding udid, which is injected automatically)"),
        delayMs: z
          .number()
          .optional()
          .describe(
            `Wait time in ms after this step before the next (default ${DEFAULT_INTER_STEP_DELAY_MS})`
          ),
      })
    )
    .min(1)
    .describe("Ordered list of interaction steps to execute sequentially"),
});

type Params = z.infer<typeof zodSchema>;

type StepResult = { tool: string; result: unknown } | { tool: string; error: string };

type RunSequenceResult = {
  completed: number;
  total: number;
  steps: StepResult[];
};

// run-sequence is platform-neutral by construction: every step is dispatched
// through `registry.invokeTool`, and each step's tool runs its own
// `dispatchByPlatform` against `params.udid`. The capability here just gates
// the *outer* invocation, mirroring the inner tools' support matrix so the
// failure mode is consistent.
const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
  chromium: { app: true },
};

export function createRunSequenceTool(
  registry: Registry
): ToolDefinition<Params, RunSequenceResult> {
  return {
    id: "run-sequence",
    description: `Execute multiple device interaction steps in a single call (iOS simulator, Android emulator, or Chromium app).
Use when you need sequential actions and do NOT need to observe the screen between them
(e.g. scrolling multiple times, typing then pressing enter, rotating back and forth).
Returns { completed, total, steps } with per-step results. Fails if an unrecognised tool name is used in a step (error returned at that step, execution stops).
No screenshot is captured automatically — call screenshot separately after the sequence if needed.

ONLY use this when every step is known in advance. If any step depends on the
result of a previous one (e.g. tapping a menu item that only appears after
a prior tap), use individual tool calls instead.

Allowed tools and their args (udid is auto-injected, do NOT include it in args):

  gesture-tap:    { x: number, y: number }                                                                              [ios/android/chromium]
  gesture-swipe:  { fromX: number, fromY: number, toX: number, toY: number, durationMs?: number }                       [ios/android]
  gesture-scroll: { x: number, y: number, deltaX?: number, deltaY?: number, durationMs?: number }                       [chromium only]
  gesture-drag:   { fromX: number, fromY: number, toX: number, toY: number, durationMs?: number }                       [chromium only]
  gesture-custom: { events: [{ type: "Down"|"Move"|"Up", x: number, y: number, x2?: number, y2?: number, delayMs?: number }], interpolate?: number }  [ios/android]
  gesture-pinch:  { centerX: number, centerY: number, startDistance: number, endDistance: number, angle?: number, durationMs?: number }              [ios only]
  gesture-rotate: { centerX: number, centerY: number, radius: number, startAngle: number, endAngle: number, durationMs?: number }                    [ios only]
  button:         { button: "home"|"back"|"power"|"volumeUp"|"volumeDown"|"appSwitch"|"actionButton" }                  [ios/android]
  keyboard:       { text?: string, key?: string, delayMs?: number }                                                     [ios/android/chromium]
  rotate:         { orientation: "Portrait"|"LandscapeLeft"|"LandscapeRight"|"PortraitUpsideDown" }                     [ios/android]

Example — scroll down three times (use gesture-scroll with positive deltaY on Chromium):
  { "udid": "<UDID>", "steps": [
    { "tool": "gesture-swipe", "args": { "fromX": 0.5, "fromY": 0.7, "toX": 0.5, "toY": 0.3 } },
    { "tool": "gesture-swipe", "args": { "fromX": 0.5, "fromY": 0.7, "toX": 0.5, "toY": 0.3 } },
    { "tool": "gesture-swipe", "args": { "fromX": 0.5, "fromY": 0.7, "toX": 0.5, "toY": 0.3 } }
  ]}

Example — type text and submit:
  { "udid": "<UDID>", "steps": [
    { "tool": "keyboard", "args": { "text": "hello world" } },
    { "tool": "keyboard", "args": { "key": "enter" } }
  ]}

Stops on the first error and returns partial results.`,
    alwaysLoad: true,
    longRunning: true,
    searchHint: "batch sequence multiple gesture steps sequentially",
    zodSchema,
    capability,
    // Eagerly hold a reference to the device's transport service so the
    // sub-tool invocations don't pay the spawn / connect cost on the first
    // step. iOS / Android use simulator-server; Chromium uses CDP.
    services: (params): Record<string, ServiceRef> => {
      const device = resolveDevice(params.udid);
      if (device.platform === "chromium") {
        return { chromium: chromiumCdpRef(device) };
      }
      return { simulatorServer: simulatorServerRef(device) };
    },
    async execute(_services, params, ctx) {
      const { udid, steps } = params;
      const device = resolveDevice(udid);
      const results: StepResult[] = [];

      for (const step of steps) {
        if (!ALLOWED_TOOLS.has(step.tool)) {
          results.push({
            tool: step.tool,
            error: `Tool "${step.tool}" is not allowed in run-sequence. Allowed: ${[...ALLOWED_TOOLS].join(", ")}`,
          });
          break;
        }

        // Pre-flight the sub-tool's capability gate. Registry.invokeTool does
        // NOT call assertSupported (the HTTP layer does), so without this
        // check a mobile-only step like `button` on a Chromium device would
        // descend into the simulator-server blueprint factory and surface as
        // a generic 500 instead of a clean "not supported on chromium".
        const subTool = registry.getTool(step.tool);
        if (subTool?.capability) {
          try {
            assertSupported(step.tool, subTool.capability, device);
          } catch (err) {
            if (err instanceof UnsupportedOperationError) {
              results.push({ tool: step.tool, error: err.message });
              break;
            }
            throw err;
          }
        }

        try {
          const toolArgs = { ...step.args, udid };
          const result = await invokeSubTool(registry, ctx, step.tool, toolArgs);
          results.push({ tool: step.tool, result });
        } catch (err) {
          results.push({
            tool: step.tool,
            error: err instanceof Error ? err.message : String(err),
          });
          break;
        }

        const delay = step.delayMs ?? DEFAULT_INTER_STEP_DELAY_MS;
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
