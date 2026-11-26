import { z } from "zod";
import type { ServiceRef, ToolCapability, ToolContext, ToolDefinition } from "@argent/registry";
import { assertSupported } from "../../utils/capability";
import { resolveDevice } from "../../utils/device-info";
import {
  MACOS_HOVER_DURATION_MS,
  macosAppServices,
  macosHover,
  macosHoverLeave,
  requireMacosApp,
} from "../../utils/macos-input";

type Result = { hovered: true; timestampMs: number } | { left: true; timestampMs: number };

// Mac apps only: their in-app library keeps argent's pointer over the app
// between calls.
const capability: ToolCapability = {
  macos: { app: true, catalyst: true },
};

const MAX_DURATION_MS = 2000;

function hoverDescription(params: Params, tense: "present" | "past"): string {
  if (params.leave) {
    return `${tense === "present" ? "Moving" : "Moved"} the pointer out of the window`;
  }
  const at = `(${Math.round((params.x ?? 0) * 100)}%, ${Math.round((params.y ?? 0) * 100)}%)`;
  return `${tense === "present" ? "Hovering" : "Hovered"} at ${at}`;
}

const zodSchema = z
  .object({
    udid: z.string().describe("Mac app id from `list-devices` (macos-app-<bundle id>)."),
    x: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        "Horizontal position, a fraction of the area describe reports (0 = left edge, 1 = right edge). Required unless leave."
      ),
    y: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Vertical position (0 = top edge, 1 = bottom edge). Required unless leave."),
    durationMs: z
      .number()
      .int()
      .min(0)
      .max(MAX_DURATION_MS)
      .optional()
      .describe(
        `How long the pointer takes to glide to x/y from where argent last left it (default ${MACOS_HOVER_DURATION_MS}): a menu that reacts to the route sees the pointer cross what lies between. 0 jumps straight there.`
      ),
    leave: z
      .boolean()
      .optional()
      .describe(
        "true: move the pointer out of the window, which ends the hover, to see the un-hovered state. Takes no x, y or durationMs."
      ),
  })
  .refine(
    (p) =>
      p.leave === true
        ? p.x === undefined && p.y === undefined && p.durationMs === undefined
        : p.x !== undefined && p.y !== undefined,
    {
      message:
        "Pass x and y to hover over a point, or leave: true alone to move the pointer out of the window.",
    }
  );

type Params = z.infer<typeof zodSchema>;

export const gestureHoverTool: ToolDefinition<Params, Result> = {
  id: "gesture-hover",
  description: `Move the mouse pointer to a point of a Mac app and keep it there, so the app shows its hover state: a highlighted row, a button that appears on mouse-over, a submenu that opens. x/y are fractions of the area describe reports, as in gesture-tap.
Use when a control appears or changes only while the pointer is over something, e.g. a delete button on a hovered row.
The hover stays until the next gesture-tap, gesture-drag, gesture-scroll or gesture-hover (the pointer then hovers at that point), or until the user clicks, scrolls or types in the app. Check the hover effect in the returned element tree and screenshot, or wait for it with await-ui-element. Pass leave: true to see the un-hovered state. Tooltips do not appear (not supported).
Returns { hovered: true, timestampMs }, or { left: true, timestampMs } for leave. Fails with \`MACOS_APP_LIBRARY_OUTDATED\` when the app's argent library cannot hover: run restart-app, then hover again.`,
  zodSchema,
  searchHint:
    "hover mouse over mouseover pointer rollover mouseEnter mouse enter leave highlight reveal mac app",
  featureFlag: "macos-apps",
  interaction: {
    startedMsg: ({ params }) => hoverDescription(params, "present"),
    completedMsg: ({ params }) => hoverDescription(params, "past"),
    failedMsg: ({ params, failureSignal }) =>
      `Failed to ${params.leave ? "move the pointer out" : "hover"}: ${failureSignal.error_code}`,
  },
  capability,
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.udid);
    return device.platform === "macos" ? macosAppServices(device) : {};
  },
  async execute(services, params, ctx?: ToolContext) {
    const device = resolveDevice(params.udid);
    // A flow step skips the HTTP capability gate.
    assertSupported("gesture-hover", capability, device);
    const app = requireMacosApp(services, "gesture-hover", device);
    const timestampMs = Date.now();
    if (params.leave) {
      await macosHoverLeave(app);
      return { left: true, timestampMs };
    }
    // The refine guarantees both when leave is not set.
    await macosHover(app, params.x!, params.y!, {
      durationMs: params.durationMs,
      signal: ctx?.signal,
    });
    return { hovered: true, timestampMs };
  },
};
