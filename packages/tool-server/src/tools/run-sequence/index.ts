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
import { sleepOrAbort, settleWithin, DEFAULT_INTER_STEP_DELAY_MS } from "../../utils/timing";
import { treeFingerprint } from "../../utils/ui-tree-match";
import type { DescribeNode, DescribeTreeData } from "../describe/contract";
import { describeIos } from "../describe/platforms/ios";
import { queryAndroidFullHierarchy } from "../flows/flow-android-tree";
import { queryChromiumTree } from "../flows/flow-chromium-tree";
import { invokeSubTool, describeNestedParamError } from "../../utils/sub-invoke";
import {
  AWAIT_NETWORK_REQUEST_TOOL_ID,
  AWAIT_UI_ELEMENT_TOOL_ID,
  isUnmetWaitResult,
} from "../../utils/wait-result";
import { unmetWaitReason } from "../../utils/tool-result-verdict";

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
  // Returns its match, never an image: after network-capture-start, an
  // action and its wait run as one sequence, and an unmet wait stops it.
  AWAIT_NETWORK_REQUEST_TOOL_ID,
]);

const SETTLE_TIMEOUT_MS = 1000;
const SETTLE_POLL_MS = 50;
const TOOLS_THAT_SETTLE = new Set(["gesture-tap", "button", AWAIT_UI_ELEMENT_TOOL_ID]);
const KEYS_THAT_SETTLE = new Set(["enter", "return", "escape", "esc"]);

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
  // A Mac app takes the mouse and keyboard steps; touch-only steps fail at their own gate.
  macos: { app: true, catalyst: true },
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
            `Wait time in ms after this step (and after the settle wait) before the next (default ${DEFAULT_INTER_STEP_DELAY_MS})`
          ),
      })
    )
    .min(1)
    .describe("Ordered list of interaction steps to execute sequentially"),
  settle: z
    .boolean()
    .optional()
    .describe(
      `Wait up to ${SETTLE_TIMEOUT_MS}ms after a screen-changing step for the element tree to settle before the next step. Default true; set false on a screen that never stops changing.`
    ),
});

type Params = z.infer<typeof zodSchema>;
type Step = Params["steps"][number];
type ReadTree = () => Promise<DescribeTreeData>;

function mayStartTransition(step: Step): boolean {
  if (TOOLS_THAT_SETTLE.has(step.tool)) return true;
  if (step.tool !== "keyboard") return false;
  const { key, text } = step.args;
  if (typeof key === "string") return KEYS_THAT_SETTLE.has(key.toLowerCase());
  return typeof text === "string" && /[\r\n]/.test(text);
}

function repeatsTap(step: Step, next: Step): boolean {
  return (
    step.tool === "gesture-tap" &&
    next.tool === "gesture-tap" &&
    step.args.x === next.args.x &&
    step.args.y === next.args.y
  );
}

function settleTreeReader(registry: Registry, device: DeviceInfo): ReadTree | undefined {
  if (device.platform === "ios" && device.kind === "simulator") {
    return () => describeIos(registry, device, {});
  }
  if (device.platform === "android") {
    return () => queryAndroidFullHierarchy(registry, device, { waitForIdleMs: 0 });
  }
  if (device.platform === "chromium") return () => queryChromiumTree(registry, device);
  return undefined;
}

function settleFingerprint(root: DescribeNode): string {
  return `${treeFingerprint(root)}\nfocus:${treeFingerprint(root, (node) => node.focused === true)}`;
}

async function waitForStillTree(readTree: ReadTree, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let previous: string | undefined;
  while (Date.now() < deadline) {
    const read = await settleWithin(readTree(), deadline - Date.now(), signal);
    if (read.type !== "value") return;
    const fingerprint = settleFingerprint(read.value.tree);
    if (fingerprint === previous) return;
    previous = fingerprint;
    if (!(await sleepOrAbort(SETTLE_POLL_MS, signal))) return;
  }
}

