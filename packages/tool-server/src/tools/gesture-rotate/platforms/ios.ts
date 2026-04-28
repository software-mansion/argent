import type { SimulatorServerApi } from "../../../blueprints/simulator-server";
import { sleep, sendTouchEvent } from "../../../utils/gesture-utils";

export interface GestureRotateParams {
  udid: string;
  centerX: number;
  centerY: number;
  radius: number;
  startAngle: number;
  endAngle: number;
  durationMs?: number;
}

export interface GestureRotateResult {
  rotated: boolean;
  timestampMs: number;
}

export interface GestureRotateServices {
  simulatorServer: SimulatorServerApi;
}

export async function rotateGestureIos(
  services: GestureRotateServices,
  params: GestureRotateParams
): Promise<GestureRotateResult> {
  const api = services.simulatorServer;
  const duration = params.durationMs ?? 300;
  const steps = Math.max(1, Math.round(duration / 16));

  let timestampMs = 0;

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const angleDeg = params.startAngle + (params.endAngle - params.startAngle) * t;
    const angleRad = (angleDeg * Math.PI) / 180;

    const x1 = params.centerX + params.radius * Math.cos(angleRad);
    const y1 = params.centerY + params.radius * Math.sin(angleRad);
    const x2 = params.centerX - params.radius * Math.cos(angleRad);
    const y2 = params.centerY - params.radius * Math.sin(angleRad);

    const type = i === 0 ? "Down" : i === steps ? "Up" : "Move";
    if (i === 0) timestampMs = Date.now();

    sendTouchEvent(api, type, x1, y1, x2, y2);
    if (i < steps) await sleep(16);
  }

  return { rotated: true, timestampMs };
}
