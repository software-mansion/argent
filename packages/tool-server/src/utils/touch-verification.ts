import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import type { DeviceInfo } from "@argent/registry";
import type { SimulatorServerApi } from "../blueprints/simulator-server";
import { httpScreenshot, isPointerVisible, onAttachClose } from "./simulator-client";
import { sleep } from "./timing";

/**
 * Observational check that an injected touch landed. The touch transport has no
 * delivery ack, so the only signal is whether the frame changed around the
 * injection — a heuristic, not proof (an inert control leaves the frame
 * unchanged too, and unrelated animation changes it), so callers surface it as
 * a warning, never a failure. Automatic checks run until the attach settles, so
 * on a healthy device only the first touch pays for one; a no-change leaves the
 * attach unsettled, since that repeat is the wedge signal the whole thing exists
 * to catch. A respawned server (new apiUrl) starts fresh.
 */

/** Small fixed downscale for verification frames — we need a change signal, not detail. */
const VERIFY_SCALE = 0.25;
/** Let a touch's visual response begin before sampling the "after" frame. */
export const VERIFY_SETTLE_MS = 250;

export type DeliveryVerdict = "landed" | "no-change" | "unknown" | "pointer-active";

/** Fields a delivery-verified gesture result carries; empty when no check ran. */
export interface DeliveryCheck {
  /** Did the touch observably land? Present only when a check ran. */
  verified?: boolean;
  /** Present when a check ran and the touch could not be confirmed landed. */
  warning?: string;
}

const settledAttaches = new Set<string>();
const noChangeStreaks = new Map<string, number>();
const RECOVERY_HINT_STREAK = 2;

onAttachClose((apiUrl) => {
  settledAttaches.delete(apiUrl);
  noChangeStreaks.delete(apiUrl);
});

/** True until this attach settles (one confirmed landing, or proven unverifiable). */
export function shouldAutoVerify(api: SimulatorServerApi): boolean {
  return !settledAttaches.has(api.apiUrl);
}

function recordVerdict(api: SimulatorServerApi, verdict: DeliveryVerdict): void {
  // A landing proves the pipeline works; a capture failure won't fix itself.
  // Either way, stop auto-checking. "no-change"/"pointer-active" leave the attach
  // unsettled so the next touch is checked again.
  if (verdict === "landed" || verdict === "unknown") settledAttaches.add(api.apiUrl);
  if (verdict === "no-change") {
    noChangeStreaks.set(api.apiUrl, (noChangeStreaks.get(api.apiUrl) ?? 0) + 1);
  } else {
    noChangeStreaks.delete(api.apiUrl);
  }
}

function noChangeStreak(api: SimulatorServerApi): number {
  return noChangeStreaks.get(api.apiUrl) ?? 0;
}

/** Test hook: forget all per-attach delivery state. */
export function resetDeliveryTracking(): void {
  settledAttaches.clear();
  noChangeStreaks.clear();
}

export function hashFrame(bytes: Buffer): string {
  return crypto.createHash("sha1").update(bytes).digest("hex");
}

/** Capture one frame and hash it, or null if it can't be captured. */
async function captureFrameHash(api: SimulatorServerApi): Promise<string | null> {
  try {
    const { path } = await httpScreenshot(api, undefined, undefined, VERIFY_SCALE);
    try {
      return hashFrame(await fs.readFile(path));
    } finally {
      await fs.unlink(path).catch(() => {}); // verification frames are throwaway
    }
  } catch {
    return null;
  }
}

export function classifyDelivery(before: string | null, after: string | null): DeliveryVerdict {
  if (before === null || after === null) return "unknown";
  return before === after ? "no-change" : "landed";
}

/**
 * Run `action` (the touch injection) between two frame captures and report
 * whether the frame changed. Never throws: a failed capture yields "unknown".
 * With the pointer overlay on, the server draws every sent touch into the frame
 * regardless of delivery, so a diff can't isolate it — the touch runs unchecked
 * with verdict "pointer-active".
 */
export async function verifyTouchDelivery(
  api: SimulatorServerApi,
  action: () => Promise<void>
): Promise<DeliveryVerdict> {
  if (isPointerVisible(api)) {
    await action();
    return "pointer-active";
  }
  const before = await captureFrameHash(api);
  await action();
  await sleep(VERIFY_SETTLE_MS);
  const after = await captureFrameHash(api);
  return classifyDelivery(before, after);
}

