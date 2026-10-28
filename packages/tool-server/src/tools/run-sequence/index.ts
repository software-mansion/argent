import { z } from "zod";

import type { Registry, ToolCapability, ToolContext, ToolDefinition } from "@argent/registry";
import { resolveDevice } from "../../utils/device-info";
import { assertSupported, UnsupportedOperationError } from "../../utils/capability";
import { sleepOrAbort, DEFAULT_INTER_STEP_DELAY_MS } from "../../utils/timing";
import { invokeSubTool, describeNestedParamError } from "../../utils/sub-invoke";
import { AWAIT_UI_ELEMENT_TOOL_ID, isUnmetUiWaitResult } from "../await-ui-element";

// No tool here returns an image or an artifact handle — that is what keeps a
// sequence to the single capture the MCP layer appends after the last step.
// Gated by test/run-sequence-observation-gate.test.ts.
export const ALLOWED_TOOLS = new Set([
  "gesture-tap",
  "gesture-swipe",
  "gesture-scroll",
  "gesture-drag",
  "gesture-custom",
  "gesture-pinch",
  "gesture-rotate",
  "button",
  "keyboard",
  // Sequenceable for the same reason `keyboard` is: the focus tap, the paste
  // and the submit are one user action.
  "paste",
  "rotate",
  // Shake's interesting cases are races (shake while a sheet is dismissing,
  // shake right after typing), which need back-to-back dispatch.
  "shake",
  // A fold between two interactions (tap, unfold, tap the same control on the
  // other panel) is the sequence a foldable app is tested with. Like `rotate`,
  // it returns state only; the capture comes once, after the last step.
  "fold",
  "tv-remote",
  AWAIT_UI_ELEMENT_TOOL_ID,
]);

