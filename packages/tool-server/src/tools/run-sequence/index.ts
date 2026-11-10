import { z } from "zod";

import type {
  DeviceInfo,
  Registry,
  ToolCapability,
  ToolContext,
  ToolDefinition,
} from "@argent/registry";
import { resolveDevice, isIosPhysicalDevice } from "../../utils/device-info";
import { assertSupported, UnsupportedOperationError } from "../../utils/capability";
import { sleepOrAbort, DEFAULT_INTER_STEP_DELAY_MS } from "../../utils/timing";
import { invokeSubTool, describeNestedParamError } from "../../utils/sub-invoke";
import { AWAIT_UI_ELEMENT_TOOL_ID, isUnmetUiWaitResult } from "../await-ui-element";
import { unmetWaitReason } from "../../utils/tool-result-verdict";
import { waitForScreenIdle } from "../await-screen-idle";

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

const SETTLE_AFTER = new Set([
  "gesture-tap",
  "gesture-swipe",
  "gesture-scroll",
  "gesture-drag",
  "gesture-custom",
  "gesture-pinch",
  "gesture-rotate",
  "button",
  "keyboard",
  "paste",
  "rotate",
  "fold",
  // `visible` holds as soon as an element has a frame, which can be mid slide-in.
  AWAIT_UI_ELEMENT_TOOL_ID,
]);
// Momentum can outlast the cap, so a wait after these says little about the screen.
const SCROLL_TOOLS = new Set(["gesture-swipe", "gesture-scroll", "gesture-drag"]);
const SETTLE_KEYS = new Set(["enter", "return", "escape", "esc"]);
const SETTLE_IDLE_TOOL_ID = "await-screen-idle";
const SETTLE_TIMEOUT_MS = 1000;
const MAX_FAILED_SETTLES = 2;

type Step = Params["steps"][number];

function keyMayMoveUi(args: Record<string, unknown> | undefined): boolean {
  const key = args?.key;
  if (typeof key === "string" && SETTLE_KEYS.has(key.toLowerCase())) return true;
  const text = args?.text;
  return typeof text === "string" && /[\r\n]/.test(text);
}

function canSettle(registry: Registry, device: DeviceInfo): boolean {
  if (device.platform === "harmony" || isIosPhysicalDevice(device)) return false;
  try {
    assertSupported(SETTLE_IDLE_TOOL_ID, registry.getTool(SETTLE_IDLE_TOOL_ID)?.capability, device);
    return true;
  } catch {
    return false;
  }
}

function settlesBetween(step: Step, next: Step | undefined): boolean {
  return (
    next !== undefined &&
    next.tool !== AWAIT_UI_ELEMENT_TOOL_ID &&
    next.tool !== "shake" &&
    !(SCROLL_TOOLS.has(step.tool) && SCROLL_TOOLS.has(next.tool)) &&
    step.settle !== false &&
    SETTLE_AFTER.has(step.tool) &&
    (step.tool !== "keyboard" || keyMayMoveUi(step.args))
  );
}

type SettleVerdict =
  { kind: "settled" | "aborted" | "capped" } | { kind: "unreadable"; error?: string };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function settleScreen(
  registry: Registry,
  device: DeviceInfo,
  signal: AbortSignal | undefined
): Promise<SettleVerdict> {
  try {
    const idle = await waitForScreenIdle(registry, device, {
      timeoutMs: SETTLE_TIMEOUT_MS,
      pollIntervalMs: 50,
      minStableMs: 100,
      signal,
      stopOnReadError: true,
      emptyTreeIsStable: true,
      androidHelperOnly: true,
    });
    if (idle.settled) return { kind: "settled" };
    if (idle.aborted) return { kind: "aborted" };
    if (idle.readError !== undefined) return { kind: "unreadable", error: idle.readError };
    return idle.changed ? { kind: "capped" } : { kind: "unreadable" };
  } catch (err) {
    return { kind: "unreadable", error: errorMessage(err) };
  }
}

function countsAsFailedSettle(step: Step, verdict: SettleVerdict): boolean {
  return verdict.kind !== "settled" && verdict.kind !== "aborted" && !SCROLL_TOOLS.has(step.tool);
}

function settleStoppedReason(verdict: SettleVerdict): string {
  if (verdict.kind === "unreadable") {
    return verdict.error === undefined
      ? `the element tree could not be read fast enough to confirm it was still within ${SETTLE_TIMEOUT_MS}ms`
      : `the element tree could not be read (${verdict.error})`;
  }
  return `the screen was still changing at the ${SETTLE_TIMEOUT_MS}ms cap`;
}