/**
 * `recover-touch-injection` declares `apple: { simulator: true }`, so naming it
 * in a warning for anything else sends the agent at a guaranteed 400.
 */
export function canRecoverTouchInjection(device?: DeviceInfo): boolean {
  return device?.platform === "ios" && device.kind === "simulator";
}

/** Human-facing warning for a verdict that isn't a clean "landed", or null when it is. */
export function deliveryWarning(
  verdict: DeliveryVerdict,
  opts: { recommendRecovery?: boolean; device?: DeviceInfo } = {}
): string | null {
  const recoverable = canRecoverTouchInjection(opts.device);
  switch (verdict) {
    case "landed":
      return null;
    case "no-change":
      if (!(opts.recommendRecovery ?? true)) {
        return (
          "Touch was injected but the screen did not change. Many controls have no visible " +
          "effect, so a single no-change is not conclusive — if you expected the screen to " +
          "change, re-check with verify:true." +
          (recoverable ? " A repeated no-change will flag a possibly wedged simulator." : "")
        );
      }
      return recoverable
        ? "Touch was injected but the screen did not change — on an iOS simulator this can mean " +
            "touch injection has wedged (it accepts touches but silently drops them). If taps have " +
            "stopped landing, run recover-touch-injection for this device. (If this control " +
            "legitimately has no visible effect, ignore this.)"
        : "Touch was injected but the screen did not change. Re-check the coordinates against " +
            "describe (the point may be padding, a disabled control, or an already-selected item) " +
            "before assuming the touch was dropped. (If this control legitimately has no visible " +
            "effect, ignore this.)";
    case "unknown":
      return (
        "Could not capture before/after frames, so touch delivery could not be verified. " +
        "Automatic checks on this device are now skipped; pass verify:true to retry."
      );
    case "pointer-active":
      return (
        "The screen-recording touch pointer is on, and it draws every sent touch into the " +
        "frame — delivered or not — so delivery could not be verified by frame comparison. " +
        "Stop the recording and re-check with verify:true if taps seem to have no effect."
      );
  }
}

/**
 * Agent-facing description for a gesture's `verify` param. The policy wording
 * lives here, beside the policy itself, so the gesture schemas can't drift.
 * `tail` carries the gesture-specific caveat.
 */
export function describeVerify(
  noun: string,
  opts: { prefix?: string; tail?: string } = {}
): string {
  return (
    `${opts.prefix ?? ""}Confirm the ${noun} actually landed by checking the screen changed ` +
    "around it (a wedged iOS simulator can accept touches but silently drop them). Default is " +
    "automatic: touches on each device are checked until one is confirmed landed — usually just " +
    "the first per simulator-server session, but a touch that changes nothing keeps the check on, " +
    `since that repeat is the wedge signal. Pass true to force the check on this ${noun}, false ` +
    "to skip it. When a check runs, the result carries `verified` and, if the screen never " +
    "changed, a `warning` — on a local iOS simulator a repeated no-change (or a verify:true " +
    "check) points at recover-touch-injection; on other devices it suggests re-checking the " +
    "coordinates, since there is no equivalent wedge to clear." +
    (opts.tail ? ` ${opts.tail}` : "")
  );
}

/**
 * The single entry point gesture tools wrap their injection in.
 *
 *   verify true      → always check this touch.
 *   verify false     → never check.
 *   verify undefined → auto: check until this attach settles, then stop.
 *
 * Returns the fields to spread into the tool result; `{}` when no check ran.
 */
export async function runWithDeliveryVerification(
  api: SimulatorServerApi,
  verify: boolean | undefined,
  action: () => Promise<void>,
  device?: DeviceInfo
): Promise<DeliveryCheck> {
  const explicit = verify === true;
  const auto = verify === undefined && shouldAutoVerify(api);
  if (!explicit && !auto) {
    await action();
    return {};
  }
  const verdict = await verifyTouchDelivery(api, action);
  recordVerdict(api, verdict);
  // Nothing actionable to report — let the first post-recording touch speak.
  if (!explicit && verdict === "pointer-active") return {};
  const recommendRecovery = explicit || noChangeStreak(api) >= RECOVERY_HINT_STREAK;
  const warning = deliveryWarning(verdict, { recommendRecovery, device });
  return { verified: verdict === "landed", ...(warning ? { warning } : {}) };
}
