import { z } from "zod";
import type { Registry, ToolDefinition } from "@argent/registry";
import {
  getActiveFlow,
  getRecordingSession,
  appendStepToActiveFlow,
  serializeFlow,
  clientFileDirective,
  type FlowSavedTo,
  type FlowStep,
  type RecordingSession,
} from "./flow-utils";
import { invokeSubTool } from "../../utils/sub-invoke";
import { resolveDevice } from "../../utils/device-info";
import { stripDeviceKeys } from "./flow-device";
import { fetchTree, nodeAtPoint, deriveSelector, type Selector } from "../../utils/ui-tree-match";

const zodSchema = z.object({
  command: z.string().describe('MCP tool name (e.g. "tap", "screenshot", "launch-app")'),
  args: z
    .string()
    .optional()
    .describe(
      'Tool arguments as a JSON string, e.g. \'{"udid": "ABC", "x": 0.5, "y": 0.3}\'. Omit for tools with no arguments.'
    ),
  delayMs: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Milliseconds to sleep before executing this step during replay."),
});

/**
 * For a recorded `gesture-tap`, look up the element under the tapped point and
 * record a portable `tap: { selector }` step instead of raw coordinates.
 * Returns the selector, or a warning describing why coordinates were kept.
 */
async function captureTapSelector(
  registry: Registry,
  udid: string,
  point: { x: number; y: number }
): Promise<{ selector?: Selector; warning?: string }> {
  try {
    const device = resolveDevice(udid);
    const { tree } = await fetchTree(registry, device);
    const node = nodeAtPoint(tree, point);
    if (!node) return { warning: "no element found under the tap; kept coordinates (brittle)" };
    const selector = deriveSelector(node);
    if (!selector) return { warning: "tapped element has no stable text/id; kept coordinates (brittle)" };
    return { selector };
  } catch (err) {
    return { warning: `selector capture failed (${err instanceof Error ? err.message : String(err)}); kept coordinates` };
  }
}

// The standalone runner launches an e2e flow's app from scratch before step 1
// (`restart-app`, or `launch-app` on Chromium — see flow-run.ts). So a leading
// app-launch step in the recorded steps just relaunches what the runner already
// launched — useless. These are dropped from the recording (still run live).
const LAUNCH_COMMANDS = new Set(["restart-app", "launch-app"]);

/**
 * True when `command` is an app-launch that would be a redundant *leading* step
 * of an e2e flow: the flow declares a `launch` block, and nothing but echoes or
 * other launch steps has been recorded yet (so this launch sits at the front).
 */
function isRedundantLeadingLaunch(command: string, session: RecordingSession | null): boolean {
  if (!session || session.flow.launch === undefined) return false;
  if (!LAUNCH_COMMANDS.has(command)) return false;
  return session.flow.steps.every(
    (s) => s.kind === "echo" || (s.kind === "tool" && LAUNCH_COMMANDS.has(s.name))
  );
}

export function createFlowAddStepTool(
  registry: Registry
): ToolDefinition<
  z.infer<typeof zodSchema>,
  { message: string; toolResult: unknown; flowFile: string; savedTo: FlowSavedTo }
> {
  return {
    id: "flow-add-step",
    description: `Execute a tool call and record it as a step in the active flow. Use when recording a flow with flow-start-recording and you want to run and capture each action. A coordinate \`gesture-tap\` is recorded as a portable \`tap: { selector }\` step when the tapped element has stable text/identifier (otherwise coordinates are kept with a warning). Returns { message, toolResult, flowFile } on success. If it fails an error is returned and nothing is recorded.
If a step was recorded by mistake, edit the .yaml file directly to remove it.`,
    zodSchema,
    services: () => ({}),
    async execute(_services, params, ctx) {
      const flowName = getActiveFlow();
      const args: Record<string, unknown> = params.args ? JSON.parse(params.args) : {};

      // Selector capture must read the tree BEFORE the tap runs: a navigating
      // tap (e.g. a list row that opens a detail screen) replaces the screen, so
      // the tapped element is gone by the time the tap returns. Resolve the
      // element under the point against the pre-tap tree, then execute.
      const isTap =
        params.command === "gesture-tap" &&
        params.delayMs === undefined &&
        typeof args.udid === "string" &&
        typeof args.x === "number" &&
        typeof args.y === "number";

      let captured: { selector?: Selector; warning?: string } | undefined;
      if (isTap) {
        captured = await captureTapSelector(registry, args.udid as string, {
          x: args.x as number,
          y: args.y as number,
        });
      }

      const toolResult = await invokeSubTool(registry, ctx, params.command, args);

      // A leading app-launch is run live (to set up the device for the rest of
      // the recording) but NOT recorded: the runner relaunches the e2e flow's
      // app from scratch at replay, so the step would only double-launch.
      const session = getRecordingSession();
      if (isRedundantLeadingLaunch(params.command, session) && session) {
        const flowFile = serializeFlow(session.flow);
        const savedTo: FlowSavedTo =
          session.persist === "client"
            ? clientFileDirective(session.filePath, flowFile)
            : session.filePath;
        return {
          message:
            `Ran ${params.command} live but did not record it — the runner launches this e2e ` +
            `flow's app from scratch at replay, so a leading ${params.command} step is redundant.`,
          toolResult,
          flowFile,
          savedTo,
        };
      }

      let step: FlowStep;
      let warning: string | undefined;
      if (captured?.selector) {
        step = { kind: "tap", selector: captured.selector };
      } else if (isTap) {
        // No stable selector — keep a coordinate tap, but still as a `tap:`
        // directive so every tap reads uniformly.
        step = { kind: "tap", x: args.x as number, y: args.y as number };
        warning = captured?.warning;
      } else {
        // The step ran live with the full args (incl. the device id), but the
        // recorded form drops the device id so the flow stays portable — the
        // runner injects whatever device it resolves at replay.
        step = { kind: "tool", name: params.command, args: stripDeviceKeys(args), delayMs: params.delayMs };
      }

      const { flowFile, savedTo } = await appendStepToActiveFlow(step);

      return {
        message: `Step added to "${flowName}" flow${warning ? ` — ${warning}` : ""}`,
        toolResult,
        flowFile,
        savedTo,
      };
    },
  };
}
