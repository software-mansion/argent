import { sendCommand } from "../../../utils/simulator-client";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import type { GestureSwipeParams, GestureSwipeResult, GestureSwipeServices } from "./ios";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const androidImpl: PlatformImpl<
  GestureSwipeServices,
  GestureSwipeParams,
  GestureSwipeResult
> = {
  handler: async (services, params) => {
    const api = services.simulatorServer;
    const duration = params.durationMs ?? 300;
    const steps = Math.max(1, Math.round(duration / 16));
    let timestampMs = 0;

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = params.fromX + (params.toX - params.fromX) * t;
      const y = params.fromY + (params.toY - params.fromY) * t;
      const type = i === 0 ? "Down" : i === steps ? "Up" : "Move";
      if (i === 0) timestampMs = Date.now();
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
