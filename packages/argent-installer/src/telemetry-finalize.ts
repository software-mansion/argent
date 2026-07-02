import { shutdown as telemetryShutdown } from "@argent/telemetry";

export async function finalizeTelemetry(captureFinalEvent: () => void): Promise<void> {
  try {
    captureFinalEvent();
  } catch {
    /* telemetry must not change command behavior */
  }

  try {
    await telemetryShutdown();
  } catch {
    /* telemetry must not change command behavior */
  }
}
