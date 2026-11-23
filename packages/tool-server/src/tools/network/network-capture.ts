import { z } from "zod";
import { isLiveServiceState, type Registry, type ToolCapability } from "@argent/registry";
import type { DebuggerNotConnectedReason } from "@argent/telemetry";
import { metroPortField } from "../../utils/debugger/metro-port";
import { deviceKeyOf } from "../../utils/native-network-record";
import { withKeyedLock } from "../../utils/keyed-lock";
import { BUNDLE_ID_MESSAGE, BUNDLE_ID_PATTERN } from "../../utils/bundle-id";
import { settleWithin } from "../../utils/timing";
import { classifyDevice } from "../../utils/device-info";
import { reverseStart } from "../../utils/sim-remote";
import type { JsRuntimeDebuggerApi } from "../../blueprints/js-runtime-debugger";
import { resolveDebuggerService } from "../debugger/not-connected";

export const captureSchema = z.object({
  udid: z
    .string()
    .describe(
      "Device ID from list-devices: an iOS simulator UDID or Android serial<flag:macos-apps>, or a Mac app id (macos-app-<bundle id>)</flag:macos-apps>"
    ),
  bundleId: z
    .string()
    .regex(BUNDLE_ID_PATTERN, BUNDLE_ID_MESSAGE)
    .describe(
      "App bundle ID on iOS or package name on Android<flag:macos-apps> (on a Mac app, the bundle id in the device id)</flag:macos-apps>"
    ),
  port: metroPortField.describe(
    "The app's Metro port: the JS layer is reached through it, and the native layers leave its requests out. Omit it to use this device's port, 8081 by default."
  ),
  layer: z
    .enum(["js", "native"])
    .optional()
    .describe(
      "Use js for the app's JavaScript requests or native for requests captured by the native layer. Omit to control all supported layers.<flag:macos-apps> On Mac apps, this parameter supports only native. Read view-network-logs to start JavaScript capture in a React Native Mac app.</flag:macos-apps>"
    ),
  logicalDeviceId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Only when several devices share the Metro port: this device's logicalDeviceId, which the JS layer's reason lists. The JS layer connects to that runtime, and view-network-logs then takes it as device_id. The native layer always uses udid."
    ),
});

export type CaptureParams = z.infer<typeof captureSchema>;

/** The layers a call acts on: both when it names none. */
export function requestedLayers(layer: CaptureParams["layer"]): { js: boolean; native: boolean } {
  return { js: layer !== "native", native: layer !== "js" };
}

/** Why a call with layer js reaches nothing on a Mac app. */
export const MACOS_NO_JS =
  'on a Mac app these tools act only on the native layer (view-network-logs starts the capture of a React Native app\'s JS runtime when it reads), so omit layer or pass layer "native"';

/** The capture a call acts on, as its interaction messages name it. */
export function captureName(layer: CaptureParams["layer"]): string {
  return layer === "js"
    ? "JS network capture"
    : layer === "native"
      ? "native network capture"
      : "network capture";
}

/**
 * The layers as a call with `layer` returns them: a reason that tells to call
 * network-capture-start or network-capture-stop again also tells to pass the same
 * layer, so that call leaves the other layer as it is.
 */
export function withLayerInRetries<L extends { reason?: string }>(
  layers: L[],
  layer: CaptureParams["layer"]
): L[] {
  if (layer === undefined) return layers;
  return layers.map((entry) =>
    // A reason that already names the layer to pass is left as it is.
    entry.reason &&
    /network-capture-(start|stop)/.test(entry.reason) &&
    !/layer "(js|native)"/.test(entry.reason)
      ? {
          ...entry,
          reason: `${entry.reason}; pass layer "${layer}" to that call, so it leaves the other layer as it is`,
        }
      : entry
  );
}

/** The devices native-network-logs reads, where every layer start covers can run. */
export const CAPTURE_CAPABILITY: ToolCapability = {
  apple: { simulator: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true },
  macos: { app: true, catalyst: true },
};

type CaptureLayer = "js" | "ios-native" | "android-native" | "macos-native";

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
  /**
   * The requests the layer keeps for the app, as its listing counts them, or 0
   * when the stop could not count them, as on a JS runtime it did not reach.
   */
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

/**
 * The stop-all-simulator-servers teardowns under way: the devices each covers,
 * or undefined for every device, and when it ends.
 */
const captureSweeps = new Set<{ devices?: ReadonlySet<string>; done: Promise<void> }>();

