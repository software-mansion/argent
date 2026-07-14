import { z } from "zod";
import type { Registry, ToolCapability, ToolContext, ToolDefinition } from "@argent/registry";
import { resolveDevice } from "../../utils/device-info";
import { assertSupported, UnsupportedOperationError } from "../../utils/capability";
import { sleepOrAbort, DEFAULT_INTER_STEP_DELAY_MS } from "../../utils/timing";
import { invokeSubTool } from "../../utils/sub-invoke";
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
  "rotate",
  // `tv-remote` drives the D-pad on a TV target (Apple TV / Android TV / Vega);
  // `keyboard` types into the focused field there.
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
            "Tool name — one of: gesture-tap, gesture-swipe, gesture-scroll, gesture-drag, gesture-custom, gesture-pinch, gesture-rotate, button, keyboard, rotate, tv-remote, await-ui-element. On a TV target (Apple TV / Android TV / Vega) use tv-remote (remote presses) and keyboard (text)."
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
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
  chromium: { app: true },
  // Vega (Fire TV) is a valid target: its `tv-remote` / `keyboard` steps are
  // supported, and the description advertises it. Without this key the outer
  // capability gate (HTTP layer's assertSupported) would reject a Vega udid
  // before any step runs — each step's own capability is still enforced below.
  vega: { vvd: true },
};

export function createRunSequenceTool(
  registry: Registry
): ToolDefinition<Params, RunSequenceResult> {
  return {
    id: "run-sequence",
    description: `Execute multiple device interaction steps in a single call (iOS simulator, Android emulator, Apple TV / Android TV, or Chromium app).
Use when you need sequential actions and do NOT need to observe the screen between them
(e.g. scrolling multiple times, typing then pressing enter, rotating back and forth).
Returns { completed, total, steps } with per-step results. Fails if an unrecognised tool name is used in a step (error returned at that step, execution stops).
No screenshot is captured automatically — call screenshot separately after the sequence if needed.

ONLY use this when every step is known in advance. If any step depends on the
result of a previous one (e.g. tapping a menu item that only appears after
a prior tap), use individual tool calls instead.

Allowed tools and their args (udid is auto-injected, do NOT include it in args):

  gesture-tap:    { x: number, y: number, clickCount?: number }                                                        [ios/android/chromium]
  gesture-swipe:  { fromX: number, fromY: number, toX: number, toY: number, durationMs?: number }                       [ios/android]
  gesture-scroll: { x: number, y: number, deltaX?: number, deltaY?: number, durationMs?: number }                       [chromium only]
  gesture-drag:   { fromX: number, fromY: number, toX: number, toY: number, durationMs?: number }                       [chromium only]
  gesture-custom: { events: [{ type: "Down"|"Move"|"Up", x: number, y: number, x2?: number, y2?: number, delayMs?: number }], interpolate?: number }  [ios/android]
  gesture-pinch:  { centerX: number, centerY: number, startDistance: number, endDistance: number, angle?: number, durationMs?: number }              [ios only]
  gesture-rotate: { centerX: number, centerY: number, radius: number, startAngle: number, endAngle: number, durationMs?: number }                    [ios only]
  button:         { button: "home"|"back"|"power"|"volumeUp"|"volumeDown"|"appSwitch"|"actionButton" }                  [ios/android]
  keyboard:       { text?: string, key?: string, delayMs?: number }  (key pressed after text; TV: text only)            [ios/android/chromium/vega/tv]
  rotate:         { orientation: "Portrait"|"LandscapeLeft"|"LandscapeRight"|"PortraitUpsideDown" }                     [ios/android]
  tv-remote:      { button: <remote button | array of them>, repeat?: number }                                          [apple tv/android tv/vega]
                  buttons: up/down/left/right/select/back/home/menu/playPause (+ rewind/fastForward/next/previous/volumeUp/volumeDown/mute — work on Android TV and Vega; rejected on the Apple TV simulator)
  await-ui-element: { condition: "exists"|"visible"|"hidden"|"text", selector: {text?,identifier?,role?}, expectedText?, timeoutMs?, pollIntervalMs? }  [ios/android/chromium]

Example — scroll down three times (use gesture-scroll with positive deltaY on Chromium):
  { "udid": "<UDID>", "steps": [
    { "tool": "gesture-swipe", "args": { "fromX": 0.5, "fromY": 0.7, "toX": 0.5, "toY": 0.3 } },
    { "tool": "gesture-swipe", "args": { "fromX": 0.5, "fromY": 0.7, "toX": 0.5, "toY": 0.3 } },
    { "tool": "gesture-swipe", "args": { "fromX": 0.5, "fromY": 0.7, "toX": 0.5, "toY": 0.3 } }
  ]}

Example — type text and submit (one step: the key is pressed after the text is typed):
  { "udid": "<UDID>", "steps": [
    { "tool": "keyboard", "args": { "text": "hello world", "key": "enter" } }
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
    // No eagerly-declared service: each step resolves its own services through
    // `invokeSubTool` below (simulator-server for iOS/Android, CDP for
    // Chromium), so run-sequence itself needs none. An eager resolver can't be
    // used here because a tvOS udid shape-classifies as `ios` (there is no
    // `tvos` platform) — declaring simulator-server for it would spawn a
    // controller it can't drive and hang on the ready timeout before any tv-*
    // step could run. The sub-tool invocations still pay only their own
    // first-step spawn cost, and `ctx` is threaded through so nested steps keep
    // the outer request's telemetry attribution.
    services: () => ({}),
    async execute(_services, params, ctx?: ToolContext) {
      const { udid, steps } = params;
      const device = resolveDevice(udid);
      const results: StepResult[] = [];
      // The HTTP layer aborts `signal` when the client disconnects. run-sequence
      // is `longRunning` (and a single `tv-remote` step can fire dozens of
      // daemon/adb round-trips), so the MCP adapter won't abort it for us — honour
      // the signal between steps and on the inter-step delay so a cancelled
      // request stops promptly instead of running the rest of the sequence at the
      // device. Each sub-tool also receives `signal` via `ctx`.
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
          results.push({
            tool: step.tool,
            error: err instanceof Error ? err.message : String(err),
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