export function createRunSequenceTool(
  registry: Registry
): ToolDefinition<Params, RunSequenceResult> {
  return {
    id: "run-sequence",
    description: `Run several device interaction steps in one call.
Use when every step is known in advance (e.g. several scrolls, or typing then enter). If a step depends on what an earlier one shows, make separate calls.
Steps run in order. After a step that can change the screen, the next one waits up to 1000ms for the element tree to settle (see \`settle\`); keep an await-ui-element before a step that needs the new screen.
If a step fails (an error, a tool not allowed or not supported on the target, or a wait step that returns success=false), the sequence stops there. Returns { completed, total, steps } with a result or error for each step that ran.
One screenshot and element tree are captured after the last step, not per step. A \`{{secret:...}}\` in any step skips that capture, so type and submit a secret in one sequence.

Allowed tools, args (? = optional) and targets. Positions and distances are 0–1 fractions of the screen (window on Chromium), not pixels; angles in degrees, durations in ms.
  gesture-tap: x, y, clickCount?<flag:macos-apps>, button? "left"|"right", modifiers? ["control"|"option"|"shift"|"command"] (macos)</flag:macos-apps>  [ios/android/chromium<flag:harmonyos>/harmony</flag:harmonyos><flag:macos-apps>/macos</flag:macos-apps>]
  gesture-swipe: fromX, fromY, toX, toY, durationMs?, momentum?  [ios/android<flag:harmonyos>/harmony</flag:harmonyos>]
  gesture-scroll: x, y, deltaX?, deltaY? (positive scrolls down), durationMs?  [chromium<flag:macos-apps>/macos</flag:macos-apps>]
  gesture-drag: fromX, fromY, toX, toY, durationMs?, momentum?  [chromium<flag:macos-apps>/macos</flag:macos-apps>]
  gesture-custom: events: [{ type: "Down"|"Move"|"Up", x, y, x2?, y2?, delayMs? }], interpolate?, edge?  [ios/android]
  gesture-pinch: centerX, centerY, startDistance, endDistance, endCenterX?, endCenterY?, angle?, durationMs?  [ios/android<flag:harmonyos>/harmony</flag:harmonyos>]
  gesture-rotate: centerX, centerY, startAngle, endAngle, radius (or radiusX + radiusY), durationMs?  [ios/android]
  button: button: "home"|"back"|"power"|"volumeUp"|"volumeDown"|"appSwitch"|"actionButton"  [ios/android<flag:harmonyos>; harmony: home/back/power</flag:harmonyos>]
  keyboard: text? or key? (one per step, e.g. key "enter"), delayMs?; text may hold {{secret:<NAME>}} placeholders, resolved server-side  [all; Apple TV/Android TV: text only]
  paste: text (only where a user would paste, e.g. an OTP)  [ios sim/android emu<flag:macos-apps>/macos</flag:macos-apps>]
  rotate: orientation: "Portrait"|"LandscapeLeft"|"LandscapeRight"|"PortraitUpsideDown"  [ios sim/android]
  shake: count?  [ios sim/android emu]
  fold: posture? "closed"|"half-open"|"open" or angle? 0–180 (later steps land on the new panel)  [foldable ios sim/android emu]
  tv-remote: button (one, or an array run as a path), repeat?  [apple tv/android tv/vega]
  await-ui-element: condition: "exists"|"visible"|"hidden"|"text", selector: { text?, identifier?, role? }, expectedText?, textMatch?, timeoutMs?, pollIntervalMs?  [all]
  await-network-request: bundleId, url, plus the standalone tool's optional args. Call network-capture-start before the sequence.  [ios sim/android/chromium<flag:macos-apps>/macos</flag:macos-apps>]`,
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
      const readSettleTree =
        params.settle === false ? undefined : settleTreeReader(registry, device);
      const results: StepResult[] = [];
      // The HTTP layer aborts `signal` on client disconnect, and `longRunning`
      // drops the MCP adapter's own fetch timeout — so honour the signal between
      // steps and on the inter-step delay instead of running the rest of the
      // sequence at the device.
      const signal = ctx?.signal;

      for (const [index, step] of steps.entries()) {
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
          if (isUnmetWaitResult(step.tool, result)) {
            results.push({ tool: step.tool, error: unmetWaitReason(step.tool, result) });
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

        const next = steps[index + 1];
        if (
          readSettleTree &&
          next &&
          next.tool !== AWAIT_UI_ELEMENT_TOOL_ID &&
          !repeatsTap(step, next) &&
          mayStartTransition(step)
        ) {
          await waitForStillTree(readSettleTree, signal);
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
