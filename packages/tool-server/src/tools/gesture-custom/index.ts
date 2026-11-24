import { z } from "zod";
import type { ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { iosDeviceRunnerRef, type IosDeviceRunnerApi } from "../../blueprints/ios-device-runner";
import { requireCurrentIosDeviceApp } from "../../utils/ios-device/app-session";
import {
  dragBetween,
  getViewport,
  longPressAt,
  toPoints,
  touchPaths,
  type RunnerTouchFinger,
} from "../../utils/ios-device/runner-commands";
import { trainPaths } from "../../utils/ios-device/touch-paths";
import { isIosPhysicalDevice, resolveDevice } from "../../utils/device-info";
import { InvalidToolInputError } from "../../utils/capability";
import { sendCommand } from "../../utils/simulator-client";
import { HELD_TOUCH_TIMEOUT_MS, holdTouch, takeHeldTouch } from "../../utils/held-touch";
import { interpolateEvents } from "../../utils/gesture-utils";

import { screenEdges } from "../../utils/ui-orientation";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Result {
  events: number;
  /**
   * Simulator/emulator only: the train ended without an Up, so the finger is
   * still down. A later gesture-custom call lifts it. Set only when true.
   */
  held?: true;
  /**
   * Physical iOS only: the target app was backgrounded and the runner
   * re-fronted it to run this gesture, so the foreground screen changed as a
   * side effect. Set only when true.
   */
  reactivated?: true;
}

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
};

// Two Down/Up points within half a percent of the screen count as "the same
// place": a press-hold, not a drag. Covers float jitter in agent-authored
// coordinates without swallowing genuine short drags.
const SAME_POINT_EPSILON = 0.005;

type GestureEvent = Params["events"][number];

function liftCommand(event: GestureEvent): Record<string, unknown> {
  return {
    cmd: "touch",
    type: "Up",
    x: event.x,
    y: event.y,
    second_x: event.x2 ?? null,
    second_y: event.y2 ?? null,
  };
}

type IosDeviceGesturePlan =
  | { kind: "gesture"; down: GestureEvent; hold?: GestureEvent; up: GestureEvent }
  | { kind: "paths" }
  | { kind: "unsupported"; reason: string };

function samePoint(a: GestureEvent, b: GestureEvent): boolean {
  return Math.abs(a.x - b.x) <= SAME_POINT_EPSILON && Math.abs(a.y - b.y) <= SAME_POINT_EPSILON;
}

/**
 * Map a custom event train to the runner command that plays it.
 *
 * Two single-finger trains go through XCUICoordinate, which holds the finger
 * down before it moves in a way a long-press pickup needs. A Down followed by
 * an Up: the Up's delayMs is the rest at the Down point, then the finger moves
 * and lifts (same point: press-hold). The same with one Move at the Down point
 * in between: the Move's delayMs is the hold and the Up's delayMs the movement
 * time, which is how a list item is picked up with a long press and dragged.
 *
 * Every other train, a second finger or Move waypoints, plays as timed finger
 * paths through the runner's touch synthesizer. Only a train that is not a
 * Down, Moves, then an Up is refused.
 */
function planIosDeviceGesture(events: Params["events"]): IosDeviceGesturePlan {
  const down = events[0];
  const up = events[events.length - 1];
  if (
    down === undefined ||
    up === undefined ||
    events.length < 2 ||
    down.type !== "Down" ||
    up.type !== "Up" ||
    events.slice(1, -1).some((event) => event.type !== "Move")
  ) {
    return {
      kind: "unsupported",
      reason:
        "gesture-custom on a physical iOS device takes a Down, any number of Moves, then an Up " +
        "(a second finger rides along as x2/y2 on those events). Leaving a finger down " +
        "between calls works only on a simulator or emulator.",
    };
  }
  const twoFingers = events.some((e) => e.x2 !== undefined || e.y2 !== undefined);
  const hold = events.length === 3 ? events[1] : undefined;
  const pickup = hold !== undefined && hold.type === "Move" && samePoint(down, hold);
  if (twoFingers || !(events.length === 2 || (events.length === 3 && pickup))) {
    return { kind: "paths" };
  }
  return { kind: "gesture", down, up, ...(pickup && hold ? { hold } : {}) };
}

