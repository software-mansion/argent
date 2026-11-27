import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { stripRemotePrefix } from "../../../utils/device-info";
import {
  INPUT_READY_HOLD_MID_ANGLE_MS,
  INPUT_READY_HOLD_MS,
  MAIN_SCREEN_ID,
  panelName,
} from "../../../utils/foldable";
import { isRemoteFoldableDeviceType } from "../../../utils/ios-devices";
import { fold, simctlListDevices } from "../../../utils/sim-remote";
import { sleepOrAbort } from "../../../utils/timing";

/**
 * A remote foldable is folded by its runner, through `sim-remote fold`. The
 * runner sweeps the hinge, waits for the device to hand over to the other
 * panel and moves the input, the stream and a recording under way over to it,
 * so every other tool keeps acting on the panel that shows the UI.
 */

const POSTURES = ["closed", "half-open", "open"] as const;
type Posture = (typeof POSTURES)[number];

const POSTURE_ANGLE: Record<Posture, number> = { "closed": 0, "half-open": 120, "open": 180 };

export interface RemoteFoldParams {
  udid: string;
  posture?: Posture;
  angle?: number;
}

/** A local iOS fold's result, without the panel size, which the runner does not report. */
export interface RemoteFoldResult {
  activeScreen: number;
  screen: { id: number; panel: string };
  posture?: Posture;
  hingeAngle: number;
  warning?: string;
}

/** Whether the runner lists `udid` as a device of a type that is not foldable. */
async function listedAsNotFoldable(udid: string): Promise<boolean> {
  try {
    const bare = stripRemotePrefix(udid);
    const listed = Object.values((await simctlListDevices()).devices)
      .flat()
      .find((d) => d.udid === bare);
    const type = listed?.deviceTypeIdentifier;
    return type !== undefined && !(await isRemoteFoldableDeviceType(type));
  } catch {
    return false;
  }
}

/**
 * A fold `sim-remote` refused, in the codes of a local one: asked of a device
 * that is not foldable it is the caller's mistake, anything else the fold's.
 * The message stays the CLI's own.
 */
async function foldFailure(err: unknown, udid: string): Promise<FailureError> {
  const message = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error ? { cause: err } : undefined;
  if (await listedAsNotFoldable(udid)) {
    return new FailureError(
      message,
      {
        error_code: FAILURE_CODES.IOS_FOLD_UNSUPPORTED,
        failure_stage: "sim_remote_fold_not_foldable",
        failure_area: "tool_server",
        error_kind: "unsupported",
      },
      cause
    );
  }
  return new FailureError(
    message,
    {
      error_code: FAILURE_CODES.IOS_FOLD_FAILED,
      failure_stage: "sim_remote_fold",
      failure_area: "tool_server",
      error_kind: "subprocess",
      failure_command: "sim_remote",
    },
    cause
  );
}

export const iosRemoteImpl: PlatformImpl<unknown, RemoteFoldParams, RemoteFoldResult> = {
  requires: ["sim-remote"],
  async handler(_services, params, _device, ctx) {
    ctx?.signal?.throwIfAborted();
    const target = params.posture ?? String(params.angle);
    const folded = await fold(params.udid, target, ctx?.signal).catch(async (err: unknown) => {
      ctx?.signal?.throwIfAborted();
      throw await foldFailure(err, params.udid);
    });

    // The runner answers at the hand-over; the guest takes no input for a
    // while after it, longer when the hinge stops short of closed or open.
    const hingeAngle = folded.hinge_angle;
    const atStop = hingeAngle <= POSTURE_ANGLE.closed || hingeAngle >= POSTURE_ANGLE.open;
    await sleepOrAbort(atStop ? INPUT_READY_HOLD_MS : INPUT_READY_HOLD_MID_ANGLE_MS, ctx?.signal);
    // Cut short, the hold has not shown the device to take input yet.
    ctx?.signal?.throwIfAborted();

    // With the panel unknown the runner keeps sending input to the cover panel.
    const activeScreen = folded.live_screen ?? MAIN_SCREEN_ID;
    const posture = params.posture ?? POSTURES.find((p) => POSTURE_ANGLE[p] === hingeAngle);
    return {
      activeScreen,
      screen: { id: activeScreen, panel: panelName(activeScreen) },
      ...(posture ? { posture } : {}),
      hingeAngle,
      ...(folded.warning ? { warning: folded.warning } : {}),
    };
  },
};
