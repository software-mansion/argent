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
  electronMode: z
    .enum(["scroll", "drag"])
    .optional()
    .describe(
      "Electron only (ignored on iOS/Android). 'scroll' (default) dispatches mouse-wheel deltas at the start point — swipe up scrolls content down, matching touch platforms. " +
        "'drag' presses and moves the mouse from start to end — use for sliders, drag-and-drop, or text selection. A desktop mouse drag never scrolls content, so keep 'scroll' for lists/pages."
    ),
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

/**
 * Wheel-based scroll for Electron. A desktop renderer scrolls via wheel
 * events, not mouse drags (a drag selects text). Deltas follow the touch
 * convention the tool documents: swipe up (fromY > toY) scrolls content
 * down, so deltaY = (fromY - toY) in CSS pixels. Chunked over the duration
 * so scroll handlers fire progressively like a real wheel gesture.
 */
async function scrollElectron(
  api: ElectronCdpApi,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  durationMs: number
): Promise<void> {
  const vp = api.getViewport();
  const totalDx = (fromX - toX) * vp.width;
  const totalDy = (fromY - toY) * vp.height;
  const steps = Math.max(1, Math.round(durationMs / 16));
  const point = { x: fromX, y: fromY };
  for (let i = 0; i < steps; i++) {
    await api.server.sendWheel(point, totalDx / steps, totalDy / steps);
    if (i < steps - 1) await sleep(16);
  }
}

async function dragElectron(
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
Swipe up (fromY > toY) to scroll content down — on Electron this dispatches mouse-wheel deltas at the start point (same scrolling semantics as touch platforms). Pass electronMode: "drag" to get a mouse drag instead (sliders, drag-and-drop); a desktop drag never scrolls content.
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
      const swipe = params.electronMode === "drag" ? dragElectron : scrollElectron;
      await swipe(electron, params.fromX, params.fromY, params.toX, params.toY, duration);
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
