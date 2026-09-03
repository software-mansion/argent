import { z } from "zod";

import type { Registry, ToolCapability, ToolContext, ToolDefinition } from "@argent/registry";
import { resolveDevice } from "../../utils/device-info";
import { assertSupported, UnsupportedOperationError } from "../../utils/capability";
import { sleepOrAbort, DEFAULT_INTER_STEP_DELAY_MS } from "../../utils/timing";
import { invokeSubTool, describeNestedParamError } from "../../utils/sub-invoke";
import { AWAIT_UI_ELEMENT_TOOL_ID, isUnmetUiWaitResult } from "../await-ui-element";
import { isUnlandedKeyboardTextResult } from "../keyboard";

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
  "tv-remote",
  AWAIT_UI_ELEMENT_TOOL_ID,
]);

const zodSchema = z.object({
  udid: z
    .string()
    .describe(
      "Target device id from `list-devices` (iOS UDID, Android serial, Vega serial, or Chromium id) — shared across all steps."
    ),
  steps: z
    .array(
      z.object({
        tool: z
          .string()
          .describe(
            "Tool name — one of: gesture-tap, gesture-swipe, gesture-scroll, gesture-drag, gesture-custom, gesture-pinch, gesture-rotate, button, keyboard, paste, rotate, shake, tv-remote, await-ui-element. On a TV target (Apple TV / Android TV / Vega) use tv-remote (remote presses) and keyboard (text)."
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
};

/**
 * How a `keyboard` read-back verdict reads once this tool has converted it into a
 * step error. `flows/flow-add-step.ts` matches on it: its own gate keys on the
 * recorded command being `keyboard`, which the sequence spelling — the one the
 * keyboard description prescribes for typing a secret and submitting it — hides.
 */
export const UNLANDED_KEYBOARD_STEP_ERROR = "typed text did not land";

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
    description: `Execute multiple device interaction steps in a single call (iOS simulator or physical device, Android emulator, Apple TV / Android TV, or Chromium app).
On a physical iOS device only gesture-tap, gesture-swipe, gesture-custom, button, keyboard, and await-ui-element steps run; others fail at their own gate.
Use when you need sequential actions and do NOT need to observe the screen between them
(e.g. scrolling multiple times, typing then pressing enter, rotating back and forth).
Returns { completed, total, steps } with per-step results. Fails if an unrecognised tool name is used in a step (error returned at that step, execution stops).
One screenshot is captured automatically after the whole sequence (not per step) — call screenshot separately only for a baseline BEFORE it, or to observe an intermediate step.
That single capture is also why a secret belongs in this call rather than in two bare ones: the skip is decided from the whole request, so a \`{{secret:...}}\` in any step suppresses the capture that would otherwise follow the submit.

ONLY use this when every step is known in advance. If any step depends on the
result of a previous one (e.g. tapping a menu item that only appears after
a prior tap), use individual tool calls instead.

Allowed tools and their args (udid is auto-injected, do NOT include it in args):

  gesture-tap:    { x: number, y: number, clickCount?: number }                                                        [ios/android/chromium]
  gesture-swipe:  { fromX: number, fromY: number, toX: number, toY: number, durationMs?: number, momentum?: boolean }   [ios/android]
  gesture-scroll: { x: number, y: number, deltaX?: number, deltaY?: number, durationMs?: number }                       [chromium only]
  gesture-drag:   { fromX: number, fromY: number, toX: number, toY: number, durationMs?: number, momentum?: boolean }   [chromium only]
  gesture-custom: { events: [{ type: "Down"|"Move"|"Up", x: number, y: number, x2?: number, y2?: number, delayMs?: number }], interpolate?: number }  [ios/android]
  gesture-pinch:  { centerX: number, centerY: number, startDistance: number, endDistance: number, endCenterX?: number, endCenterY?: number, angle?: number, durationMs?: number }  [ios/android]
  gesture-rotate: { centerX: number, centerY: number, radius?: number, radiusX?: number, radiusY?: number, startAngle: number, endAngle: number, durationMs?: number }  [ios/android]
  button:         { button: "home"|"back"|"power"|"volumeUp"|"volumeDown"|"appSwitch"|"actionButton" }                  [ios/android]
  keyboard:       { text?: string, key?: string, delayMs?: number }  (text OR key per step, never both; TV: text only)  [ios/android/chromium/vega/tv]
                  text supports {{secret:<NAME>}} placeholders, resolved server-side from ARGENT_SECRET_<NAME> env vars or an argent secrets file — credentials never enter agent context
  paste:          { text: string }  (device clipboard + paste shortcut; only where a user would paste, e.g. an OTP — keyboard otherwise)   [ios sim/android emu]
  rotate:         { orientation: "Portrait"|"LandscapeLeft"|"LandscapeRight"|"PortraitUpsideDown" }                     [ios/android]
  shake:          { count?: number }                                                                                    [ios sim/android emu]
  tv-remote:      { button: <remote button | array of them>, repeat?: number }                                          [apple tv/android tv/vega]
                  buttons: up/down/left/right/select/back/home/menu/playPause (+ rewind/fastForward/next/previous/volumeUp/volumeDown/mute — work on Android TV and Vega; rejected on the Apple TV simulator)
  await-ui-element: { condition: "exists"|"visible"|"hidden"|"text", selector: {text?,identifier?,role?}, expectedText?, timeoutMs?, pollIntervalMs? }  [ios/android/chromium]

Example — scroll down three times (use gesture-scroll with positive deltaY on Chromium):
  { "udid": "<UDID>", "steps": [
    { "tool": "gesture-swipe", "args": { "fromX": 0.5, "fromY": 0.7, "toX": 0.5, "toY": 0.3 } },
    { "tool": "gesture-swipe", "args": { "fromX": 0.5, "fromY": 0.7, "toX": 0.5, "toY": 0.3 } },
    { "tool": "gesture-swipe", "args": { "fromX": 0.5, "fromY": 0.7, "toX": 0.5, "toY": 0.3 } }
  ]}

Example — type text and submit (two keyboard steps; one call cannot carry both):
  { "udid": "<UDID>", "steps": [
    { "tool": "keyboard", "args": { "text": "hello world" } },
    { "tool": "keyboard", "args": { "key": "enter" } }
  ]}

Example — TV: move focus right twice then activate (one tv-remote step with a path is cheaper):
  { "udid": "<TV-TARGET-ID>", "steps": [
    { "tool": "tv-remote", "args": { "button": ["right", "right", "select"] } }
  ]}

Example — tap, wait for the next screen's element, then tap it:
  { "udid": "<UDID>", "steps": [
    { "tool": "gesture-tap", "args": { "x": 0.5, "y": 0.9 } },
    { "tool": "await-ui-element", "args": { "condition": "visible", "selector": { "text": "Continue" } } },
    { "tool": "gesture-tap", "args": { "x": 0.5, "y": 0.5 } }
  ]}
If the await-ui-element condition is not met before its timeout, the sequence stops there and the
following steps do NOT run — so the tap above only fires once "Continue" is actually on screen.

A \`keyboard\` text step on an Android phone or tablet stops the sequence the same way when its
read-back proves the text did not reach the field (\`verified: false\`), so the type-then-Enter
shape above halts at its first step — \`completed: 0\`, the Enter never sent and the field left
un-submitted — with that step's \`error\` carrying the tool's note. A halted step is never counted
in \`completed\`. An absent \`verified\` never stops it.

Stops on the first error, an unmet await-ui-element condition, a keyboard read-back that
proved the typed text did not land, or the caller cancelling — which stops it with no error
entry for the step it was in — and returns partial results.`,
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
          // Same shape gap: a `keyboard` text step reports an Android read-back
          // failure in its result instead of throwing, so continuing would run
          // the next step (typically the submit) against the wrong field
          // contents.
          if (isUnlandedKeyboardTextResult(step.tool, result)) {
            results.push({
              tool: step.tool,
              error: `${UNLANDED_KEYBOARD_STEP_ERROR}${result.note ? `: ${result.note}` : ""}`,
            });
            break;
          }
          results.push({ tool: step.tool, result });
        } catch (err) {
          // A tool that watches the signal rejects when the caller gives up
          // mid-call — the keyboard read-back can hold one for tens of seconds
          // while it repairs. Recording that as a step error would report a
          // cancelled run as a failed one: `flow-nested-outcome.ts` reads an
          // error entry as a step failure, and a sequence that merely stopped
          // short as the aborted skip.
          if (signal?.aborted) break;
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
