import { z } from "zod";
import type { ToolCapability, ToolDefinition } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { resolveDevice } from "../../utils/device-info";
import { postHinge, type HingeRequest } from "../../utils/simulator-client";
import {
  awaitActiveScreenSettled,
  ensureActiveScreen,
  MAIN_SCREEN_ID,
  panelName,
  type FoldablePanel,
} from "../../utils/foldable";

const POSTURES = ["closed", "half-open", "open"] as const;
type Posture = (typeof POSTURES)[number];

/** The hinge angle each posture preset stands for, as the server sweeps to it. */
const POSTURE_ANGLE: Record<Posture, number> = { "closed": 0, "half-open": 120, "open": 180 };

/**
 * The first hinge move after a server starts can take several seconds before
 * the hinge begins to move, and every move then takes about a second. The
 * request is answered once the sweep has been sent.
 */
const HINGE_REQUEST_TIMEOUT_MS = 30_000;

const zodSchema = z
  .object({
    udid: z
      .string()
      .describe("Target device id from `list-devices` (a foldable iOS simulator UDID)."),
    posture: z
      .enum(POSTURES)
      .optional()
      .describe(
        "Where to move the hinge: `closed` (0°, the cover panel), `half-open` (120°) or `open` (180°, the inner panel). Exactly one of `posture` and `angle`."
      ),
    angle: z
      .number()
      .min(0)
      .max(180)
      .optional()
      .describe(
        "The hinge angle in degrees, 0 (closed) to 180 (open). Exactly one of `posture` and `angle`."
      ),
    from: z
      .union([z.number().min(0).max(180), z.enum(POSTURES)])
      .optional()
      .describe(
        "Where the hinge is now, as an angle or a posture, when something other than argent moved it (Device Hub). The sweep starts there instead of at the angle argent last set; the path the hinge takes decides which panel the device ends on."
      ),
  })
  .refine((p) => (p.posture === undefined) !== (p.angle === undefined), {
    message: "Pass exactly one of `posture` and `angle`.",
  });

type Params = z.infer<typeof zodSchema>;

interface Result {
  /** CoreSimulator screen id of the panel the device renders to after the fold. */
  activeScreen: number;
  /** That panel, with its native pixel size: the size a `screenshot` at scale 1 has. */
  screen: { id: number; panel: string; width?: number; height?: number };
  /** `closed`, `half-open` or `open`, from the angle the hinge was moved to. */
  posture: Posture;
  /** The angle the hinge was swept to. */
  hingeAngle: number;
  /** Set when the active panel could not be confirmed after the sweep. */
  warning?: string;
}

const capability: ToolCapability = {
  // Local simulators only. A remote (MoQ) simulator is driven on its main
  // screen and carries no hinge message; the server itself rejects a device
  // that is not foldable, with its own reason.
  apple: { simulator: true },
};

/** A posture for the reported angle, matching the presets at their exact values. */
function postureForAngle(angle: number): Posture {
  if (angle <= 0) return "closed";
  if (angle >= 180) return "open";
  return "half-open";
}

function hingeRequest(params: Params): HingeRequest {
  const request: HingeRequest = {};
  if (params.posture !== undefined) request.posture = params.posture;
  if (params.angle !== undefined) request.angle = params.angle;
  if (params.from !== undefined) request.from = params.from;
  return request;
}

function targetLabel(params: Params): string {
  return params.posture ?? `${params.angle}°`;
}

function screenResult(
  activeScreen: number,
  panels: readonly FoldablePanel[] | undefined
): Result["screen"] {
  const panel = panels?.find((p) => p.screenId === activeScreen);
  return {
    id: activeScreen,
    panel: panelName(activeScreen),
    ...(panel ? { width: panel.width, height: panel.height } : {}),
  };
}

export const foldTool: ToolDefinition<Params, Result> = {
  id: "fold",
  interaction: {
    startedMsg: ({ params }) => `Folding device to ${targetLabel(params)}`,
    completedMsg: ({ params, result }) =>
      `Folded device to ${targetLabel(params)}; it renders to screen ${result.activeScreen} (${result.screen.panel})`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to fold device to ${targetLabel(params)}: ${failureSignal.error_code}`,
  },
  description: `Fold or unfold a foldable iOS simulator (the iPhone Duo): move its hinge to a \`posture\` (closed, half-open, open) or an \`angle\` (0-180°), then wait until the device has switched to the panel it renders to in that posture.
Closed, the device renders to the cover panel (screen 1, 1398x2034 px on the Duo); half-open and open, to the inner panel (screen 3, 2007x2853 px). The other panel is black. Argent names the live panel on every screenshot, describe, touch and stream, so the tools follow the fold — but their coordinate space changes with it: re-run \`describe\` (or read the element tree appended to this result) before tapping, and expect \`screenshot\` to change size. Unfolded, the UI runs landscape on the inner panel's portrait-native framebuffer; frames and touch coordinates stay in that native space, like landscape on any iPhone.
The hinge is swept from the angle argent last set. If something else moved it since (Device Hub), pass \`from\` so the sweep starts where the hinge really is; the path decides which panel the device ends on. A fold during a gesture is not supported: the gesture completes on the screen it started on.
Returns { activeScreen, screen: { id, panel, width, height }, posture, hingeAngle }. Fails on a device that is not foldable (the server's own message), on a remote simulator, and on a simulator-server build that predates foldables.`,
  searchHint: "fold unfold hinge foldable duo posture open closed half-open panel screen",
  zodSchema,
  capability,
  services: (params) => ({
    simulatorServer: simulatorServerRef(resolveDevice(params.udid)),
  }),
  async execute(services, params, ctx) {
    const api = services.simulatorServer as SimulatorServerApi;
    const udid = params.udid;

    // The panel before the fold is what "settled" is measured against. Read
    // through the memo: the server factory filled it for a foldable, and a
    // device that is not foldable has nothing to read.
    const before = api.display?.foldable
      ? (await ensureActiveScreen(udid))?.activeScreen
      : undefined;

    const request = hingeRequest(params);
    const signal = ctx?.signal
      ? AbortSignal.any([ctx.signal, AbortSignal.timeout(HINGE_REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(HINGE_REQUEST_TIMEOUT_MS);
    const display = await postHinge(api, request, signal);
    // A server that answered the hinge is a server with panels: a fold tool
    // resolved before the factory's probe ran would otherwise keep naming no
    // screen.
    if (display.foldable && !api.display) api.display = display;

    const hingeAngle =
      display.hingeAngle ?? params.angle ?? POSTURE_ANGLE[params.posture ?? "closed"];
    const posture = params.posture ?? postureForAngle(hingeAngle);

    // The guest hands over to the other panel 0.5-1.1 s after the sweep, longer
    // when busy; the server does not wait for it, so the client does, by
    // re-reading CoreDevice until the panel differs from where it started.
    const settled = await awaitActiveScreenSettled(udid, before);
    const activeScreen = settled?.activeScreen ?? before ?? MAIN_SCREEN_ID;
    const panels = settled?.panels ?? display.panels;

    return {
      activeScreen,
      screen: screenResult(activeScreen, panels),
      posture,
      hingeAngle,
      ...(settled
        ? {}
        : {
            warning:
              "CoreDevice did not report which panel the device renders to after the fold; " +
              `commands target screen ${activeScreen} (${panelName(activeScreen)}) until a later read succeeds. ` +
              "Take a screenshot to see the screen.",
          }),
    };
  },
};