async function runOnIosDevice(
  runner: IosDeviceRunnerApi,
  udid: string,
  events: Params["events"],
  interpolate: number | undefined
): Promise<Result> {
  const plan = planIosDeviceGesture(events);

  if (plan.kind === "unsupported") {
    throw new InvalidToolInputError(plan.reason);
  }

  const bundleId = requireCurrentIosDeviceApp(udid);
  const viewport = await getViewport(runner, bundleId);

  if (plan.kind === "paths") {
    const played = interpolate && interpolate > 0 ? interpolateEvents(events, interpolate) : events;
    let fingers: RunnerTouchFinger[];
    try {
      fingers = trainPaths(played, viewport);
    } catch (error) {
      throw new InvalidToolInputError((error as Error).message);
    }
    const reply = await touchPaths(runner, bundleId, fingers);
    const reactivated = viewport.reactivated === true || reply.reactivated;
    return { events: events.length, ...(reactivated ? { reactivated: true as const } : {}) };
  }

  const { down, hold, up } = plan;
  // delayMs is the wait before an event with the finger where it was, so the
  // time before the finger leaves the Down point is the hold.
  const holdMs = hold ? (hold.delayMs ?? 16) : (up.delayMs ?? 16);
  const moveMs = hold ? (up.delayMs ?? 16) : undefined;

  const gesture = samePoint(down, up)
    ? await longPressAt(
        runner,
        bundleId,
        toPoints(viewport, down.x, down.y),
        holdMs + (moveMs ?? 0)
      )
    : await dragBetween(
        runner,
        bundleId,
        toPoints(viewport, down.x, down.y),
        toPoints(viewport, up.x, up.y),
        { holdMs, ...(moveMs !== undefined ? { durationMs: moveMs } : {}) }
      );
  // Either leg can be the one that re-fronted a backgrounded target: the
  // viewport read fronts it first, so the gesture then finds it foreground.
  const reactivated = viewport.reactivated === true || gesture.reactivated;

  return { events: events.length, ...(reactivated ? { reactivated: true as const } : {}) };
}

const eventSchema = z.object({
  type: z.enum(["Down", "Move", "Up"]).describe("Touch event type"),
  x: z.number().min(0).max(1).describe("Touch x."),
  y: z.number().min(0).max(1).describe("Touch y."),
  x2: z.number().min(0).max(1).optional().describe("Second finger x, for two-finger gestures."),
  y2: z.number().min(0).max(1).optional().describe("Second finger y, for two-finger gestures."),
  delayMs: z
    .number()
    .optional()
    .describe("Delay before this event in milliseconds (default 16ms ≈ 60fps)"),
});

const zodSchema = z.object({
  udid: z.string().describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
  edge: z
    .enum(screenEdges)
    .optional()
    .describe(
      "Starting edge in upright screen coordinates for a single-finger system gesture on a local iOS simulator."
    ),
  events: z.array(eventSchema).describe("Touch events, dispatched in order."),
  interpolate: z
    .number()
    .optional()
    .describe(
      "Number of Move events to insert between each pair of consecutive events, linearly interpolating " +
        "both x,y and x2,y2 and splitting the delay evenly, for a smooth gesture. Default: no interpolation."
    ),
});

type Params = z.infer<typeof zodSchema>;

function validateEdge(params: Params, device: ReturnType<typeof resolveDevice>) {
  if (params.edge === undefined) return;
  if (device.platform !== "ios" || device.kind !== "simulator") {
    throw new InvalidToolInputError("System-edge gestures require a local iOS simulator.");
  }
  const events = params.events;
  if (
    events[0]?.type !== "Down" ||
    events.at(-1)?.type !== "Up" ||
    events.slice(1, -1).some((e) => e.type !== "Move") ||
    events.some((e) => e.x2 !== undefined || e.y2 !== undefined)
  ) {
    throw new InvalidToolInputError(
      "A system-edge gesture takes one finger: Down, any Moves, then Up."
    );
  }
}

