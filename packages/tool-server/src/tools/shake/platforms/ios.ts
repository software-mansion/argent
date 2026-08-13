import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FAILURE_CODES, FailureError, subprocessFailureMetadata } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { simctlArgsForUdid } from "../../../utils/ios-device-sets";
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

export const iosImpl: PlatformImpl<ShakeServices, ShakeParams, ShakeResult> = {
  requires: ["xcrun"],
  async handler(_services, params): Promise<ShakeResult> {
    const { udid } = params;
    const count = params.count ?? 1;
    // `notifyutil` ships inside every simulator runtime, so there is nothing to
    // upload or install — this is the whole implementation.
    const args = await simctlArgsForUdid(udid, [
      "spawn",
      udid,
      "notifyutil",
      "-p",
      SHAKE_NOTIFICATION,
    ]);

    for (let i = 0; i < count; i++) {
      if (i > 0) await sleep(SHAKE_INTERVAL_MS);
      try {
        await execFileAsync("xcrun", args, { timeout: 15_000 });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        // `simctl spawn` against a shut-down device fails with a state error
        // that doesn't say what to do about it.
        const shutdownHint = /current state:\s*shutdown|unable to lookup/i.test(detail)
          ? " The simulator must be booted first — use boot-device."
          : "";
        throw new FailureError(
          `Failed to shake ${udid}: ${detail.trim()}${shutdownHint}`,
          {
            error_code: FAILURE_CODES.IOS_SHAKE_FAILED,
            failure_stage: "ios_shake_notifyutil",
            failure_area: "tool_server",
            error_kind: "subprocess",
            ...subprocessFailureMetadata(err, "xcrun_simctl"),
          },
          { cause: err instanceof Error ? err : new Error(String(err)) }
        );
      }
    }

    return { shaken: true, count };
  },
};
