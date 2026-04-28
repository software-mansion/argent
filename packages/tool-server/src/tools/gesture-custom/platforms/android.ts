import { sendCommand } from "../../../utils/simulator-client";
import { interpolateEvents } from "../../../utils/gesture-utils";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import type { GestureCustomParams, GestureCustomResult, GestureCustomServices } from "./ios";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const androidImpl: PlatformImpl<
  GestureCustomServices,
  GestureCustomParams,
  GestureCustomResult
> = {
  handler: async (services, params) => {
    const api = services.simulatorServer;
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
