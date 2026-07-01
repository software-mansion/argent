import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Registry, ToolDefinition } from "@argent/registry";
import {
  getActiveFlow,
  getRecordingSession,
  appendStepToActiveFlow,
  parseFlow,
  isE2eFlow,
  assertSafeFlowName,
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
    if (!selector)
      return { warning: "tapped element has no stable text/id; kept coordinates (brittle)" };
    return { selector };
  } catch (err) {
    return {
      warning: `selector capture failed (${err instanceof Error ? err.message : String(err)}); kept coordinates`,
    };
  }
}

// Replaying a fragment to set up state during recording is done by running it
// through `flow-execute`. Recorded verbatim that becomes a brittle
// `tool: flow-execute` step (baked-in project_root + device, no portability).
// Instead, capture it as a `run: <name>` composition directive — mirroring the
// gesture-tap → tap rewrite.
const RUN_TARGET_COMMAND = "flow-execute";

/**
 * For a recorded `flow-execute` call, decide whether to record it as a
 * `run: <name>` directive. Returns the fragment name to compose, or a warning
 * explaining why the raw `flow-execute` step was kept.
 *
 * `run:` only composes **fragments** (no `launch`) resolved as **siblings** of
 * the recording in its `.argent/flows` dir (host-resolved composition, design
 * §12). So we keep the raw step when the target is an e2e flow, can't be
 * resolved as a sibling, or the recording is remote (the host can't read the
 * client's sibling files to validate).
 */
async function captureRunTarget(
  session: RecordingSession | null,
  args: Record<string, unknown>
): Promise<{ flow?: string; warning?: string }> {
  const name = args.name;
  if (typeof name !== "string") {
    return { warning: "flow-execute call had no flow name; kept the raw step" };
  }
  if (!session || session.persist !== "host") {
    return {
      warning: `kept the raw flow-execute step — run: composition is host-resolved, so a remote recording can't reference "${name}" portably`,
    };
  }
  try {
    assertSafeFlowName(name);
    // Resolve against the recording's own flows dir (the running flow-execute
    // may have mutated the active-project-root global), not getFlowsDir().
    const fragPath = path.join(path.dirname(session.filePath), `${name}.yaml`);
    const fragment = parseFlow(await fs.readFile(fragPath, "utf8"));
    if (isE2eFlow(fragment)) {
      return {
        warning: `"${name}" is an e2e flow (declares launch); only fragments compose via run: — kept the raw flow-execute step`,
      };
    }
    return { flow: name };
  } catch (err) {
    return {
      warning: `could not resolve "${name}" as a sibling fragment (${err instanceof Error ? err.message : String(err)}); kept the raw flow-execute step`,
    };
  }
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

      // Running a fragment via flow-execute mid-recording is recorded as a
      // `run:` composition directive rather than a raw, non-portable tool call.
      const session = getRecordingSession();
      const runTarget =
        params.command === RUN_TARGET_COMMAND && params.delayMs === undefined
          ? await captureRunTarget(session, args)
          : undefined;

      let step: FlowStep;
      let warning: string | undefined;
      if (captured?.selector) {
        step = { kind: "tap", selector: captured.selector };
      } else if (isTap) {
        // No stable selector — keep a coordinate tap, but still as a `tap:`
        // directive so every tap reads uniformly.
        step = { kind: "tap", x: args.x as number, y: args.y as number };
        warning = captured?.warning;
      } else if (runTarget?.flow) {
        step = { kind: "run", flow: runTarget.flow };
      } else {
        warning = runTarget?.warning;
        // The step ran live with the full args (incl. the device id), but the
        // recorded form drops the device id so the flow stays portable — the
        // runner injects whatever device it resolves at replay.
        step = {
          kind: "tool",
          name: params.command,
          args: stripDeviceKeys(args),
          delayMs: params.delayMs,
        };
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
