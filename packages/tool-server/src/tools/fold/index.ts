import { z } from "zod";
import {
  FAILURE_CODES,
  FailureError,
  getFailureSignal,
  type ToolCapability,
  type ToolDefinition,
} from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { resolveDevice } from "../../utils/device-info";
import {
  fetchDisplayState,
  postHinge,
  type HingeRequest,
  type SimulatorDisplayState,
} from "../../utils/simulator-client";
import {
  activeScreenOrMain,
  awaitActiveScreen,
  HAND_OVER_TIMEOUT_MS,
  holdActiveScreen,
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
  /**
   * The posture preset the hinge sits at: `closed` (0°), `half-open` (120°) or
   * `open` (180°). Absent at any other angle, where `hingeAngle` says where
   * the hinge is and `activeScreen` which panel that left live.
   */
  posture?: Posture;
  /** The angle the hinge was swept to. */
  hingeAngle: number;
  /**
   * Set when the active panel could not be confirmed after the sweep, or when
   * the device kept rendering to a panel other than the one the sweep implied.
   */
  warning?: string;
}

const capability: ToolCapability = {
  // Local simulators only. A remote (MoQ) simulator is driven on its main
  // screen and carries no hinge message; the server itself rejects a device
  // that is not foldable, with its own reason.
  apple: { simulator: true },
};

/** The posture preset at exactly `angle`, if one sits there. */
function presetAtAngle(angle: number): Posture | undefined {
  return POSTURES.find((p) => POSTURE_ANGLE[p] === angle);
}

/**
 * A refusal from a server that reported the device as not foldable answers a
 * request the device cannot serve: the caller's mistake, not a server failure.
 * The message stays the server's own reason; only the classification changes.
 */
