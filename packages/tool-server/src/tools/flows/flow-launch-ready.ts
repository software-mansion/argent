import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import type { DeviceInfo, Registry } from "@argent/registry";
import { settleWithin, sleepOrAbort } from "../../utils/timing";
import { degradedNoAppHint, readIosSimulatorUiTree } from "./flow-ios-tree";

/**
 * How long a launch waits for the platform's tree source to serve the launched
 * app: on an iOS simulator, for the accessibility tree to name it as the
 * foreground app; on Vega, for the automation toolkit to attach. A cold start
 * can outlast the first directive's auto-wait, so the wait lives on the launch
 * step, which fails with a reason naming the app instead of letting the first
 * directive surface a raw tree-source error.
 */
export const NATIVE_READY_TIMEOUT_MS = 15_000;
export const NATIVE_READY_POLL_MS = 250;

/**
 * Poll the simulator's accessibility tree until it names `bundleId` as the
 * foreground app. Returns null once it does and on abort (the caller reports
 * the cancellation itself); otherwise the reason the app never came up: a
 * tree source that cannot serve flows at all (reported at once, waiting would
 * not change it), else what the last read saw. The tree lists the app under a
 * system alert as the foreground app, so a permission prompt does not fail
 * the launch.
 */
export async function waitForForegroundApp(
  registry: Registry,
  device: DeviceInfo,
  bundleId: string,
  signal?: AbortSignal
): Promise<string | null> {
  const start = Date.now();
  const deadline = start + NATIVE_READY_TIMEOUT_MS;
  let last: string;
  let readFailed: boolean;
  // The last read was degraded and named no app in the foreground.
  let hiddenByDialog = false;
  for (;;) {
    if (signal?.aborted) return null;
    // Bounded by the abort, as the reads in flow-actions are.
    const read = await settleWithin(readIosSimulatorUiTree(registry, device), undefined, signal);
    if (read.type === "aborted") return null;
    if (read.type === "value") {
      const tree = read.value;
      if (tree.foregroundApp === bundleId) return null;
      readFailed = false;
      hiddenByDialog = tree.degraded && tree.foregroundApp === undefined;
      last = tree.foregroundApp
        ? `${tree.foregroundApp} is in the foreground`
        : "no app is in the foreground";
    } else if (read.type === "error") {
      if (getFailureSignal(read.cause)?.error_code === FAILURE_CODES.AX_TREE_UNSUPPORTED) {
        return read.error;
      }
      readFailed = true;
      last = read.error;
    } else {
      // Unreachable: no time budget was given.
      readFailed = true;
      last = "the read timed out";
    }
    if (Date.now() >= deadline) break;
    if (!(await sleepOrAbort(NATIVE_READY_POLL_MS, signal))) return null;
  }
  // The app was never observed: the read's own reason ends with its remedy.
  if (readFailed) return `the launch of ${bundleId} could not be checked: ${last}`;
  // The deadline is checked after each read, and a read has no budget of its
  // own, so the wait can run past NATIVE_READY_TIMEOUT_MS: name what it took.
  return (
    `${bundleId} was not the foreground app after a wait of ${Date.now() - start} ms: ` +
    `${last}. Launch it by hand (launch-app, then screenshot) to see whether it crashes or shows ` +
    `another app first.${hiddenByDialog ? ` ${degradedNoAppHint(device)}` : ""}`
  );
}
