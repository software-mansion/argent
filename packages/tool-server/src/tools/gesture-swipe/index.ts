import { z } from "zod";
import type { ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { electronCdpRef, type ElectronCdpApi } from "../../blueprints/electron-cdp";
import { resolveDevice } from "../../utils/device-info";
import { sendCommand } from "../../utils/simulator-client";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const zodSchema = z.object({
  udid: z
    .string()
    .describe("Target device id from `list-devices` (iOS UDID, Android serial, or Electron id)."),
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

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
  electron: { app: true },
};

async function swipeElectron(
  api: ElectronCdpApi,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  durationMs: number
): Promise<void> {
  const vp = api.getViewport();
  const startPx = { x: fromX * vp.width, y: fromY * vp.height };
  const endPx = { x: toX * vp.width, y: toY * vp.height };
  const steps = Math.max(2, Math.round(durationMs / 16));
  await api.dispatchMouseEvent({
    type: "mousePressed",
    x: startPx.x,
    y: startPx.y,
    clickCount: 1,
  });
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    await api.dispatchMouseEvent({
      type: "mouseMoved",
      x: startPx.x + (endPx.x - startPx.x) * t,
      y: startPx.y + (endPx.y - startPx.y) * t,
      button: "left",
    });
    await sleep(16);
  }
  await api.dispatchMouseEvent({
    type: "mouseReleased",
    x: endPx.x,
    y: endPx.y,
    clickCount: 1,
  });
}

export const gestureSwipeTool: ToolDefinition<Params, Result> = {
  id: "gesture-swipe",
  description: `Execute a smooth swipe / drag gesture between two points on the device (iOS simulator, Android emulator, or Electron app). All from/to positions are normalized 0.0–1.0 (fractions of screen width/height, not pixels), same as gesture-tap.
Generates interpolated Move events for a natural feel (~60fps).
Swipe up (fromY > toY) to scroll content down on touch devices. For Electron, the same gesture becomes a mouse drag from (fromX, fromY) to (toX, toY); use wheel-scroll patterns by dragging on a scrollbar / scrollable target.
Use when you need to scroll a list, dismiss a modal, drag an element, or navigate between pages. Returns { swiped: true, timestampMs }. Fails if the simulator-server / emulator backend / Electron CDP is not reachable for the given device.`,
  alwaysLoad: true,
  searchHint: "swipe scroll drag pan gesture device simulator emulator electron touch move",
  zodSchema,
  capability,
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.udid);
    if (device.platform === "electron") {
      return { electron: electronCdpRef(device) };
    }
    return { simulatorServer: simulatorServerRef(device) };
  },
  async execute(services, params) {
    const device = resolveDevice(params.udid);
    const duration = params.durationMs ?? 300;
    const timestampMs = Date.now();
    if (device.platform === "electron") {
      const electron = services.electron as ElectronCdpApi;
      await swipeElectron(electron, params.fromX, params.fromY, params.toX, params.toY, duration);
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