function settleStoppedNote(afterStep: number, verdict: SettleVerdict): string {
  return `Stopped waiting for the screen to settle after step ${afterStep}: ${MAX_FAILED_SETTLES} waits did not settle, the last because ${settleStoppedReason(verdict)}. Later steps ran without the wait.`;
}

type StepResult = { tool: string; result: unknown } | { tool: string; error: string };

type RunSequenceResult = {
  completed: number;
  total: number;
  steps: StepResult[];
  note?: string;
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
  // A Mac app takes the mouse and keyboard steps; touch-only steps fail at their own gate.
  macos: { app: true },
};

const zodSchema = z.object({
  udid: z
    .string()
    .describe(
      "Target device id from `list-devices` (iOS UDID, Android serial, Vega serial, <flag:harmonyos>HarmonyOS id, </flag:harmonyos><flag:macos-apps>Mac app id, </flag:macos-apps>or Chromium id), shared across all steps."
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
            `Wait time in ms after this step before the next (default ${DEFAULT_INTER_STEP_DELAY_MS}). Added after the settle wait, so 0 means no extra wait, not back-to-back dispatch; for that also pass settle:false on this step or at the top level.`
          ),
        settle: z
          .boolean()
          .optional()
          .describe(
            "false skips the settle wait after this step only. Goes next to tool and args; inside args it is passed to the tool instead."
          ),
      })
    )
    .min(1)
    .describe("Ordered list of interaction steps to execute sequentially"),
  settle: z
    .boolean()
    .optional()
    .describe(
      "Applies to the whole sequence; a step's own settle:false skips it after that step only. Default true: after a step that can start a transition (tap, swipe, button, rotate, enter/escape, a met await-ui-element) wait until two reads of the element tree match (max 1s) before the next step. This catches sheets and screens whose elements are already moving, but not motion that starts more than ~100ms after the step (a sheet opened after a fetch) or animations that leave the tree unchanged (a native iOS push or modal sheet), so keep await-ui-element gates for those. A native iOS push reports the new screen's final frames at once, so gate it with condition hidden on an element of the old screen; visible on the new one is met before the push ends. There is no wait between two consecutive swipe, scroll or drag steps. A wait can hit the 1s cap after a push or on a spinner, or when the tree cannot be read within it (a slow page, an alert, the first reads after the tool server starts). A read that outlasts the cap keeps running and can delay the next step, including the reads of a following await-ui-element, so give that step a timeout well above one tree read. The rest of the sequence skips the wait once two waits end that way (two navigations in a row on Android often do), and the result's note says so; a wait after a swipe, scroll or drag is not counted, since momentum often outlasts the cap. No wait on a physical iPhone, where a read would hold up the next step's command.<flag:harmonyos> No wait on HarmonyOS, where one tree read takes longer than the cap.</flag:harmonyos> Set false for timing-critical input (games, double-taps split across steps)."
    ),
});

type Params = z.infer<typeof zodSchema>;

