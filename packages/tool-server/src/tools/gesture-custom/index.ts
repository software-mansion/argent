import { z } from "zod";
import type { DeviceInfo, ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { resolveDevice } from "../../utils/device-info";
import { UnsupportedOperationError } from "../../utils/capability";
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
}

// Physical iPhones are in: the single-contact half of this tool (long press,
// drag-and-drop, custom scroll) is exactly the Down/Move/Up stream the CoreDevice
// digitizer takes. Only the `x2`/`y2` half is out of reach there, and that is
// rejected per-request below rather than by shutting the whole tool out.
const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
};

/**
 * Index of the first event carrying a second touch point on a device that has
 * only one contact, or -1.
 *
 * Checked across the whole sequence before the first event goes out: a rejection
 * partway through would leave the contact down on the device with no Up to
 * follow. Indexed against the caller's own `events`, not the interpolated
 * expansion, so the reported position is one they can find. Shared by `services`
 * and `execute` so both answer the same question about the same request.
 */
function secondTouchIndex(device: DeviceInfo, events: Params["events"]): number {
  if (device.platform !== "ios" || device.kind !== "device") return -1;
  return events.findIndex((e) => e.x2 !== undefined || e.y2 !== undefined);
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
Returns { events: number } with the total count of events dispatched. Fails if the target device is not booted or an event type is invalid.
On a physical iPhone the touchscreen takes one contact, so x2/y2 are rejected there; single-touch sequences work.

Example long-press at center:
  [{"type":"Down","x":0.5,"y":0.5},{"type":"Up","x":0.5,"y":0.5,"delayMs":800}]

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
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.udid);
    // A request execute() is going to reject outright resolves no service — the
    // same reason `button` returns {} for a button physical iOS cannot send, and
    // what makes run-sequence's "a physical-iOS sequence made only of unsupported
    // steps never brings up a CoreDevice session just to reject them" true. It is
    // not only a wasted spawn: the registry resolves services before execute, so
    // a device that cannot start its session would answer a two-contact request
    // with a transport error instead of "this gesture needs two contacts".
    if (secondTouchIndex(device, params.events) !== -1) return {};
    return { simulatorServer: simulatorServerRef(device) };
  },
  async execute(services, params) {
    const device = resolveDevice(params.udid);
    const secondTouchAt = secondTouchIndex(device, params.events);
    if (secondTouchAt !== -1) {
      throw new UnsupportedOperationError(
        "gesture-custom",
        device,
        `a second touch point (x2/y2, first at events[${secondTouchAt}]) needs two contacts, and CoreDevice exposes a single-contact touchscreen; ` +
          `single-touch sequences - long press, drag-and-drop, custom scroll - work`
      );
    }

    const api = services.simulatorServer as SimulatorServerApi;

    const events =
      params.interpolate && params.interpolate > 0
        ? interpolateEvents(params.events, params.interpolate)
        : params.events;

    for (const event of events) {
      await sleep(event.delayMs ?? 16);
      sendCommand(api, {
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