function classifyHingeRefusal(
  err: unknown,
  known: SimulatorDisplayState | null | undefined
): unknown {
  if (known?.foldable !== false) return err;
  if (getFailureSignal(err)?.error_code !== FAILURE_CODES.IOS_FOLD_FAILED) return err;
  return new FailureError(
    err instanceof Error ? err.message : String(err),
    {
      error_code: FAILURE_CODES.IOS_FOLD_UNSUPPORTED,
      failure_stage: "simulator_hinge_not_foldable",
      failure_area: "tool_server",
      error_kind: "unsupported",
    },
    err instanceof Error ? { cause: err } : undefined
  );
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

/** A stop of the hinge: closed or open, where the guest settles fastest and hands over predictably. */
function atStop(angle: number): boolean {
  return angle <= POSTURE_ANGLE.closed || angle >= POSTURE_ANGLE.open;
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

/**
 * The angle the sweep starts at: the caller's `from`, else the angle the
 * server last set, else closed, where a server that never moved the hinge
 * starts. Decides whether the outcome is predicted at all (see
 * `panelForHingeAngle`).
 */
function sweepStartAngle(from: HingeRequest["from"], serverAngle: number | null): number {
  if (typeof from === "number") return from;
  if (from !== undefined) return POSTURE_ANGLE[from];
  return serverAngle ?? POSTURE_ANGLE.closed;
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
  description: `Move the hinge of a foldable iOS simulator (the iPhone Duo) to a \`posture\` (closed, half-open, open) or an \`angle\` (0-180°), folding or unfolding it, then wait until the device has settled on the panel it renders to and takes input again, so the next tap lands (about 0.5 s after the sweep for closed and open, about 1.5 s for any other angle, half-open included).
Use when an app has to be seen or driven in another posture: on the cover panel (closed), on the inner panel (open), or half-open. \`list-devices\` marks the foldable simulators with \`foldable: true\`; \`rotate\` turns a device without folding it.
Closed, the device renders to the cover panel (screen 1, 1398x2034 px on the Duo); half-open and open, to the inner panel (screen 3, 2007x2853 px). The other panel is black. Argent names the live panel on every screenshot, describe, touch and stream, so the tools follow the fold — but their coordinate space changes with it: re-run \`describe\` (or read the element tree appended to this result) before tapping, and expect \`screenshot\` to change size. Unfolded, the UI runs landscape on the inner panel's portrait-native framebuffer; frames and touch coordinates stay in that native space, like landscape on any iPhone.
The device switches panels on a sweep from closed or open past its own threshold (about 75-90°); a sweep between two angles short of those stops leaves it on the panel it had. The result reports the panel the device renders to either way, with a \`warning\` when that is not the panel the sweep implied — fold to closed or open first to switch panels.
The sweep starts on the panel the device renders to, read fresh, so a fold made outside argent (Device Hub) needs no \`from\`; pass \`from\` only to name the exact angle the hinge was left at. A fold during a gesture is not supported: the gesture completes on the screen it started on.
Returns { activeScreen, screen: { id, panel, width, height }, posture?, hingeAngle, warning? }; posture is set only when the hinge sits at a preset (0°, 120°, 180°). Fails on a device that is not foldable (the server's own message), on a remote simulator, and on a simulator-server build that predates foldables.`,
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
    let display: SimulatorDisplayState;
    try {
      display = await postHinge(api, request, signal);
    } catch (err) {
      throw classifyHingeRefusal(err, known);
    }
    // A server that answered the hinge is a server with panels: a fold tool
    // resolved before the factory's probe ran would otherwise keep naming no
    // screen. The angle it now holds is the one the next fold starts from.
    if (display.foldable) api.display = display;

    const angle = targetAngle(params);
    const hingeAngle = display.hingeAngle ?? angle;
    const posture = params.posture ?? presetAtAngle(hingeAngle);
    const panels = display.panels.length > 0 ? display.panels : (before?.panels ?? []);

    // The guest hands over to the other panel 0.5-1.5 s after the sweep, longer
    // when busy; the server does not wait for it, so the client does, by
    // re-reading CoreDevice. Which panel to wait for is only predicted for a
    // sweep from a stop (closed or open): one that starts mid-way may leave
    // the panel where it was, and there — as at an angle near the hand-over —
    // any change from where the device was is the answer, and so is none.
    const startAngle = sweepStartAngle(request.from, known?.hingeAngle ?? null);
    const expected = atStop(startAngle) ? panelForHingeAngle(angle, panels) : undefined;
    let settled =
      expected !== undefined
        ? await awaitActiveScreen(udid, (s) => s.activeScreen === expected, {
            timeoutMs: HAND_OVER_TIMEOUT_MS,
            signal: ctx?.signal,
          })
        : await awaitActiveScreen(
            udid,
            (s) => before !== null && s.activeScreen !== before.activeScreen,
            { timeoutMs: SETTLE_TIMEOUT_MS, signal: ctx?.signal }
          );

    // The guest takes no input for a while after the hinge moves, hand-over or
    // not, and for longer when the hinge stops anywhere but closed or open
    // (see the constants). CoreDevice does not report that, so the tool holds
    // the measured time before it answers — still watching the panel, since a
    // hand-over near the threshold can be transient and would otherwise be
    // latched by the wait above.
    settled = await holdActiveScreen(
      udid,
      settled,
      atStop(angle) ? INPUT_READY_HOLD_MS : INPUT_READY_HOLD_MID_ANGLE_MS,
      { signal: ctx?.signal }
    );

    // What the tools target: the last read, or the memo a failed read left in
    // place — never the main screen while the memo says otherwise.
    const activeScreen = settled?.activeScreen ?? activeScreenOrMain(udid);

    let warning: string | undefined;
    if (!settled) {
      warning =
        "CoreDevice did not report which panel the device renders to after the fold; " +
        `commands target ${screenLabel(activeScreen, panels)} until a later read succeeds. ` +
        "Take a screenshot to see the screen.";
    } else if (expected !== undefined && settled.activeScreen !== expected) {
      warning =
        `The hinge was swept to ${targetLabel(params)}, but the device kept rendering to ` +
        `${screenLabel(activeScreen, panels)} rather than switching to ${screenLabel(expected, panels)}. ` +
        `Commands target the panel the device renders to. To switch panels, fold to closed or open ` +
        `first, then to the angle wanted; if something other than argent moved the hinge, pass ` +
        "`from` with the angle it was really at.";
    }

    return {
      activeScreen,
      screen: screenResult(activeScreen, panels),
      ...(posture ? { posture } : {}),
      hingeAngle,
      ...(warning ? { warning } : {}),
    };
  },
};
