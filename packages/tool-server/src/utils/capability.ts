import { isFlagEnabled } from "@argent/configuration-core";
import {
  FAILURE_CODES,
  withFailureSignal,
  type DeviceInfo,
  type FailureSignal,
  type Platform,
  type ToolCapability,
} from "@argent/registry";
import { HARMONY_DISABLED_REASON, isHarmonyEnabled } from "./harmony-flag";

/**
 * Thrown when a device's platform/kind isn't in the tool's `capability`
 * declaration. The HTTP dispatcher maps this to `400 Bad Request`.
 */
export class UnsupportedOperationError extends Error {
  constructor(toolId: string, device: DeviceInfo, reason?: string) {
    const detail = reason ? ` (${reason})` : "";
    super(`Tool '${toolId}' is not supported on ${device.platform} ${device.kind}${detail}.`);
    this.name = "UnsupportedOperationError";
    withFailureSignal(this, {
      error_code: FAILURE_CODES.TOOL_CAPABILITY_UNSUPPORTED_OPERATION,
      failure_stage: "tool_capability_assert_supported",
      failure_area: "tool_server",
      error_kind: "unsupported",
    });
  }
}

/**
 * Thrown when cross-platform dispatch has no branch for the device's platform:
 * the architecture is wired up but the impl is missing.
 *
 * Distinct from `UnsupportedOperationError`, where the capability declaration
 * deliberately excludes this device class. Here the capability *could* say yes
 * once the work is done, so the agent should report it back instead of
 * retrying.
 *
 * The HTTP dispatcher maps this to `501 Not Implemented` and surfaces `hint`.
 */
export class NotImplementedOnPlatformError extends Error {
  readonly toolId: string;
  readonly platform: Platform;
  readonly hint: string | null;

  constructor(opts: { toolId: string; platform: Platform; hint?: string }) {
    const hint = opts.hint ? ` ${opts.hint}` : "";
    super(
      `Tool '${opts.toolId}' is not yet implemented on ${opts.platform}. ` +
        `The cross-platform architecture is in place — fill in ` +
        `tools/${opts.toolId}/platforms/${opts.platform}.ts and add the matching ` +
        `'${opts.platform}' block to the tool's capability declaration.${hint}`
    );
    this.name = "NotImplementedOnPlatformError";
    this.toolId = opts.toolId;
    this.platform = opts.platform;
    this.hint = opts.hint ?? null;
    withFailureSignal(this, {
      error_code: FAILURE_CODES.TOOL_PLATFORM_NOT_IMPLEMENTED,
      failure_stage: "tool_platform_dispatch",
      failure_area: "tool_server",
      error_kind: "not_implemented",
    });
  }
}

/**
 * Thrown when a tool rejects the caller's *arguments* — input that is well-typed
 * for the zod schema but that this tool/platform cannot carry out (an unknown
 * named key, a newline in Android/Vega `keyboard` text, a character with no
 * keycode on iOS/chromium). A client input error, not an internal fault, so the
 * HTTP dispatcher maps it to `400 Bad Request` like the zod-validation path
 * rather than a `500`. The `.message` is safe to bubble straight to the agent.
 */
export class InvalidToolInputError extends Error {
  /**
   * @param signal Telemetry-signal overrides. The HTTP 400 mapping keys off the
   *   error *class* (see http.ts), not the `error_code`, so a caller can pass a
   *   more granular code (e.g. the keyboard backends'
   *   `KEYBOARD_CHARACTER_UNSUPPORTED`) and keep both the granular telemetry
   *   bucket and the 400 status.
   */
  constructor(message: string, signal?: Partial<FailureSignal>) {
    super(message);
    this.name = "InvalidToolInputError";
    withFailureSignal(this, {
      error_code: FAILURE_CODES.TOOL_INPUT_INVALID,
      failure_stage: "tool_input_validation",
      failure_area: "tool_server",
      error_kind: "validation",
      ...signal,
    });
  }
}

function platformMatrix(
  platform: Platform,
  capability: ToolCapability
): Record<string, boolean | undefined> | undefined {
  switch (platform) {
    case "ios":
      return capability.apple;
    case "ios-remote":
      return capability.appleRemote;
    case "android":
      return capability.android;
    case "chromium":
      return capability.chromium;
    case "vega":
      return capability.vega;
    case "harmony":
      return capability.harmony;
    case "macos":
      return capability.macos;
  }
}

/** The flag that gates the `macos` platform, and the refusal every Mac branch gives without it. */
export const MACOS_APPS_FLAG = "macos-apps";
export const MACOS_APPS_FLAG_OFF_REASON =
  "the macos-apps flag is off. Run: argent enable macos-apps";

const MACOS_POINTER_ONLY =
  "a Mac app takes mouse input: use gesture-drag to drag and gesture-scroll to scroll";
const MACOS_NO_TRACKPAD_GESTURES =
  "a Mac app has no trackpad gesture input: use the app's own zoom or rotate controls with " +
  "gesture-tap or keyboard";

/**
 * Why a tool without a `macos` block refuses a Mac app, where the stock "no
 * macos support declared" would leave the agent without a next step.
 */
const MACOS_REFUSAL_REASONS: Readonly<Record<string, string>> = {
  "gesture-swipe": MACOS_POINTER_ONLY,
  "gesture-custom": MACOS_POINTER_ONLY,
  "gesture-pinch": MACOS_NO_TRACKPAD_GESTURES,
  "gesture-rotate": MACOS_NO_TRACKPAD_GESTURES,
  "button": "a Mac app has no hardware buttons: use keyboard for key presses",
  "reinstall-app":
    "argent does not install Mac apps, it starts the .app where it was built. Rebuild the app, " +
    "then run restart-app (or boot-device with macosAppPath for a .app at another path)",
};

/**
 * Throws if the tool's `capability` declaration doesn't include the given
 * device. No `capability` means universally supported — for system / workspace
 * tools that don't touch a device.
 */
export function assertSupported(
  toolId: string,
  capability: ToolCapability | undefined,
  device: DeviceInfo
): void {
  if (!capability) return;
  if (device.platform === "harmony" && !isHarmonyEnabled()) {
    throw new UnsupportedOperationError(toolId, device, HARMONY_DISABLED_REASON);
  }
  // Before the matrix, so every tool names the flag; read per call, so enabling needs no restart.
  if (device.platform === "macos" && !isFlagEnabled(MACOS_APPS_FLAG)) {
    throw new UnsupportedOperationError(toolId, device, MACOS_APPS_FLAG_OFF_REASON);
  }
  const matrix = platformMatrix(device.platform, capability);
  if (!matrix) {
    const reason =
      (device.platform === "macos" ? MACOS_REFUSAL_REASONS[toolId] : undefined) ??
      `no ${device.platform} support declared`;
    throw new UnsupportedOperationError(toolId, device, reason);
  }
  const supported = matrix[device.kind] === true;
  if (!supported) {
    const reason =
      device.platform === "harmony" && device.kind === "emulator"
        ? "a `harmony-emulator-` id names an instance only boot-device starts; drive the " +
          '`harmony-<connectKey>` id of its `kind: "device"` entry in list-devices'
        : `kind '${device.kind}' not supported`;
    throw new UnsupportedOperationError(toolId, device, reason);
  }
  if (capability.supports && !capability.supports(device)) {
    throw new UnsupportedOperationError(toolId, device, "supports() refiner rejected device");
  }
}