export function createRunSequenceTool(
  registry: Registry
): ToolDefinition<Params, RunSequenceResult> {
  return {
    id: "run-sequence",
    description: `Execute several device interaction steps in one call.
Use when every step is known in advance and you do not need to see the screen between steps (e.g. scrolling several times, typing then pressing enter). If a step depends on the result of an earlier one (e.g. a menu item that appears only after a tap), make separate calls instead.
Steps run in order. If a step fails (an error, a tool that is not allowed or not supported on the target, or an await-ui-element that returns success=false), the sequence stops there and later steps do NOT run. Returns { completed, total, steps } with a result or an error for each step that ran, so a stopped sequence returns partial results.
One screenshot and element tree are captured after the whole sequence, not per step: call screenshot separately only for a baseline before it or to see an intermediate step. A \`{{secret:...}}\` in any step skips that capture, so type a secret and submit it in one sequence.
On a TV target (Apple TV / Android TV / Vega) use tv-remote for remote presses and keyboard for text.

Allowed tools, their args (? = optional) and targets. Positions and distances are 0–1 fractions of the screen (window on Chromium), not pixels; angles are in degrees, durations in ms.
  gesture-tap: x, y, clickCount?<flag:macos-apps>, button? "left"|"right" (macos)</flag:macos-apps>  [ios/android/chromium<flag:harmonyos>/harmony</flag:harmonyos><flag:macos-apps>/macos</flag:macos-apps>]
  gesture-swipe: fromX, fromY, toX, toY, durationMs?, momentum?  [ios/android<flag:harmonyos>/harmony</flag:harmonyos>]
  gesture-scroll: x, y, deltaX?, deltaY? (signed; positive scrolls down), durationMs?  [chromium<flag:macos-apps>/macos</flag:macos-apps>]
  gesture-drag: fromX, fromY, toX, toY, durationMs?, momentum?  [chromium<flag:macos-apps>/macos</flag:macos-apps>]
  gesture-custom: events: [{ type: "Down"|"Move"|"Up", x, y, x2?, y2?, delayMs? }], interpolate?  [ios/android]
  gesture-pinch: centerX, centerY, startDistance, endDistance, endCenterX?, endCenterY?, angle?, durationMs?  [ios/android<flag:harmonyos>/harmony</flag:harmonyos>]
  gesture-rotate: centerX, centerY, startAngle, endAngle, radius (or radiusX + radiusY), durationMs?  [ios/android]
  button: button: "home"|"back"|"power"|"volumeUp"|"volumeDown"|"appSwitch"|"actionButton"  [ios/android<flag:harmonyos>; harmony: home/back/power</flag:harmonyos>]
  keyboard: text? or key? (one per step; key e.g. "enter"), delayMs?  [all; Apple TV / Android TV: text only<flag:harmonyos>; harmony keys: enter/return, backspace/delete, space, arrow-left, arrow-right</flag:harmonyos>]
    text may hold {{secret:<NAME>}} placeholders, resolved server-side from ARGENT_SECRET_<NAME> or an argent secrets file (over a forward-secrets link, the client's first), so a credential never enters your context
  paste: text (device clipboard + paste shortcut; only where a user would paste, e.g. an OTP, else keyboard)  [ios sim/android emu<flag:macos-apps>/macos</flag:macos-apps>]
  rotate: orientation: "Portrait"|"LandscapeLeft"|"LandscapeRight"|"PortraitUpsideDown"  [ios sim/android]
  shake: count?  [ios sim/android emu]
  fold: posture? "closed"|"half-open"|"open", or angle? 0–180, exactly one (later steps land on the new panel, whose coordinates differ)  [foldable ios sim/android emu]
  tv-remote: button (one button, or an array run as a path in one step), repeat?  [apple tv/android tv/vega]
    buttons: up/down/left/right/select/back/home/menu/playPause; rewind/fastForward/next/previous/volumeUp/volumeDown/mute on Android TV and Vega only
  await-ui-element: condition: "exists"|"visible"|"hidden"|"text", selector: { text?, identifier?, role? }, expectedText? (for "text"), textMatch?, timeoutMs?, pollIntervalMs?  [all]`,
    zodSchema,
    alwaysLoad: true,
    searchHint: "batch sequence multiple gesture steps sequentially",
    interaction: {
      startedMsg: ({ params }) => `Running ${params.steps.length}-step interaction sequence`,
      completedMsg: ({ params }) => `Ran ${params.steps.length}-step interaction sequence`,
      failedMsg: ({ failureSignal }) =>
        `Failed to run interaction sequence: ${failureSignal.error_code}`,
    },
    longRunning: true,
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
      const settle = params.settle !== false;
      let failedSettles = 0;
      let stoppedNote: string | undefined;
      let waitSkipped = false;
      let note: string | undefined;
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
        if (waitSkipped) note = stoppedNote;

        try {
          const result = await invokeSubTool(registry, ctx, step.tool, toolArgs);
          if (isUnmetUiWaitResult(step.tool, result)) {
            results.push({ tool: step.tool, error: unmetWaitReason(result) });
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

        if (settle && settlesBetween(step, steps[results.length]) && canSettle(registry, device)) {
          if (stoppedNote !== undefined) {
            waitSkipped = true;
          } else {
            const verdict = await settleScreen(registry, device, signal);
            if (countsAsFailedSettle(step, verdict)) failedSettles += 1;
            if (failedSettles >= MAX_FAILED_SETTLES) {
              stoppedNote = settleStoppedNote(results.length, verdict);
            }
          }
        }

        const delay = step.delayMs ?? DEFAULT_INTER_STEP_DELAY_MS;
        if (delay > 0 && !(await sleepOrAbort(delay, signal))) break;
      }

      return {
        completed: results.filter((r) => "result" in r).length,
        total: steps.length,
        steps: results,
        ...(note ? { note } : {}),
      };
    },
  };
}
