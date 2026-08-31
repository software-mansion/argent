import { FAILURE_CODES, withFailureSignal } from "@argent/registry";
import type { IosDeviceRunnerApi } from "../../blueprints/ios-device-runner";
import { RunnerCommandError } from "./runner-client";

/**
 * Typed helpers for Argent runner wire commands.
 * Tools use normalized 0-1 coordinates. The runner uses absolute points in XCUIApplication.frame.
 */

/** Wire code the runner answers when a snapshot targets a backgrounded app. */
const APP_BACKGROUNDED_ERROR_CODE = "APP_BACKGROUNDED";

/** True when a success reply carries the runner's re-front stamp. */
function repliedReactivated(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { reactivated?: unknown }).reactivated === true
  );
}

/**
 * Re-front marker unwrapped from one command reply. Tools surface it so the
 * agent learns the action changed the foreground screen as a side effect.
 */
export interface MutationReply {
  /** The runner re-fronted the backgrounded target app to run this command. */
  reactivated: boolean;
}

export interface RunnerViewport {
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * The viewport read re-fronted a backgrounded target (the runner brings the
   * app forward for it, as the prelude to a gesture). Set only when true.
   */
  reactivated?: true;
}

interface ViewportData {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

/**
 * Application-frame viewport used to invert describe's 0-1 frames.
 */
export async function getViewport(
  api: IosDeviceRunnerApi,
  bundleId: string
): Promise<RunnerViewport> {
  // Do not cache. Keyboard and rotation change the size.
  const data = (await api.run(
    { command: "viewport", appBundleId: bundleId },
    { readOnly: true }
  )) as ViewportData;

  const viewport: RunnerViewport = {
    x: data.x ?? 0,
    y: data.y ?? 0,
    width: data.width ?? 0,
    height: data.height ?? 0,
    ...(repliedReactivated(data) ? { reactivated: true as const } : {}),
  };

  if (!(viewport.width > 0) || !(viewport.height > 0)) {
    throw withFailureSignal(
      new Error(
        "The app's interaction viewport is unavailable. Bring the app to the foreground, then retry."
      ),
      {
        error_code: FAILURE_CODES.TOOL_INPUT_INVALID,
        failure_stage: "ios_device_viewport",
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
  }

  return viewport;
}

/**
 * Convert a normalized 0-1 point to an absolute point in `viewport`.
 *
 * @param nx horizontal fraction of `viewport.width`.
 * @param ny vertical fraction of `viewport.height`.
 */
export function toPoints(
  viewport: RunnerViewport,
  nx: number,
  ny: number
): { x: number; y: number } {
  return {
    x: viewport.x + Math.max(0, Math.min(1, nx)) * viewport.width,
    y: viewport.y + Math.max(0, Math.min(1, ny)) * viewport.height,
  };
}

/**
 * Client timeout for gesture commands.
 * Must outlast the runner's 75s main-thread budget.
 */
const GESTURE_TIMEOUT_MS = 90_000;

/**
 * Tap at a point.
 *
 * @param numberOfTaps when greater than 1, one multi-tap command. The runner owns inter-tap timing.
 */
export async function tapAt(
  api: IosDeviceRunnerApi,
  bundleId: string,
  point: { x: number; y: number },
  numberOfTaps?: number
): Promise<MutationReply> {
  const data = await api.run(
    {
      command: "tap",
      appBundleId: bundleId,
      x: point.x,
      y: point.y,
      ...(numberOfTaps != null && numberOfTaps > 1 ? { numberOfTaps } : {}),
    },
    { timeoutMs: GESTURE_TIMEOUT_MS }
  );

  return { reactivated: repliedReactivated(data) };
}

/**
 * Press and hold at a point (XCUICoordinate press).
 *
 * @param durationMs how long to hold before lifting.
 */
export async function longPressAt(
  api: IosDeviceRunnerApi,
  bundleId: string,
  point: { x: number; y: number },
  durationMs: number
): Promise<MutationReply> {
  const data = await api.run(
    { command: "longPress", appBundleId: bundleId, x: point.x, y: point.y, durationMs },
    { timeoutMs: GESTURE_TIMEOUT_MS }
  );

  return { reactivated: repliedReactivated(data) };
}

/**
 * Drag from one point to another.
 *
 * @param settle rests the touch at the destination and skips the scroll-view fling.
 */
export async function dragBetween(
  api: IosDeviceRunnerApi,
  bundleId: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
  durationMs?: number,
  settle?: boolean
): Promise<MutationReply> {
  const data = await api.run(
    {
      command: "drag",
      appBundleId: bundleId,
      fromX: from.x,
      fromY: from.y,
      toX: to.x,
      toY: to.y,
      ...(durationMs != null ? { durationMs } : {}),
      ...(settle ? { settle: true } : {}),
    },
    { timeoutMs: GESTURE_TIMEOUT_MS }
  );

  return { reactivated: repliedReactivated(data) };
}

/**
 * Hardware buttons the runner's `button` command accepts.
 */
export type RunnerButton = "home" | "volumeUp" | "volumeDown" | "actionButton";

/**
 * Press a hardware button. Device-scoped. No app target.
 */
export async function pressButton(api: IosDeviceRunnerApi, button: RunnerButton): Promise<void> {
  await api.run({
    command: "button",
    button,
  });
}

/** Type text into the target app. */
export async function typeText(
  api: IosDeviceRunnerApi,
  bundleId: string,
  text: string
): Promise<MutationReply> {
  const data = await api.run(
    {
      command: "type",
      appBundleId: bundleId,
      text,
    },
    { timeoutMs: 60_000 }
  );

  return { reactivated: repliedReactivated(data) };
}

/** Press the software keyboard Return key. */
export async function pressKeyboardReturn(
  api: IosDeviceRunnerApi,
  bundleId: string
): Promise<MutationReply> {
  const data = await api.run({ command: "keyboardReturn", appBundleId: bundleId });

  return { reactivated: repliedReactivated(data) };
}

/**
 * Capture a device-wide PNG screenshot through the runner.
 *
 * @param timeoutMs caller-owned budget. The screenshot tool and flow settle use different values.
 */
export async function captureRunnerScreenshotPng(
  api: IosDeviceRunnerApi,
  timeoutMs: number
): Promise<Buffer> {
  const data = (await api.run({ command: "screenshot" }, { readOnly: true, timeoutMs })) as {
    imageBase64?: string;
  };

  if (!data.imageBase64) {
    throw new Error("Runner screenshot returned no inline image data.");
  }

  return Buffer.from(data.imageBase64, "base64");
}

export interface RunnerSnapshotNode {
  index: number;
  type: string;
  label: string | null;
  identifier: string | null;
  value: string | null;
  rect: { x: number; y: number; width: number; height: number };
  enabled: boolean;
  focused: boolean | null;
  selected: boolean | null;
  depth: number;
  parentIndex: number | null;
}

interface RunnerSnapshotQuality {
  state?: string;
  backend?: string;
  reason?: string;
  reasonCode?: string;
}

interface SnapshotData {
  nodes?: RunnerSnapshotNode[];
  quality?: RunnerSnapshotQuality;
}

/**
 * In-flight snapshot requests keyed by device and bundle.
 */
const inFlightSnapshots = new Map<
  string,
  Promise<{ nodes: RunnerSnapshotNode[]; quality: RunnerSnapshotQuality | null }>
>();

/**
 * The runner refuses to snapshot a backgrounded app: observation must not
 * re-front it. Map that wire code to the actions the agent can take; every
 * other error passes through untouched.
 */
function mapBackgroundedSnapshot(error: unknown, bundleId: string): unknown {
  if (!(error instanceof RunnerCommandError) || error.code !== APP_BACKGROUNDED_ERROR_CODE) {
    return error;
  }

  return withFailureSignal(
    new Error(
      `The app under automation (${bundleId}) is backgrounded; the screen is showing ` +
        "something else. Use screenshot for the current screen, launch-app to bring the " +
        "app back, or launch-app com.apple.springboard to describe the home screen and " +
        "system UI."
    ),
    {
      error_code: FAILURE_CODES.TOOL_INPUT_INVALID,
      failure_stage: "ios_device_snapshot_backgrounded",
      failure_area: "tool_server",
      error_kind: "validation",
    }
  );
}

/**
 * Capture an accessibility snapshot of the app.
 */
export async function captureSnapshot(
  api: IosDeviceRunnerApi,
  bundleId: string
): Promise<{ nodes: RunnerSnapshotNode[]; quality: RunnerSnapshotQuality | null }> {
  const key = `${api.udid}|${bundleId}`;
  // Concurrent identical reads share one runner command.
  const pending = inFlightSnapshots.get(key);

  if (pending) {
    return pending;
  }

  const request = (async () => {
    let data: SnapshotData;

    try {
      data = (await api.run(
        { command: "snapshot", appBundleId: bundleId },
        { readOnly: true, timeoutMs: 45_000 }
      )) as SnapshotData;
    } catch (error) {
      throw mapBackgroundedSnapshot(error, bundleId);
    }

    return {
      nodes: data.nodes ?? [],
      quality: data.quality ?? null,
    };
  })();

  inFlightSnapshots.set(key, request);

  try {
    return await request;
  } finally {
    inFlightSnapshots.delete(key);
  }
}