const zodSchema = z.object({
  udid: z
    .string()
    .describe(
      "Target device id from `list-devices` (iOS UDID, Android serial, Vega serial, <flag:harmonyos>HarmonyOS id, </flag:harmonyos>or Chromium id), shared across all steps."
    ),
  steps: z
    .array(
      z.object({
        tool: z.string().describe("Tool name: one of the allowed tools listed in the description."),
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

// Gates only the *outer* invocation: every step resolves its own platform from
// `params.udid` and is gated separately in `execute`.
const capability: ToolCapability = {
  // Physical iOS is a valid outer target. Unsupported steps fail at their own gate, not the whole sequence.
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
  chromium: { app: true },
  // Vega (Fire TV) is a valid target: its `tv-remote` / `keyboard` steps are
  // supported. Without this key the HTTP layer's `assertSupported` would reject
  // a Vega udid before any step runs.
  vega: { vvd: true },
  // Same for HarmonyOS.
  harmony: { device: true },
};

export function createRunSequenceTool(
  registry: Registry
): ToolDefinition<Params, RunSequenceResult> {
  return {
    id: "run-sequence",
    interaction: {
      startedMsg: ({ params }) => `Running ${params.steps.length}-step interaction sequence`,
      completedMsg: ({ params }) => `Ran ${params.steps.length}-step interaction sequence`,
      failedMsg: ({ failureSignal }) =>
        `Failed to run interaction sequence: ${failureSignal.error_code}`,
    },
    description: `Execute several device interaction steps in one call.
Use when every step is known in advance and you do not need to see the screen between steps (e.g. scrolling several times, typing then pressing enter). If a step depends on the result of an earlier one (e.g. a menu item that appears only after a tap), make separate calls instead.
Steps run in order. If a step fails (an error, a tool that is not allowed or not supported on the target, or an await-ui-element whose condition is not met before its timeout), the sequence stops there and later steps do NOT run. Returns { completed, total, steps } with a result or an error for each step that ran, so a stopped sequence returns partial results.
One screenshot and element tree are captured after the whole sequence, not per step: call screenshot separately only for a baseline before it or to see an intermediate step. A \`{{secret:...}}\` in any step skips that capture, so type a secret and submit it in one sequence.
On a physical iOS device only gesture-tap, gesture-swipe, gesture-custom, button, keyboard and await-ui-element steps run. On a TV target (Apple TV / Android TV / Vega) use tv-remote for remote presses and keyboard for text.

Allowed tools, their args (? = optional) and targets. Positions and distances are 0–1 fractions of the screen (window on Chromium), not pixels; angles are in degrees, durations in ms.
  gesture-tap: x, y, clickCount?  [ios/android/chromium<flag:harmonyos>/harmony</flag:harmonyos>]
  gesture-swipe: fromX, fromY, toX, toY, durationMs?, momentum?  [ios/android<flag:harmonyos>/harmony</flag:harmonyos>]
  gesture-scroll: x, y, deltaX?, deltaY? (signed; positive scrolls down), durationMs?  [chromium]
  gesture-drag: fromX, fromY, toX, toY, durationMs?, momentum?  [chromium]
  gesture-custom: events: [{ type: "Down"|"Move"|"Up", x, y, x2?, y2?, delayMs? }], interpolate?  [ios/android]
  gesture-pinch: centerX, centerY, startDistance, endDistance, endCenterX?, endCenterY?, angle?, durationMs?  [ios/android<flag:harmonyos>/harmony</flag:harmonyos>]
  gesture-rotate: centerX, centerY, startAngle, endAngle, radius (or radiusX + radiusY), durationMs?  [ios/android]
  button: button: "home"|"back"|"power"|"volumeUp"|"volumeDown"|"appSwitch"|"actionButton"  [ios/android<flag:harmonyos>; harmony: home/back/power</flag:harmonyos>]
  keyboard: text? or key? (one per step; key e.g. "enter"), delayMs?  [all; TV: text only<flag:harmonyos>; harmony keys: enter/return, backspace/delete, space, arrow-left, arrow-right</flag:harmonyos>]
    text may hold {{secret:<NAME>}} placeholders, resolved server-side from ARGENT_SECRET_<NAME> or an argent secrets file, so a credential never enters your context
  paste: text (device clipboard + paste shortcut; only where a user would paste, e.g. an OTP, else keyboard)  [ios sim/android emu]
  rotate: orientation: "Portrait"|"LandscapeLeft"|"LandscapeRight"|"PortraitUpsideDown"  [ios/android]
  shake: count?  [ios sim/android emu]
  fold: posture? "closed"|"half-open"|"open", or angle? 0–180, exactly one (later steps land on the new panel, whose coordinates differ)  [foldable ios sim/android emu]
  tv-remote: button (one button, or an array run as a path in one step), repeat?  [apple tv/android tv/vega]
    buttons: up/down/left/right/select/back/home/menu/playPause; rewind/fastForward/next/previous/volumeUp/volumeDown/mute on Android TV and Vega only
  await-ui-element: condition: "exists"|"visible"|"hidden"|"text", selector: { text?, identifier?, role? }, expectedText? (for "text"), textMatch?, timeoutMs?, pollIntervalMs?  [all but apple tv]`,
    alwaysLoad: true,
    longRunning: true,
    searchHint: "batch sequence multiple gesture steps sequentially",
    zodSchema,
    capability,
    // Each step resolves its own services. An eager resolver can't be used
    // because a tvOS udid shape-classifies as `ios` (there is no `tvos`
    // platform), so declaring simulator-server would spawn a controller it
    // can't drive and hang on the ready timeout before any tv-remote step runs.
    services: () => ({}),
    async execute(_services, params, ctx?: ToolContext) {
      const { udid, steps } = params;
      const device = resolveDevice(udid);
      const results: StepResult[] = [];
      // The HTTP layer aborts `signal` on client disconnect, and `longRunning`
      // drops the MCP adapter's own fetch timeout — so honour the signal between
      // steps and on the inter-step delay instead of running the rest of the
      // sequence at the device.
      const signal = ctx?.signal;

      for (const step of steps) {
        if (signal?.aborted) break;

        if (!ALLOWED_TOOLS.has(step.tool)) {
          results.push({
            tool: step.tool,
            error: `Tool "${step.tool}" is not allowed in run-sequence. Allowed: ${[...ALLOWED_TOOLS].join(", ")}`,
          });
          break;
        }

        // `Registry.invokeTool` does not call `assertSupported` (only the HTTP
        // layer does), so pre-flight here: otherwise a mobile-only step like
        // `button` on a Chromium device fails inside the simulator-server
        // service factory instead of with a clean "not supported" error.
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

        const toolArgs = { ...step.args, udid };

        try {
          const result = await invokeSubTool(registry, ctx, step.tool, toolArgs);
          if (isUnmetUiWaitResult(step.tool, result)) {
            const note = (result as { note?: string }).note;
            results.push({
              tool: step.tool,
              error: `await-ui-element condition not met${note ? `: ${note}` : ""}`,
            });
            break;
          }
          results.push({ tool: step.tool, result });
        } catch (err) {
          const reframed = describeNestedParamError(
            registry,
            err,
            step.tool,
            toolArgs,
            step.args ?? {}
          );
          results.push({
            tool: step.tool,
            error: reframed ?? (err instanceof Error ? err.message : String(err)),
          });
          break;
        }

        const delay = step.delayMs ?? DEFAULT_INTER_STEP_DELAY_MS;
        if (delay > 0 && !(await sleepOrAbort(delay, signal))) break;
      }

      return {
        completed: results.filter((r) => "result" in r).length,
        total: steps.length,
        steps: results,
      };
    },
  };
}
