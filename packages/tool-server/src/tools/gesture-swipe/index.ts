import { z } from "zod";
import type { ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { coreDeviceRef, type CoreDeviceApi } from "../../blueprints/core-device";
import { resolveDevice, isPhysicalIos } from "../../utils/device-info";
import { sendCommand } from "../../utils/simulator-client";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const zodSchema = z.object({
  udid: z.string().describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
  fromX: z.number().describe("Start x: normalized 0.0–1.0 (not pixels; same as tap)"),
  fromY: z.number().describe("Start y: normalized 0.0–1.0 (not pixels; same as tap)"),
  toX: z.number().describe("End x: normalized 0.0–1.0 (not pixels; same as tap)"),
  toY: z.number().describe("End y: normalized 0.0–1.0 (not pixels; same as tap)"),
  durationMs: z
    .number()
    .optional()
    .describe("Total gesture duration in milliseconds (default 300)"),
});

type Params = z.infer<typeof zodSchema>;

interface Result {
  swiped: boolean;
  timestampMs: number;
}

// Touch platforms only. A desktop renderer has no touch swipe: a mouse drag
// selects text instead of scrolling, so Chromium callers use the dedicated
// `gesture-scroll` tool (wheel-based) and the capability gate rejects this
// one with a clear error rather than silently doing the wrong thing.
const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
};

export const gestureSwipeTool: ToolDefinition<Params, Result> = {
  id: "gesture-swipe",
  description: `Execute a smooth swipe / drag touch gesture between two points on the device (iOS simulator or Android emulator). All from/to positions are normalized 0.0–1.0 (fractions of screen width/height, not pixels), same as gesture-tap.
Generates interpolated Move events for a natural feel (~60fps).
Swipe up (fromY > toY) to scroll content down.
Use when you need to scroll a list, dismiss a modal, drag an element, or navigate between pages. Not supported on Chromium — use gesture-scroll there instead. Returns { swiped: true, timestampMs }. Fails if the simulator-server / emulator backend is not reachable for the given device.`,
  alwaysLoad: true,
  searchHint: "swipe scroll drag pan gesture device simulator emulator touch move",
  zodSchema,
  capability,
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.udid);
    if (isPhysicalIos(device)) {
      return { coreDevice: coreDeviceRef(device) };
    }
    return { simulatorServer: simulatorServerRef(device) };
  },
  async execute(services, params) {
    const duration = params.durationMs ?? 300;
    const timestampMs = Date.now();
    const device = resolveDevice(params.udid);
    if (isPhysicalIos(device)) {
      const coreDevice = services.coreDevice as CoreDeviceApi;
      await coreDevice.swipe(params.fromX, params.fromY, params.toX, params.toY, duration);
      return { swiped: true, timestampMs };
    }
    const api = services.simulatorServer as SimulatorServerApi;
    const steps = Math.max(1, Math.round(duration / 16));

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = params.fromX + (params.toX - params.fromX) * t;
      const y = params.fromY + (params.toY - params.fromY) * t;
      const type = i === 0 ? "Down" : i === steps ? "Up" : "Move";
      sendCommand(api, {
        cmd: "touch",
        type,
        x,
        y,
        second_x: null,
        second_y: null,
      });
      if (i < steps) await sleep(16);
    }

    return { swiped: true, timestampMs };
  },
};