export const gestureCustomTool: ToolDefinition<Params, Result> = {
  id: "gesture-custom",
  description: `Send a sequence of touch events for complex gestures.
Use for: long press, drag-and-drop, custom scroll, pinch (second touch point).
For simple taps use the gesture-tap tool. For straight-line scrolling use the gesture-swipe tool.<flag:macos-apps> Not supported on a Mac app: use gesture-tap, gesture-drag and gesture-scroll there.</flag:macos-apps>
For pinch gestures use gesture-pinch. For rotation gestures use gesture-rotate.
On a local iOS simulator, set edge to the starting side for a system gesture. To move a full-screen app into Split View on an open Duo, set edge:"bottom". In one continuous contact move from bottom center to center, pause there, drag to the requested side, and release. See the device-interact foldables reference for coordinates and timing.
All x/y values are fractions of the screen width/height (not pixels).
Physical iOS: a Down, any Moves, then an Up; x2/y2 adds a second finger. A plain Down then Up: same point = press-hold, other point = drag (Up delayMs = rest before the move); one Move at the Down point between them = long-press pickup (Move delayMs = hold, Up delayMs = move time). Any other train plays as timed paths, each event waiting its delayMs, and needs the app drawn in portrait.
Simulator/emulator: a train that ends without an Up leaves the finger down and returns { held: true }, so screenshot, describe or await-ui-element can observe a pressed state. The next gesture-custom call continues that contact (start it with Move or Up); any new Down (this tool, gesture-tap, gesture-swipe) first lifts the held finger. Argent lifts a held finger after ${HELD_TOUCH_TIMEOUT_MS / 1000} s. Not with edge, not on physical iOS.
Returns { events: number } with the total count of events dispatched. On physical iOS, reactivated: true = app was re-fronted; re-describe. Fails if the target device is not booted or an event type is invalid.

Example long-press at center:
  [{"type":"Down","x":0.5,"y":0.5},{"type":"Up","x":0.5,"y":0.5,"delayMs":800}]

Example hold, observe, then release (simulator/emulator; two calls with a screenshot between):
  [{"type":"Down","x":0.5,"y":0.5}]  then  [{"type":"Up","x":0.5,"y":0.5}]

Example pick up a list item with a long press, then drag it up:
  [{"type":"Down","x":0.5,"y":0.6},{"type":"Move","x":0.5,"y":0.6,"delayMs":800},{"type":"Up","x":0.5,"y":0.3,"delayMs":500}]

Example smooth scroll down:
  [{"type":"Down","x":0.5,"y":0.7},
   {"type":"Move","x":0.5,"y":0.6},{"type":"Move","x":0.5,"y":0.5},{"type":"Move","x":0.5,"y":0.4},
   {"type":"Up","x":0.5,"y":0.3}]

Example pinch-to-zoom (with interpolate:10 for smoothness):
  events: [{"type":"Down","x":0.4,"y":0.5,"x2":0.6,"y2":0.5},
           {"type":"Up","x":0.2,"y":0.5,"x2":0.8,"y2":0.5}]
  interpolate: 10`,
  zodSchema,
  interaction: {
    startedMsg: () => "Performing custom gesture",
    completedMsg: () => "Performed custom gesture",
    failedMsg: ({ failureSignal }) =>
      `Failed to perform custom gesture: ${failureSignal.error_code}`,
  },
  capability,
  // A physical iPhone's first call waits out the runner build, past the MCP fetch timeout,
  // whose abort replays the call: the gesture would land once per replay.
  longRunning: true,
  // Declare the runner only for a train execute can play. A rejected train must not pay a runner cold start.
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.udid);
    validateEdge(params, device);
    if (isIosPhysicalDevice(device)) {
      return planIosDeviceGesture(params.events).kind !== "unsupported"
        ? { iosDeviceRunner: iosDeviceRunnerRef(device) }
        : {};
    }
    return { simulatorServer: simulatorServerRef(device) };
  },
  async execute(services, params) {
    const device = resolveDevice(params.udid);
    validateEdge(params, device);
    if (isIosPhysicalDevice(device)) {
      return runOnIosDevice(
        services.iosDeviceRunner as IosDeviceRunnerApi,
        device.id,
        params.events,
        params.interpolate
      );
    }
    const api = services.simulatorServer as SimulatorServerApi;
    const events =
      params.interpolate && params.interpolate > 0
        ? interpolateEvents(params.events, params.interpolate)
        : params.events;

    let warning: string | undefined;
    // The finger this call has down: one an earlier train left held, then the
    // last non-Up event this train sent. A train starting with Down gets a
    // held finger lifted by sendCommand before its Down goes out.
    let contact: GestureEvent | undefined =
      events[0]?.type === "Down" ? undefined : takeHeldTouch<GestureEvent>(device.id)?.contact;
    try {
      for (const event of events) {
        await sleep(event.delayMs ?? 16);
        const sent = await sendCommand(api, {
          ...(params.edge
            ? { cmd: "edgeTouch", edge: params.edge }
            : { cmd: "touch", second_x: event.x2 ?? null, second_y: event.y2 ?? null }),
          type: event.type,
          x: event.x,
          y: event.y,
        });
        contact = event.type === "Up" ? undefined : event;
        warning ??= sent.warning;
      }
    } catch (error) {
      if (contact) {
        // Release a contact that the device acknowledged before a later event failed.
        await sendCommand(
          api,
          params.edge
            ? { cmd: "edgeTouch", edge: params.edge, type: "Up", x: contact.x, y: contact.y }
            : liftCommand(contact)
        ).catch(() => {});
      }
      throw error;
    }
    if (contact) {
      const last = contact;
      holdTouch(device.id, {
        contact: last,
        release: () => sendCommand(api, liftCommand(last)),
      });
      return {
        events: events.length,
        held: true,
        ...(warning !== undefined ? { warning } : {}),
      };
    }
    return { events: events.length, ...(warning !== undefined ? { warning } : {}) };
  },
};
