import type { DeviceInfo, ToolCapability } from "@argent/registry";

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
