import { z } from "zod";
import type { ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import {
  physicalIosAutomationRef,
  type PhysicalIosAutomationApi,
} from "../../blueprints/physical-ios-automation";
import { isPhysicalIos, resolveDevice } from "../../utils/device-info";
import { sendTouchEvent } from "../../utils/gesture-utils";
import { sleep } from "../../utils/timing";

const zodSchema = z.object({
  udid: z.string().describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
  centerX: z
    .number()
    .describe(
      "Center of pinch, horizontal: normalized 0.0–1.0 (fraction of screen width, not pixels)"
    ),
  centerY: z
    .number()
    .describe(
      "Center of pinch, vertical: normalized 0.0–1.0 (fraction of screen height, not pixels)"
    ),
  startDistance: z
    .number()
    .describe(
      "Initial distance between the two fingers: normalized 0.0–1.0 (fraction of screen, not pixels). " +
        "E.g. 0.2 = fingers 20% of screen apart. " +
        "Use a larger startDistance than endDistance to pinch in (zoom out)."
    ),
  endDistance: z
    .number()
    .describe(
      "Final distance between the two fingers: normalized 0.0–1.0 (fraction of screen, not pixels). " +
        "E.g. 0.6 = fingers 60% of screen apart. " +
        "Use a larger endDistance than startDistance to pinch out (zoom in)."
    ),
  angle: z
    .number()
    .optional()
    .describe("Axis angle in degrees along which the fingers are placed (default 0 = horizontal)."),
  durationMs: z
    .number()
    .optional()
    .describe("Total gesture duration in milliseconds (default 300)"),
});

type Params = z.infer<typeof zodSchema>;

interface Result {
  pinched: boolean;
  timestampMs: number;
}

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
};

export const gesturePinchTool: ToolDefinition<Params, Result> = {
  id: "gesture-pinch",
  description: `Execute a pinch-to-zoom gesture by moving two fingers toward or away from a center point to change the scale of on-screen content. All positions and distances are normalized 0.0–1.0 (fractions of screen width/height, not pixels)—same coordinate space as gesture-tap and gesture-swipe.
startDistance > endDistance = pinch in (zoom out). startDistance < endDistance = pinch out (zoom in).
Typical values: startDistance 0.2, endDistance 0.6 for a zoom-in pinch at screen center.
Auto-generates interpolated frames at ~60fps. The angle parameter controls the axis (0 = horizontal, 90 = vertical).
Use when you need to zoom in or out on a map, image, or zoomable view. Returns { pinched: true, timestampMs }. Fails if the simulator-server / emulator backend is not reachable for the given device.`,
  zodSchema,
  capability,
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.udid);
    return isPhysicalIos(device)
      ? { physicalIos: physicalIosAutomationRef(device) }
      : { simulatorServer: simulatorServerRef(device) };
  },
  async execute(services, params) {
    const duration = params.durationMs ?? 300;
    const steps = Math.max(1, Math.round(duration / 16));
    const angleDeg = params.angle ?? 0;
    const angleRad = (angleDeg * Math.PI) / 180;
    const cosA = Math.cos(angleRad);
    const sinA = Math.sin(angleRad);

    let timestampMs = 0;
    const physicalEvents: Array<{
      type: "Down" | "Move" | "Up";
      x: number;
      y: number;
      x2: number;
      y2: number;
      delayMs: number;
    }> = [];

    const physical = isPhysicalIos(resolveDevice(params.udid));
    const api = physical ? undefined : (services.simulatorServer as SimulatorServerApi);

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const dist = params.startDistance + (params.endDistance - params.startDistance) * t;
      const halfDist = dist / 2;

      const x1 = params.centerX - halfDist * cosA;
      const y1 = params.centerY - halfDist * sinA;
      const x2 = params.centerX + halfDist * cosA;
      const y2 = params.centerY + halfDist * sinA;

      const type = i === 0 ? "Down" : i === steps ? "Up" : "Move";
      if (i === 0) timestampMs = Date.now();

      if (physical) {
        physicalEvents.push({ type, x: x1, y: y1, x2, y2, delayMs: i === 0 ? 0 : 16 });
      } else {
        sendTouchEvent(api!, type, x1, y1, x2, y2);
        if (i < steps) await sleep(16);
      }
    }

    if (physical) {
      await (services.physicalIos as PhysicalIosAutomationApi).touch(physicalEvents);
    }

    return { pinched: true, timestampMs };
  },
};