function lockDevice(udid: string): string {
  return deviceKeyOf(udid).toLowerCase();
}

/**
 * Why the last network-capture-start of an app found the native layer unavailable before that
 * layer's service turned capture on, by device and app, so native-network-logs can say why it has
 * no capture. An Android inspector that started keeps its own reason. A start that turns capture
 * on, and a teardown of the device, drop it.
 */
const nativeUnavailable = new Map<string, string>();

function nativeUnavailableKey(udid: string, bundleId: string): string {
  return `${lockDevice(udid)}:${bundleId}`;
}

/** Keeps why a start found the app's native layer unavailable, or drops it without a reason. */
export function setNativeUnavailable(udid: string, bundleId: string, reason?: string): void {
  if (reason === undefined) nativeUnavailable.delete(nativeUnavailableKey(udid, bundleId));
  else nativeUnavailable.set(nativeUnavailableKey(udid, bundleId), reason);
}

/** Why the last start of the app found its native layer unavailable, if it did. */
export function nativeUnavailableReason(udid: string, bundleId: string): string | undefined {
  return nativeUnavailable.get(nativeUnavailableKey(udid, bundleId));
}

/** Forgets why a start found the native layer unavailable on the devices, or on every device. */
export function forgetNativeUnavailableOf(devices?: readonly string[]): void {
  const covered = devices && new Set(devices.map(lockDevice));
  for (const key of nativeUnavailable.keys()) {
    // A key is `<device>:<bundleId>`, and a bundle id has no colon.
    if (!covered || covered.has(key.slice(0, key.lastIndexOf(":")))) nativeUnavailable.delete(key);
  }
}

export function withCaptureLock<T>(
  udid: string,
  bundleId: string,
  fn: () => Promise<T>
): Promise<T> {
  const device = lockDevice(udid);
  // A teardown of the device that began before this call ends first.
  const sweeps = [...captureSweeps]
    .filter((sweep) => !sweep.devices || sweep.devices.has(device))
    .map((sweep) => sweep.done);
  return withKeyedLock(captureLocks, `${device}:${bundleId}`, async () => {
    await Promise.all(sweeps);
    return fn();
  });
}

/**
 * Runs `fn`, a teardown of the devices (every device without them), once each
 * start and stop of their apps under way has ended, or once `signal` aborts,
 * which `fn` then checks, or once `maxMs` has passed. A start or stop of their
 * apps called meanwhile waits until `fn` ends.
 */
export async function withCaptureSweep<T>(
  devices: readonly string[] | undefined,
  wait: { signal?: AbortSignal; maxMs?: number },
  fn: () => Promise<T>
): Promise<T> {
  const covered = devices && new Set(devices.map(lockDevice));
  // A key is `<device>:<bundleId>`, and a bundle id has no colon.
  const underWay = [...captureLocks]
    .filter(([key]) => !covered || covered.has(key.slice(0, key.lastIndexOf(":"))))
    .map(([, held]) => held);
  let end!: () => void;
  const sweep = { devices: covered, done: new Promise<void>((resolve) => (end = resolve)) };
  captureSweeps.add(sweep);
  try {
    await settleWithin(Promise.all(underWay), wait.maxMs, wait.signal);
    return await fn();
  } finally {
    captureSweeps.delete(sweep);
    end();
  }
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

/**
 * The debugger of the app's JS runtime. With `logicalDeviceId`, Metro's target
 * goes by that id, while the device itself still goes by its udid: a
 * provider's grant and socket, and a remote simulator's sim-remote tunnel to
 * Metro. The debugger opens that tunnel only for an id of a remote simulator,
 * so it is opened here.
 */
export async function resolveJsRuntime(
  registry: Registry,
  udid: string,
  logicalDeviceId: string | undefined,
  port: number
): Promise<JsRuntimeDebuggerApi> {
  if (logicalDeviceId !== undefined && classifyDevice(udid) === "ios-remote") {
    await reverseStart(udid, port);
  }
  return resolveDebuggerService(
    registry,
    { port, device_id: logicalDeviceId ?? udid },
    { physicalDeviceId: udid }
  );
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
    case "device_mismatch": {
      // The detail lists each device with its logicalDeviceId in parentheses.
      const listed = /connected to Metro on port \d+: (.+?)\. Re-target/.exec(detail)?.[1];
      return `several devices are connected to Metro on port ${port}, so the JS layer cannot tell which runtime is this device's; pass this device's logicalDeviceId (${listed ? `in parentheses: ${listed}` : detail}), or give each device its own Metro port`;
    }
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
