import { sleep, sendTouchEvent } from "../../../utils/gesture-utils";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import type { GesturePinchParams, GesturePinchResult, GesturePinchServices } from "./ios";

// Android uses the same `simulator-server` channel as iOS — see comment in
// `gesture-tap/platforms/android.ts` for context. Multi-touch is supported
// because `simulator-server android` drives the gRPC EmulatorController, which
// accepts second_x/second_y in the touch payload.
export const androidImpl: PlatformImpl<
  GesturePinchServices,
  GesturePinchParams,
  GesturePinchResult
> = {
  handler: async (services, params) => {
    const api = services.simulatorServer;
    const duration = params.durationMs ?? 300;
    const steps = Math.max(1, Math.round(duration / 16));
    const angleDeg = params.angle ?? 0;
    const angleRad = (angleDeg * Math.PI) / 180;
    const cosA = Math.cos(angleRad);
    const sinA = Math.sin(angleRad);

    let timestampMs = 0;

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

      sendTouchEvent(api, type, x1, y1, x2, y2);
      if (i < steps) await sleep(16);
    }

    return { pinched: true, timestampMs };
  },
};
