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
import type { ShakeParams, ShakeResult, ShakeServices } from "../types";

const execFileAsync = promisify(execFile);

/**
 * Darwin notification Simulator.app itself posts for Device ▸ Shake (⌃⌘Z).
 *
 * The name is a string constant inside the Simulator binary, next to its
 * `simulateShake` / `shakeDevice:` selectors — UIKit listens for it inside the
 * guest and turns it into the same `UIEventSubtypeMotionShake` a physical
 * device raises. That is why this needs no private framework, no SimulatorKit
 * bridge in simulator-server, and no host UI scripting: `simctl spawn` runs
 * `notifyutil` inside the simulator, where the notification is delivered.
 */
export const SHAKE_NOTIFICATION = "com.apple.UIKit.SimulatorShake";

/**
 * Gap between consecutive gestures. Each notification is a discrete shake, so
 * the delay only has to be long enough that a listener sees two events rather
 * than one — UIKit's own shake handling debounces on the order of a few
 * hundred ms.
 */
const SHAKE_INTERVAL_MS = 400;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The in-simulator argv both backends run. */
const NOTIFYUTIL_ARGV = ["notifyutil", "-p", SHAKE_NOTIFICATION];

/**
 * An Apple TV has no accelerometer and no shake gesture, but its simulator is a
 * plain 8-4-4-4-12 UUID that `resolveDevice` classifies as `ios` / `simulator` —
 * indistinguishable from an iPhone by shape, so the capability matrix cannot
 * exclude it and the runtime has to be probed. Without this, `notifyutil`
 * happily posts a notification nothing listens for and the tool reports a
 * successful shake that never happened.
 */
function rejectTv(toolId: string, device: DeviceInfo): never {
  throw new UnsupportedOperationError(
    toolId,
    device,
    "tvOS has no shake gesture — a TV is focus-driven, use tv-remote"
  );
}

function shakeFailure(udid: string, detail: string, cause?: Error): FailureError {
  // `simctl spawn` against a shut-down device fails with a state error that
  // doesn't say what to do about it.
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
      // Only a thrown subprocess error carries the syscall/exit metadata. The
      // remote backend reports a non-zero child in its JSON payload instead of
      // throwing, so there is no error object to mine there.
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
    // `notifyutil` ships inside every simulator runtime, so there is nothing to
    // upload or install — this is the whole implementation.
    const args = await simctlArgsForUdid(udid, ["spawn", udid, ...NOTIFYUTIL_ARGV]);

    for (let i = 0; i < count; i++) {
      if (i > 0) await sleep(SHAKE_INTERVAL_MS);
      try {
        await execFileAsync("xcrun", args, { timeout: 15_000 });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        throw shakeFailure(udid, error.message, error);
      }
    }

    return { shaken: true, count };
  },
};

/**
 * Remote analogue of `iosImpl`: the same `notifyutil` argv, routed through
 * `sim-remote spawn` instead of `xcrun`. Without `--bin`, sim-remote treats the
 * trailing args as the full in-simulator argv, so the on-device `notifyutil` is
 * what runs — nothing is uploaded.
 *
 * Unlike the local path, a failure here does NOT throw: `sim-remote spawn
 * --json` reports the child's status in its payload and exits 0 either way. The
 * exit code must therefore be checked explicitly, or a shake that never
 * happened would still be reported as `{ shaken: true }`.
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
