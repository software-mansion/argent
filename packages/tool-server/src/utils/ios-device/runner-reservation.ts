import { FAILURE_CODES, FailureError } from "@argent/registry";

// Interaction and measurement use the same XCTest bundle IDs. A retiring interaction
// runner may still be exiting when the registry starts its replacement.
const interactionRunners = new Map<string, number>();
const measurements = new Set<string>();

function assertNotMeasuring(udid: string): void {
  if (measurements.has(udid)) {
    throw runnerBusy(`A launch measurement is in progress on ${udid}. Retry when it finishes.`);
  }
}

function runnerBusy(message: string): FailureError {
  return new FailureError(message, {
    error_code: FAILURE_CODES.LAUNCH_ANALYSIS_DEVICE_UNAVAILABLE,
    failure_stage: "launch_analysis_runner_active",
    failure_area: "tool_server",
    error_kind: "validation",
  });
}

export function reserveInteractionRunner(udid: string): () => void {
  assertNotMeasuring(udid);
  interactionRunners.set(udid, (interactionRunners.get(udid) ?? 0) + 1);
  return () => {
    const remaining = interactionRunners.get(udid)! - 1;
    if (remaining === 0) interactionRunners.delete(udid);
    else interactionRunners.set(udid, remaining);
  };
}

export function reserveLaunchMeasurement(udid: string): () => void {
  assertNotMeasuring(udid);
  if (interactionRunners.has(udid)) {
    throw runnerBusy(
      `Argent's device runner is active on ${udid}. Run stop-simulator-server for this device, then retry.`
    );
  }
  measurements.add(udid);
  return () => {
    measurements.delete(udid);
  };
}
