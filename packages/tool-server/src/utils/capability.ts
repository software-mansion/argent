import type { DeviceInfo, Platform, ToolCapability } from "@argent/registry";

/**
 * Thrown when a tool is invoked against a device whose platform/kind it does
 * not declare in its `capability` field. The HTTP dispatcher maps this to
 * `400 Bad Request`; the message names the tool and the device so the agent
 * sees a clear "wrong target" error instead of a deeper failure.
 */
export class UnsupportedOperationError extends Error {
  readonly toolId: string;
  readonly device: DeviceInfo;
  constructor(toolId: string, device: DeviceInfo, reason?: string) {
    const detail = reason ? ` (${reason})` : "";
    super(`Tool '${toolId}' is not supported on ${device.platform} ${device.kind}${detail}.`);
    this.name = "UnsupportedOperationError";
    this.toolId = toolId;
    this.device = device;
  }
}

/**
 * Thrown by per-platform stub handlers (typically `platforms/android.ts`)
 * when the cross-platform architecture is wired up but the impl is missing.
 *
 * Distinct from `UnsupportedOperationError`:
 *   - UnsupportedOperationError: capability says no, this device class is not
 *     a target for the tool (e.g. pinch on Android — adb has no multi-touch).
 *   - NotImplementedOnPlatformError: capability *could* say yes once filled
 *     in; the work just hasn't happened. The agent should report this back
 *     to the user verbatim instead of retrying.
 *
 * The HTTP dispatcher maps this to `501 Not Implemented` and surfaces the
 * `hint` field so the agent (and contributor) can see exactly what to wire.
 *
 * Usage in a stub:
 *
 *   throw new NotImplementedOnPlatformError({
 *     toolId: "button",
 *     platform: "android",
 *     hint: "Use `adb shell input keyevent <KEYCODE>` (home=3, back=4, ...).",
 *   });
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
  }
}

/**
 * Throws if the tool's `capability` declaration doesn't include the given
 * device. A tool with no `capability` is treated as universally supported —
 * useful for system / workspace tools that don't touch a device.
 */
export function assertSupported(
  toolId: string,
  capability: ToolCapability | undefined,
  device: DeviceInfo
): void {
  if (!capability) return;
  const matrix = device.platform === "ios" ? capability.apple : capability.android;
  if (!matrix) {
    throw new UnsupportedOperationError(toolId, device, `no ${device.platform} support declared`);
  }
  const supported = (matrix as Record<string, boolean | undefined>)[device.kind] === true;
  if (!supported) {
    throw new UnsupportedOperationError(toolId, device, `kind '${device.kind}' not supported`);
  }
  if (capability.supports && !capability.supports(device)) {
    throw new UnsupportedOperationError(toolId, device, "supports() refiner rejected device");
  }
}
