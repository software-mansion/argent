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
  awaitLivePanel,
  HAND_OVER_TIMEOUT_MS,
  holdLivePanel,
  INPUT_READY_HOLD_MID_ANGLE_MS,
  INPUT_READY_HOLD_MS,
  MAIN_SCREEN_ID,
  panelForHingeAngle,
  panelName,
  resolveLivePanel,
  screenLabel,
  SETTLE_TIMEOUT_MS,
  unresolvedPanelNote,
  type FoldablePanel,
  type LivePanel,
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
   * Set when the panel the device renders to could not be resolved after the
   * sweep, or when the device kept rendering to a panel other than the one
   * the sweep implied.
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
  return request;
}

function targetLabel(params: Params): string {
  return params.posture ?? `${params.angle}°`;
}

function targetAngle(params: Params): number {
  return params.angle ?? POSTURE_ANGLE[params.posture ?? "closed"];
}

/** The stop a sweep is started from when the tool names one (see `sweepStartFor`). */
type SweepStart = "closed" | "open";

/** A stop of the hinge: closed or open, where the guest settles fastest and hands over predictably. */
function atStop(angle: number): boolean {
  return angle <= POSTURE_ANGLE.closed || angle >= POSTURE_ANGLE.open;
}

/**
 * Where to tell the server the hinge is.
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
  liveScreen: number,
  panels: readonly FoldablePanel[]
): SweepStart | undefined {
  const start = serverAngle ?? POSTURE_ANGLE.closed;
  if (panelForHingeAngle(start, panels) === liveScreen) return undefined;
  return liveScreen === MAIN_SCREEN_ID ? "closed" : "open";
}

/**
 * The angle the sweep starts at: the start the tool named (see
 * `sweepStartFor`), else the angle the server last set, else closed, where a
 * server that never moved the hinge starts. With the target, decides whether
 * the outcome is predicted (see `panelForHingeAngle`).
 */
function sweepStartAngle(start: SweepStart | undefined, serverAngle: number | null): number {
  if (start !== undefined) return POSTURE_ANGLE[start];
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
  description: `Move the hinge of a foldable iOS simulator (the iPhone Duo) to a \`posture\` (closed, half-open, open) or to an \`angle\` (0-180°). The tool returns when the device accepts input again, so the next tap lands.
Use when you must see or test an app in a different posture: closed shows the cover panel, half-open and open show the inner panel. \`list-devices\` marks foldable simulators with \`foldable: true\`. To turn a device without a fold, use \`rotate\`.
All tools use the active panel (the panel that shows the UI), also after a fold made outside argent. The coordinates and the screenshot size change with the panel. Before you tap, read the element tree in this result or run \`describe\` again. Unfolded, the UI is landscape, as on a rotated iPhone.
A fold between two angles that are not closed or open can keep the current panel. To change panels, fold to closed or open.
Returns { activeScreen, screen: { id, panel, width, height }, posture?, hingeAngle, warning? }. screen names the active panel and gives its size in pixels. posture is set only at 0°, 120° and 180°. warning is set when argent cannot find the active panel, or when the device did not change to the expected panel.
Fails if the device is not foldable or is a remote simulator.`,
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

    // Both ends of the sweep are read now. The server's state says where it
    // will start (the angle it last set; null when it never did or when
    // another client moved the hinge since), and the live panel says which
    // panel the device renders to, whoever moved the hinge last. A server
    // without the display route answers null and is left to reject the hinge
    // itself; a device whose panel nothing can name starts the sweep where
    // the server has the hinge.
    const known = (await fetchDisplayState(api, signal)) ?? api.display;
    const before = known?.foldable ? await resolveLivePanel(udid) : null;
    const beforeScreen = before && before.source !== "unknown" ? before.screen : undefined;

    const request = hingeRequest(params);
    let start: SweepStart | undefined;
    if (known && beforeScreen !== undefined) {
      start = sweepStartFor(known.hingeAngle, beforeScreen, known.panels);
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
    const panels = display.panels.length > 0 ? display.panels : (known?.panels ?? []);

    // The guest hands over to the other panel 1.5-2 s after the sweep, longer
    // when busy; the server does not wait for it, so the client does, by
    // resolving the live panel until it changes. Which panel to wait for is
    // predicted when either end of the sweep is a stop (closed or open): a
    // sweep that ends at a stop lands on that stop's panel whatever its start,
    // and one from a stop is predicted by where it ends. Only a sweep between
    // two angles short of the stops may leave the panel where it was, and
    // there — as at an angle near the hand-over — any change from where the
    // device was is the answer, and so is none.
    const startAngle = sweepStartAngle(start, known?.hingeAngle ?? null);
    const expected =
      atStop(angle) || atStop(startAngle) ? panelForHingeAngle(angle, panels) : undefined;
    let settled: LivePanel | null =
      expected !== undefined
        ? await awaitLivePanel(udid, (screen) => screen === expected, {
            timeoutMs: HAND_OVER_TIMEOUT_MS,
            signal: ctx?.signal,
          })
        : await awaitLivePanel(
            udid,
            (screen) => beforeScreen !== undefined && screen !== beforeScreen,
            { timeoutMs: SETTLE_TIMEOUT_MS, signal: ctx?.signal }
          );

    // The guest takes no input for a while after the hinge moves, hand-over or
    // not, and for longer when the hinge stops anywhere but closed or open
    // (see the constants). No source reports that, so the tool holds the
    // measured time before it answers — still watching the panel, since a
    // hand-over near the threshold can be transient and would otherwise be
    // taken by the wait above.
    settled = await holdLivePanel(
      udid,
      settled,
      atStop(angle) ? INPUT_READY_HOLD_MS : INPUT_READY_HOLD_MID_ANGLE_MS,
      { signal: ctx?.signal }
    );

    // What the tools target: the last panel resolved, else the main screen,
    // which is what every command falls back to while nothing answers.
    const activeScreen = settled?.screen ?? MAIN_SCREEN_ID;

    let warning: string | undefined;
    if (!settled) {
      const reason =
        before?.source === "unknown"
          ? before.reason
          : "neither the accessibility service nor CoreDevice answered after the sweep";
      warning =
        `${unresolvedPanelNote(udid, reason, "commands target", panels)} ` +
        "Take a screenshot to see the screen.";
    } else if (expected !== undefined && settled.screen !== expected) {
      // A stop is the target that switches panels by itself; a mid angle is
      // reached through one.
      const advice = atStop(angle)
        ? "Fold again if the device did not switch; a screenshot shows what it renders."
        : "To switch panels, fold to closed or open first, then to the angle wanted.";
      warning =
        `The hinge was swept to ${targetLabel(params)}, but the device kept rendering to ` +
        `${screenLabel(activeScreen, panels)} rather than switching to ${screenLabel(expected, panels)}. ` +
        `Commands target the panel the device renders to. ${advice}`;
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
