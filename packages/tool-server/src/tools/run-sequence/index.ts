import { z } from "zod";

import type {
  DeviceInfo,
  Registry,
  ToolCapability,
  ToolContext,
  ToolDefinition,
} from "@argent/registry";
import { resolveDevice } from "../../utils/device-info";
import { assertSupported, UnsupportedOperationError } from "../../utils/capability";
import { sleepOrAbort, DEFAULT_INTER_STEP_DELAY_MS } from "../../utils/timing";
import { invokeSubTool, describeNestedParamError } from "../../utils/sub-invoke";
import { DEVICE_QUEUE_TOOLS, holdDeviceQueue } from "../../utils/device-serial";
import { AWAIT_UI_ELEMENT_TOOL_ID, isUnmetUiWaitResult } from "../await-ui-element";

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
            "Tool name — one of: gesture-tap, gesture-swipe, gesture-scroll, gesture-drag, gesture-custom, gesture-pinch, gesture-rotate, button, keyboard, paste, rotate, shake, tv-remote, await-ui-element. On a TV target (Apple TV / Android TV / Vega) use tv-remote (remote presses) and keyboard (text, or clear to empty the focused field)."
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
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
  chromium: { app: true },
  // Vega (Fire TV) is a valid target: its `tv-remote` / `keyboard` steps are
  // supported. Without this key the HTTP layer's `assertSupported` would reject
  // a Vega udid before any step runs.
  vega: { vvd: true },
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
    description: `Execute multiple device interaction steps in a single call (iOS simulator, Android emulator, Apple TV / Android TV, or Chromium app).
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
  keyboard:       { text?: string, key?: string, clear?: true, delayMs?: number }  (one of text/key/clear per step, never two; TV: text or clear, no named key)  [ios/android/chromium/vega/tv]
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

Example — replace what a field already holds (tap it first, and give the tap \`delayMs\` to land:
the default 100ms gap is not enough for a slow app, and a clear that arrives before focus moves
deletes from the PREVIOUSLY focused element and still reports success):
  { "udid": "<UDID>", "steps": [
    { "tool": "gesture-tap", "args": { "x": 0.5, "y": 0.3 }, "delayMs": 500 },
    { "tool": "keyboard", "args": { "clear": true } },
    { "tool": "keyboard", "args": { "text": "new value" } },
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

Stops on the first error (or unmet await-ui-element condition) and returns partial results.`,
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
      // The HTTP layer aborts `signal` on client disconnect, and `longRunning`
      // drops the MCP adapter's own fetch timeout — so honour the signal between
      // steps and on the inter-step delay instead of running the rest of the
      // sequence at the device.
      const signal = ctx?.signal;
      const results: StepResult[] = [];

      // A sequence that uses the keyboard takes the device's keyboard queue from
      // its first step through its LAST `keyboard` / `paste` step. The queue
      // holds those two tools and nothing else, so the
      // `[gesture-tap, keyboard { clear }]` recipe above landed its tap at once
      // and then queued the clear behind another session's call — and whatever
      // moved focus in between redirected it. Measured on Chrome 152: the clear
      // emptied a textarea this sequence never addressed and still reported
      // `completed: 2 of 2` with `clearVerified: true`. The steps' own
      // `keyboard` / `paste` calls re-enter the hold rather than deadlocking on
      // it.
      //
      // It stops at the last queued step rather than at the end of the batch,
      // because everything after it is another session's wait for nothing. A
      // batch has no maximum length, `delayMs` has no maximum, and one
      // `await-ui-element` step can add 120s — so a hold that ran to the end
      // blocked every other session's `keyboard` and `paste` for all of it.
      // Measured on Chrome 152 with `[keyboard { clear } delayMs 5000,
      // gesture-tap delayMs 8000]`: a second session's `keyboard` waited 11.54s
      // and typed into THIS sequence's field, where the same request behind a
      // gesture-only sequence returned in 0.17s and typed into its own.
      let lastQueued = -1;
      steps.forEach((step, index) => {
        if (DEVICE_QUEUE_TOOLS.has(step.tool)) lastQueued = index;
      });

      // Request-shape errors answer above the hold. `resolveDevice` and the
      // per-step allow/capability checks read only the REQUEST, so a sequence
      // that can run nothing at all has no reason to wait for a device queue —
      // measured behind another session's call, a malformed sequence came back
      // in 3543ms where the same request with no queued step took 36ms.
      // `keyboard/index.ts` keeps its own two guards above the queue for the
      // same reason.
      //
      // Only the FIRST step is answered early, because a bad step further in
      // still has real work before it: the loop below runs up to it and reports
      // the partial batch, which is the documented behaviour.
      const device = resolveDevice(udid);
      const firstStepError = stepPreflightError(0, device);
      if (firstStepError !== undefined) {
        results.push(firstStepError);
        return { completed: 0, total: steps.length, steps: results };
      }

      if (lastQueued === -1) {
        await runSteps(0, steps.length);
      } else {
        const stopped = await holdDeviceQueue(udid, () => runSteps(0, lastQueued + 1));
        // The last held step's own `delayMs` settles the step AFTER it, which
        // runs outside the hold — so it is waited out there too, rather than
        // held over.
        if (!stopped && lastQueued + 1 < steps.length) {
          const delay = steps[lastQueued]?.delayMs ?? DEFAULT_INTER_STEP_DELAY_MS;
          if (delay <= 0 || (await sleepOrAbort(delay, signal))) {
            await runSteps(lastQueued + 1, steps.length);
          }
        }
      }

      return {
        completed: results.filter((r) => "result" in r).length,
        total: steps.length,
        steps: results,
      };

      /**
       * Whether `steps[index]` can run at all, read off the REQUEST alone —
       * `Registry.invokeTool` does not call `assertSupported` (only the HTTP
       * layer does), so without this a mobile-only step like `button` on a
       * Chromium device fails inside the simulator-server service factory
       * instead of with a clean "not supported" error.
       */
      function stepPreflightError(index: number, resolved: DeviceInfo): StepResult | undefined {
        const step = steps[index]!;
        if (!ALLOWED_TOOLS.has(step.tool)) {
          return {
            tool: step.tool,
            error: `Tool "${step.tool}" is not allowed in run-sequence. Allowed: ${[...ALLOWED_TOOLS].join(", ")}`,
          };
        }
        const subTool = registry.getTool(step.tool);
        if (subTool?.capability) {
          try {
            assertSupported(step.tool, subTool.capability, resolved);
          } catch (err) {
            if (err instanceof UnsupportedOperationError)
              return { tool: step.tool, error: err.message };
            throw err;
          }
        }
        return undefined;
      }

      /** Runs `steps[from..to)`. Answers whether the sequence must stop here. */
      async function runSteps(from: number, to: number): Promise<boolean> {
        for (let index = from; index < to; index++) {
          const step = steps[index]!;
          if (signal?.aborted) return true;

          const preflight = stepPreflightError(index, device);
          if (preflight !== undefined) {
            results.push(preflight);
            return true;
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
              return true;
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
            return true;
          }

          // The segment's last step keeps its delay only when the segment runs
          // to the end of the batch: otherwise the caller above waits it out
          // after releasing the hold.
          const isSegmentTail = index === to - 1 && to < steps.length;
          if (isSegmentTail) return false;
          const delay = step.delayMs ?? DEFAULT_INTER_STEP_DELAY_MS;
          if (delay > 0 && !(await sleepOrAbort(delay, signal))) return true;
        }
        return false;
      }
    },
  };
}
