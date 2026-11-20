import type { UiOrientation } from "../describe/contract";
import { isIosSimulator } from "../../utils/device-info";
import { readUiOrientation, unknownOrientationNote } from "../../utils/ios-ui-orientation";
import { isTurned, nativePointToUi } from "../../utils/ui-orientation";
import type { DeviceInfo } from "@argent/registry";
import type { FlowStep, GestureTarget } from "./flow-utils";

/**
 * The raw points of a version 1 e2e test's directive, in the UI's upright space.
 *
 * A version 1 file was recorded when an iOS simulator's touches were in the
 * screen's portrait-native space, so on a landscape or upside-down UI its raw
 * points (`tap: { x, y }`, a swipe's `from` and `to` points, its `by`) are
 * native. Its selectors and directions were the UI's then too, so only the
 * points are turned; the directive then runs as one from a version 2 file.
 * A raw `tool:` step is left as it is and runs in native coordinates instead
 * (`inCoordinateSpace` in utils/ios-ui-orientation.ts): its arguments have no
 * one shape to turn.
 *
 * The step unchanged on any other target, for a portrait UI, and when the
 * orientation could not be read, as then the touch itself is sent untouched
 * in the native space it was recorded in.
 */
export async function uprightLegacyPoints<S extends FlowStep>(
  device: Pick<DeviceInfo, "id" | "platform" | "kind">,
  step: S
): Promise<{ step: S; warning?: string }> {
  if (!hasRawPoints(step) || !isIosSimulator(device)) return { step };
  const read = await readUiOrientation(device.id);
  if (read.orientation === undefined) {
    return read.unknownReason === undefined
      ? { step }
      : { step, warning: unknownOrientationNote(read, "this step's points were sent in") };
  }
  if (!isTurned(read.orientation)) return { step };
  // Each case spreads the step it was given, so the kind is kept.
  return { step: turnStep(step, read.orientation) as S };
}

function hasRawPoints(step: FlowStep): boolean {
  switch (step.kind) {
    case "tap":
    case "long-press":
      return step.x !== undefined && step.y !== undefined;
    case "swipe":
      return isPoint(step.from) || isPoint(step.to) || step.by !== undefined;
    default:
      return false;
  }
}

function isPoint(target: GestureTarget | undefined): target is { x: number; y: number } {
  return target !== undefined && "x" in target;
}

function turnStep(step: FlowStep, orientation: UiOrientation): FlowStep {
  const point = (p: { x: number; y: number }) => snapPoint(nativePointToUi(p, orientation));
  switch (step.kind) {
    case "tap":
    case "long-press":
      return { ...step, ...point({ x: step.x!, y: step.y! }) };
    case "swipe":
      return {
        ...step,
        ...(isPoint(step.from) ? { from: point(step.from) } : {}),
        ...(isPoint(step.to) ? { to: point(step.to) } : {}),
        ...(step.by !== undefined ? { by: turnDelta(step.by, orientation) } : {}),
      };
    default:
      return step;
  }
}

/**
 * A native delta in the UI's axes. The maps are affine, so a delta turns as
 * the difference of its two ends. An axis the delta leaves out stays out: it
 * moves along the other one alone, both before and after the turn.
 */
function turnDelta(
  by: { x?: number; y?: number },
  orientation: UiOrientation
): { x?: number; y?: number } {
  const origin = nativePointToUi({ x: 0, y: 0 }, orientation);
  const end = nativePointToUi({ x: by.x ?? 0, y: by.y ?? 0 }, orientation);
  const dx = snap(end.x - origin.x);
  const dy = snap(end.y - origin.y);
  // A quarter turn swaps the axes, a half turn keeps them.
  const swapped = orientation === "landscapeLeft" || orientation === "landscapeRight";
  const hasX = swapped ? by.y !== undefined : by.x !== undefined;
  const hasY = swapped ? by.x !== undefined : by.y !== undefined;
  return { ...(hasX ? { x: dx } : {}), ...(hasY ? { y: dy } : {}) };
}

/** Free of float noise, so `1 - 0.7` reads 0.3 in a report. */
function snap(n: number): number {
  return Math.round(n * 1e9) / 1e9 + 0;
}

function snapPoint(p: { x: number; y: number }): { x: number; y: number } {
  return { x: snap(p.x), y: snap(p.y) };
}
