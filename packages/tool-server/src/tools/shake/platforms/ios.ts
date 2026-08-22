import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  FAILURE_CODES,
  FailureError,
  subprocessFailureMetadata,
  type DeviceInfo,
} from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { simctlArgsForUdid } from "../../../utils/ios-device-sets";
import { isRemoteTvOsSimulator, simctlSpawn } from "../../../utils/sim-remote";
import { isTvOsSimulator } from "../../../utils/ios-devices";
import { UnsupportedOperationError } from "../../../utils/capability";
import { prepareHostWindowShake } from "../../../utils/window-shake";
import type { ShakeParams, ShakeResult, ShakeServices } from "../types";

const execFileAsync = promisify(execFile);

/**
 * Darwin notification Simulator.app posts for Device ▸ Shake (⌃⌘Z). UIKit
 * listens for it inside the guest and turns it into the same
 * `UIEventSubtypeMotionShake` a physical device raises.
 */
export const SHAKE_NOTIFICATION = "com.apple.UIKit.SimulatorShake";

/** Gap between consecutive gestures, so a listener sees two shakes, not one. */
const SHAKE_INTERVAL_MS = 400;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The in-simulator argv both backends run. */
const NOTIFYUTIL_ARGV = ["notifyutil", "-p", SHAKE_NOTIFICATION];

/**
 * A tvOS simulator is an 8-4-4-4-12 UUID that `resolveDevice` classifies as
 * `ios` / `simulator`, so the capability matrix cannot exclude it and the
 * runtime has to be probed. Untrapped, `notifyutil` posts a notification
 * nothing listens for and the tool reports a shake that never happened.
 */
function rejectTv(toolId: string, device: DeviceInfo): never {
  throw new UnsupportedOperationError(
    toolId,
    device,
    "tvOS has no shake gesture — a TV is focus-driven, use tv-remote"
  );
}

function shakeFailure(udid: string, detail: string, cause?: Error): FailureError {
  // The state error simctl raises for a shut-down device says nothing about
  // what to do next.
  const shutdownHint = /current state:\s*shutdown|unable to lookup/i.test(detail)
    ? " The simulator must be booted first — use boot-device."
    : "";
  return new FailureError(
    `Failed to shake ${udid}: ${detail.trim()}${shutdownHint}`,
    {
      error_code: FAILURE_CODES.IOS_SHAKE_FAILED,
      failure_stage: "ios_shake_notifyutil",
      failure_area: "tool_server",
      error_kind: "subprocess",
      // Only a thrown subprocess error carries the syscall/exit metadata; the
      // remote backend reports a failed child in its JSON payload instead.
      ...(cause ? subprocessFailureMetadata(cause, "xcrun_simctl") : {}),
    },
    cause ? { cause } : undefined
  );
}

export const iosImpl: PlatformImpl<ShakeServices, ShakeParams, ShakeResult> = {
  requires: ["xcrun"],
  async handler(_services, params, device): Promise<ShakeResult> {
    const { udid } = params;
    const count = params.count ?? 1;
    if (await isTvOsSimulator(udid)) rejectTv("shake", device);
    // `notifyutil` ships in the simulator runtime, so nothing is uploaded.
    const args = await simctlArgsForUdid(udid, ["spawn", udid, ...NOTIFYUTIL_ARGV]);

    // The notification is invisible outside the guest, so wobble the Simulator
    // window in step with it. Cosmetic, flag-gated, and cannot fail the shake.
    const shaker = await prepareHostWindowShake({ kind: "ios", udid, name: device.name });

    for (let i = 0; i < count; i++) {
      if (i > 0) await sleep(SHAKE_INTERVAL_MS);
      shaker.begin();
      try {
        await execFileAsync("xcrun", args, { timeout: 15_000 });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        throw shakeFailure(udid, error.message, error);
      }
    }

    // So no `osascript` outlives the tool call. The throw path above skips it;
    // the wobble swallows its own failures and is capped at 5s.
    await shaker.settle();

    return { shaken: true, count };
  },
};

/**
 * Remote analogue of `iosImpl`: the same argv, routed through `sim-remote
 * spawn`. Without `--bin` the trailing args are the in-simulator argv, so the
 * on-device `notifyutil` runs and nothing is uploaded.
 *
 * A failed child surfaces as `exit_code` in the `--json` payload rather than a
 * throw, so it must be checked explicitly or a shake that never happened would
 * be reported as `{ shaken: true }`.
 */
export const iosRemoteImpl: PlatformImpl<ShakeServices, ShakeParams, ShakeResult> = {
  requires: ["sim-remote"],
  async handler(_services, params, device): Promise<ShakeResult> {
    const { udid } = params;
    const count = params.count ?? 1;
    if (await isRemoteTvOsSimulator(udid)) rejectTv("shake", device);

    for (let i = 0; i < count; i++) {
      if (i > 0) await sleep(SHAKE_INTERVAL_MS);
      let result;
      try {
        result = await simctlSpawn(udid, { args: NOTIFYUTIL_ARGV });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        throw shakeFailure(udid, error.message, error);
      }
      if (result.exitCode !== 0) {
        throw shakeFailure(
          udid,
          `notifyutil exited ${result.exitCode ?? "unknown"}${
            result.stderr ? `: ${result.stderr}` : ""
          }`
        );
      }
    }

    return { shaken: true, count };
  },
};
