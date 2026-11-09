import { z } from "zod";
import { isLiveServiceState, type Registry, type ToolCapability } from "@argent/registry";
import type { DebuggerNotConnectedReason } from "@argent/telemetry";
import { metroPortField } from "../../utils/debugger/metro-port";
import { canonicalDeviceId } from "../../utils/debugger/device-alias";
import { withKeyedLock } from "../../utils/keyed-lock";

export const captureSchema = z.object({
  udid: z.string().describe("Device ID from list-devices: an iOS simulator UDID or Android serial"),
  bundleId: z.string().describe("App bundle ID on iOS or package name on Android"),
  port: metroPortField.describe(
    "The app's Metro port: the JS layer is reached through it, and the native layers leave its requests out. Omit it to use this device's port, 8081 by default."
  ),
});

export type CaptureParams = z.infer<typeof captureSchema>;

/** The devices native-network-logs reads, where every layer start covers can run. */
export const CAPTURE_CAPABILITY: ToolCapability = {
  apple: { simulator: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true },
};

type CaptureLayer = "js" | "ios-native" | "android-native";

export interface StartedLayer {
  layer: CaptureLayer;
  armed: boolean;
  /** Why the layer is not armed. */
  reason?: string;
  /** Nothing arms the layer without a change the caller must make. */
  unavailable?: true;
}

export interface StoppedLayer {
  layer: CaptureLayer;
  /** True only when the layer did not confirm the stop. */
  armed: boolean;
  /** The requests the layer keeps for the app, as its listing counts them. */
  total: number;
  /** What kept the stop from reaching the layer, or what it left as it was. */
  reason?: string;
}

export interface CaptureResult<L> {
  status: "ok";
  layers: L[];
}

/** One start or stop at a time per device and app; their layers run in parallel. */
const captureLocks = new Map<string, Promise<unknown>>();

export function withCaptureLock<T>(
  udid: string,
  bundleId: string,
  fn: () => Promise<T>
): Promise<T> {
  const device = (canonicalDeviceId(udid) ?? udid).toLowerCase();
  return withKeyedLock(captureLocks, `${device}:${bundleId}`, fn);
}

/**
 * Runs every layer to the end, so one that throws never cuts another short,
 * then throws the first error.
 */
export async function runLayers<L>(layers: Array<Promise<L>>): Promise<L[]> {
  const settled = await Promise.allSettled(layers);
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
  if (failed) throw failed.reason;
  return settled.map((s) => (s as PromiseFulfilledResult<L>).value);
}

export function isLiveService(registry: Pick<Registry, "getSnapshot">, urn: string): boolean {
  const state = registry.getSnapshot().services.get(urn)?.state;
  return state !== undefined && isLiveServiceState(state);
}

/** Why the app's JS runtime was not reached, in a few words the caller can act on. */
export function jsNotReached(
  reason: DebuggerNotConnectedReason | undefined,
  port: number,
  err: unknown
): string {
  const detail = errorMessage(err);
  switch (reason) {
    case "metro_not_running":
      return `Metro is not running on port ${port}; start it, or pass the port of the app's Metro`;
    case "device_mismatch":
      return `no JS runtime on Metro port ${port} belongs to this device (${detail}); give each device its own Metro port`;
    case "no_app_connected":
      return `no app is connected to Metro on port ${port} yet`;
    case undefined:
      return `the JS debugger could not connect: ${detail}`;
    default:
      return `the app's JS runtime did not answer (${reason}: ${detail})`;
  }
}

/** Names the port where the app's JS capture is, for a call that named another one. */
export function otherPortHint(bundleId: string, port: number): string {
  return `this device has network capture for ${bundleId} on Metro port ${port}: pass port ${port}`;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
