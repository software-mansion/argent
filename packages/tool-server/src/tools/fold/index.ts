import { z } from "zod";
import {
  FAILURE_CODES,
  FailureError,
  type ToolCapability,
  type ToolDefinition,
} from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { resolveDevice } from "../../utils/device-info";
import { fetchDisplayState, postHinge, type HingeRequest } from "../../utils/simulator-client";
import { sleepOrAbort } from "../../utils/timing";
import {
  awaitActiveScreen,
  HAND_OVER_TIMEOUT_MS,
  INPUT_READY_HOLD_MID_ANGLE_MS,
  INPUT_READY_HOLD_MS,
  MAIN_SCREEN_ID,
  panelForHingeAngle,
  panelName,
  refreshActiveScreen,
  screenLabel,
  SETTLE_TIMEOUT_MS,
  type ActiveScreenState,
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
        "Where the hinge is now, as an angle or a posture. Normally left out: argent starts the sweep on the panel the device renders to. Pass it to name the exact angle something other than argent (Device Hub) left the hinge at."
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

function targetAngle(params: Params): number {
  return params.angle ?? POSTURE_ANGLE[params.posture ?? "closed"];
}

/**
 * Where to tell the server the hinge is, when the caller did not say.
 *
 * The server sweeps from the angle it last set, or from closed when it never
 * did, and it cannot read the hinge back. When that start lies on the other
 * panel than the device renders to — a server that never moved the hinge of a
 * device left open, or a fold made outside argent (Device Hub) since the last
 * one — the sweep would cross the hand-over on its way and flip the panel
 * twice, and the first flip is what a wait for the new panel would latch. So
 * the sweep starts on the device's own panel instead: closed for the cover
 * panel, open for the inner one. The exact angle is not known and does not
 * matter, since only the crossing counts. A start that agrees with the device
 * is kept: it is the more precise of the two.
 */
function sweepStartFor(
  serverAngle: number | null,
  live: ActiveScreenState
): HingeRequest["from"] | undefined {
  const start = serverAngle ?? POSTURE_ANGLE.closed;
  if (panelForHingeAngle(start, live.panels) === live.activeScreen) return undefined;
  return live.activeScreen === MAIN_SCREEN_ID ? "closed" : "open";
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
  description: `Fold or unfold a foldable iOS simulator (the iPhone Duo): move its hinge to a \`posture\` (closed, half-open, open) or an \`angle\` (0-180°), then wait until the device renders to the panel that posture implies and takes input again, so the next tap lands (about 0.5 s after the sweep for closed and open, about 1.5 s for any other angle, half-open included).
Closed, the device renders to the cover panel (screen 1, 1398x2034 px on the Duo); half-open and open, to the inner panel (screen 3, 2007x2853 px). The other panel is black. Argent names the live panel on every screenshot, describe, touch and stream, so the tools follow the fold — but their coordinate space changes with it: re-run \`describe\` (or read the element tree appended to this result) before tapping, and expect \`screenshot\` to change size. Unfolded, the UI runs landscape on the inner panel's portrait-native framebuffer; frames and touch coordinates stay in that native space, like landscape on any iPhone.
The sweep starts on the panel the device renders to, read fresh, so a fold made outside argent (Device Hub) needs no \`from\`; pass \`from\` only to name the exact angle the hinge was left at. A fold during a gesture is not supported: the gesture completes on the screen it started on.
Returns { activeScreen, screen: { id, panel, width, height }, posture, hingeAngle }. Fails when the device has not switched to the expected panel 6 s after the sweep, on a device that is not foldable (the server's own message), on a remote simulator, and on a simulator-server build that predates foldables.`,
  searchHint: "fold unfold hinge foldable duo posture open closed half-open panel screen",
  zodSchema,
  capability,
  services: (params) => ({
    simulatorServer: simulatorServerRef(resolveDevice(params.udid)),
  }),
  async execute(services, params, ctx) {
    const api = services.simulatorServer as SimulatorServerApi;
    const udid = params.udid;
    const signal = ctx?.signal
      ? AbortSignal.any([ctx.signal, AbortSignal.timeout(HINGE_REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(HINGE_REQUEST_TIMEOUT_MS);

    // Both ends of the sweep are read fresh. The server's state says where it
    // will start (the angle it last set; null when it never did or when
    // another client moved the hinge since), and CoreDevice says which panel
    // the device renders to now — the memo may date from before a fold made
    // outside argent. A server without the display route answers null and is
    // left to reject the hinge itself.
    const known = (await fetchDisplayState(api, signal)) ?? api.display;
    const before = known?.foldable ? await refreshActiveScreen(udid) : null;

    const request = hingeRequest(params);
    if (request.from === undefined && known && before) {
      const start = sweepStartFor(known.hingeAngle, before);
      if (start !== undefined) request.from = start;
    }
    const display = await postHinge(api, request, signal);
    // A server that answered the hinge is a server with panels: a fold tool
    // resolved before the factory's probe ran would otherwise keep naming no
    // screen. The angle it now holds is the one the next fold starts from.
    if (display.foldable) api.display = display;

    const angle = targetAngle(params);
    const hingeAngle = display.hingeAngle ?? angle;
    const posture = params.posture ?? postureForAngle(hingeAngle);
    const panels = display.panels.length > 0 ? display.panels : (before?.panels ?? []);

    // The guest hands over to the other panel 0.5-1.1 s after the sweep, longer
    // when busy; the server does not wait for it, so the client does, by
    // re-reading CoreDevice until it reports the panel the target angle
    // implies. An angle near the hand-over implies no panel: there any change
    // from where the device was is the answer, and so is none.
    const expected = panelForHingeAngle(angle, panels);
    const settled =
      expected !== undefined
        ? await awaitActiveScreen(udid, (s) => s.activeScreen === expected, {
            timeoutMs: HAND_OVER_TIMEOUT_MS,
          })
        : await awaitActiveScreen(
            udid,
            (s) => before !== null && s.activeScreen !== before.activeScreen,
            { timeoutMs: SETTLE_TIMEOUT_MS }
          );

    if (settled && expected !== undefined && settled.activeScreen !== expected) {
      throw new FailureError(
        `Fold to ${targetLabel(params)} was sent, but ${HAND_OVER_TIMEOUT_MS / 1000} s later ` +
          `CoreDevice still reports ${screenLabel(settled.activeScreen, panels)} as the panel the ` +
          `device renders to, not ${screenLabel(expected, panels)}. Commands target the panel ` +
          `CoreDevice reports; take a screenshot to see the screen, and pass \`from\` with the angle ` +
          `the hinge was really at if something other than argent moved it.`,
        {
          error_code: FAILURE_CODES.IOS_FOLD_FAILED,
          failure_stage: "simulator_hinge_hand_over_timeout",
          failure_area: "tool_server",
          error_kind: "timeout",
        }
      );
    }

    // The guest takes no input for a while after the hinge moves, hand-over or
    // not, and for longer when the hinge stops anywhere but closed or open
    // (see the constants). CoreDevice does not report that, so the tool holds
    // the measured time before it answers.
    const atStop = angle <= POSTURE_ANGLE.closed || angle >= POSTURE_ANGLE.open;
    await sleepOrAbort(atStop ? INPUT_READY_HOLD_MS : INPUT_READY_HOLD_MID_ANGLE_MS, ctx?.signal);

    const activeScreen = settled?.activeScreen ?? before?.activeScreen ?? MAIN_SCREEN_ID;

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
