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
} from "../../utils/ios-device/runner-commands";
import { isIosPhysicalDevice, resolveDevice } from "../../utils/device-info";
import { InvalidToolInputError } from "../../utils/capability";
import { sendCommand } from "../../utils/simulator-client";
import { interpolateEvents } from "../../utils/gesture-utils";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const eventSchema = z.object({
  type: z.enum(["Down", "Move", "Up"]).describe("Touch event type"),
  x: z.number().describe("Normalized x 0.0–1.0 (not pixels; same as tap/swipe)"),
  y: z.number().describe("Normalized y 0.0–1.0 (not pixels; same as tap/swipe)"),
  x2: z
    .number()
    .optional()
    .describe("Second touch x for two-finger gestures: normalized 0.0–1.0 (not pixels)"),
  y2: z
    .number()
    .optional()
    .describe("Second touch y for two-finger gestures: normalized 0.0–1.0 (not pixels)"),
  delayMs: z
    .number()
    .optional()
    .describe("Delay before this event in milliseconds (default 16ms ≈ 60fps)"),
});

const zodSchema = z.object({
  udid: z.string().describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
  events: z
    .array(eventSchema)
    .describe(
      "Sequence of touch events; x/y (and optional second touch) are normalized 0.0–1.0, not pixels"
    ),
  interpolate: z
    .number()
    .optional()
    .describe(
      "Number of intermediate Move events to auto-insert between each pair of consecutive events. " +
        "Smooths out gestures by linearly interpolating both primary (x,y) and secondary (x2,y2) coordinates. " +
        "The delay is split evenly across interpolated frames. Default: no interpolation."
    ),
});

type Params = z.infer<typeof zodSchema>;

interface Result {
  events: number;
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

type IosDeviceGesturePlan =
  | { kind: "gesture"; down: GestureEvent; hold?: GestureEvent; up: GestureEvent }
  | { kind: "unsupported"; reason: string };

function samePoint(a: GestureEvent, b: GestureEvent): boolean {
  return Math.abs(a.x - b.x) <= SAME_POINT_EPSILON && Math.abs(a.y - b.y) <= SAME_POINT_EPSILON;
}

/**
 * Map a custom event train to a runner gesture, or the reason it cannot run.
 *
 * XCTest has no raw HID stream; its one drag primitive is press, then move.
 * Two trains replay faithfully. A Down followed by an Up: the Up's delayMs is
 * the rest at the Down point, then the finger moves and lifts (same point:
 * press-hold). The same with one Move at the Down point in between: the Move's
 * delayMs is the hold and the Up's delayMs the movement time, which is how a
 * list item is picked up with a long press and dragged.
 */
function planIosDeviceGesture(events: Params["events"]): IosDeviceGesturePlan {
  if (events.some((e) => e.x2 !== undefined || e.y2 !== undefined)) {
    return {
      kind: "unsupported",
      reason:
        "gesture-custom on a physical iOS device supports single-finger gestures only; " +
        "two-finger event trains (pinch/rotate) have no XCTest coordinate API.",
    };
  }
  const down = events[0];
  const up = events[events.length - 1];
  const hold = events.length === 3 ? events[1] : undefined;
  const pickup =
    down !== undefined && hold !== undefined && hold.type === "Move" && samePoint(down, hold);
  if (
    down === undefined ||
    up === undefined ||
    down.type !== "Down" ||
    up.type !== "Up" ||
    !(events.length === 2 || (events.length === 3 && pickup))
  ) {
    return {
      kind: "unsupported",
      reason:
        "gesture-custom on a physical iOS device supports a Down followed by an Up (same point = " +
        "press-hold; different points = drag, resting at the Down point for the Up's delayMs " +
        "before moving), optionally with one Move at the Down point in between (its delayMs is " +
        "the hold, the Up's delayMs the movement time: a long-press pickup). For scrolls use " +
        "gesture-swipe; other Move waypoints cannot be replayed through XCTest.",
    };
  }
  return { kind: "gesture", down, up, ...(pickup && hold ? { hold } : {}) };
}

async function runOnIosDevice(
  runner: IosDeviceRunnerApi,
  udid: string,
  events: Params["events"]
): Promise<Result> {
  const plan = planIosDeviceGesture(events);

  if (plan.kind === "unsupported") {
    throw new InvalidToolInputError(plan.reason);
  }

  const { down, hold, up } = plan;
  const bundleId = requireCurrentIosDeviceApp(udid);
  const viewport = await getViewport(runner, bundleId);
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

export const gestureCustomTool: ToolDefinition<Params, Result> = {
  id: "gesture-custom",
  interaction: {
    startedMsg: () => "Performing custom gesture",
    completedMsg: () => "Performed custom gesture",
    failedMsg: ({ failureSignal }) =>
      `Failed to perform custom gesture: ${failureSignal.error_code}`,
  },
  description: `Send a sequence of touch events for complex gestures.
Use for: long press, drag-and-drop, custom scroll, pinch (second touch point).
For simple taps use the gesture-tap tool. For straight-line scrolling use the gesture-swipe tool.
For pinch gestures use gesture-pinch. For rotation gestures use gesture-rotate.
All x/y values are normalized 0.0–1.0 (screen fractions, not pixels). delayMs controls the delay before each event (default 16ms ≈ 60fps).
Set interpolate to auto-generate smooth intermediate Move events between your keyframes.
Physical iOS: Down then Up only. Same point = press-hold. Other point = drag (Up delayMs = rest before the move). One Move at the Down point between them = long-press pickup (Move delayMs = hold, Up delayMs = move time). No second finger, no other waypoints; scroll with gesture-swipe.
Returns { events: number } with the total count of events dispatched. On physical iOS, reactivated: true = app was re-fronted; re-describe. Fails if the target device is not booted or an event type is invalid.

Example long-press at center:
  [{"type":"Down","x":0.5,"y":0.5},{"type":"Up","x":0.5,"y":0.5,"delayMs":800}]

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
  capability,
  // Declare the runner only for a train execute can replay. A rejected train must not pay a runner cold start.
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.udid);
    if (isIosPhysicalDevice(device)) {
      return planIosDeviceGesture(params.events).kind === "gesture"
        ? { iosDeviceRunner: iosDeviceRunnerRef(device) }
        : {};
    }
    return { simulatorServer: simulatorServerRef(device) };
  },
  async execute(services, params) {
    const device = resolveDevice(params.udid);
    if (isIosPhysicalDevice(device)) {
      return runOnIosDevice(
        services.iosDeviceRunner as IosDeviceRunnerApi,
        device.id,
        params.events
      );
    }
    const api = services.simulatorServer as SimulatorServerApi;
    const events =
      params.interpolate && params.interpolate > 0
        ? interpolateEvents(params.events, params.interpolate)
        : params.events;

    for (const event of events) {
      await sleep(event.delayMs ?? 16);
      await sendCommand(api, {
        cmd: "touch",
        type: event.type,
        x: event.x,
        y: event.y,
        second_x: event.x2 ?? null,
        second_y: event.y2 ?? null,
      });
    }
    return { events: events.length };
  },
};
