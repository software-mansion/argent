import { z } from "zod";
import {
  FAILURE_CODES,
  FailureError,
  type DeviceInfo,
  type FailureCode,
  type ServiceRef,
} from "@argent/registry";
import type { MacosAppApi } from "../../blueprints/macos-app";
import {
  nativeDevtoolsRef,
  precheckNativeDevtools,
  type NativeDevtoolsApi,
  type NativeDevtoolsPrecheckBlock,
} from "../../blueprints/native-devtools";
import { InvalidToolInputError } from "../../utils/capability";
import { ensureDeps } from "../../utils/check-deps";
import { resolveDevice } from "../../utils/device-info";
import { macosAppServices, requireMacosApp } from "../../utils/macos-input";

/** The `udid` and `bundleId` parameters every native-* app tool takes. */
export const nativeAppTarget = {
  udid: z
    .string()
    .describe(
      "Simulator UDID<flag:macos-apps>, or a Mac app id (macos-app-<bundle id>)</flag:macos-apps>"
    ),
  bundleId: z
    .string()
    .describe(
      "Bundle ID of the app<flag:macos-apps> (on a Mac app, the bundle id in the device id)</flag:macos-apps>"
    ),
};

/** The `services()` of a native-* app tool: a Mac app's library, else the simulator's native devtools. */
export function nativeAppServices(params: { udid: string }): Record<string, ServiceRef> {
  const device = resolveDevice(params.udid);
  return device.platform === "macos"
    ? macosAppServices(device)
    : { nativeDevtools: nativeDevtoolsRef(device) };
}

/** The Mac app of a native-* tool call. The device id names one app, so `bundleId` must be its. */
export function requireMacosAppOfBundle(
  services: Record<string, unknown>,
  device: DeviceInfo,
  toolId: string,
  bundleId: string
): MacosAppApi {
  const app = requireMacosApp(services, toolId, device);
  if (bundleId !== app.bundleId) {
    throw new InvalidToolInputError(
      `bundleId '${bundleId}' is not the app of this device: a Mac app id names one app. ` +
        `Pass bundleId '${app.bundleId}', or use the device id macos-app-${bundleId}.`,
      {
        error_code: FAILURE_CODES.MACOS_APP_BUNDLE_ID_MISMATCH,
        failure_stage: "native_devtools_macos_bundle_id",
      }
    );
  }
  return app;
}

type ViewHierarchyMethod = Parameters<NativeDevtoolsApi["queryViewHierarchy"]>[1];

// Longer than the library's own limit (20 s), so its error, not ours, names the cause.
const VIEW_HIERARCHY_TIMEOUT_MS = 22_000;

/**
 * Send a `ViewHierarchy.*` request with the tool's parameters other than `udid`
 * and `bundleId`, and turn its result with `toResult`. A Mac app's library
 * answers with the iOS result shapes. On a simulator, a blocked native-devtools
 * precheck is returned as it is. With `errorCode`, an `error` in the result
 * fails the call.
 */
export async function queryViewHierarchyFor<T, R>(
  services: Record<string, unknown>,
  params: Record<string, unknown> & { udid: string; bundleId: string },
  toolId: string,
  method: ViewHierarchyMethod,
  errorCode: FailureCode | null,
  toResult: (result: T) => R
): Promise<R | NativeDevtoolsPrecheckBlock> {
  const { udid, bundleId, ...rpcParams } = params;
  const device = resolveDevice(udid);
  let result: T & { error?: string };
  if (device.platform === "macos") {
    const app = requireMacosAppOfBundle(services, device, toolId, bundleId);
    result = await app.call<typeof result>(method, rpcParams, {
      timeoutMs: VIEW_HIERARCHY_TIMEOUT_MS,
    });
  } else {
    await ensureDeps(device.platform === "ios-remote" ? ["sim-remote"] : ["xcrun"]);
    const api = services.nativeDevtools as NativeDevtoolsApi;
    const blocked = await precheckNativeDevtools(api, udid, bundleId);
    if (blocked) return blocked;
    result = (await api.queryViewHierarchy(bundleId, method, rpcParams)) as typeof result;
  }
  if (errorCode && result.error) {
    throw new FailureError(result.error, {
      error_code: errorCode,
      failure_stage: `native_devtools_${toolId.replace(/^native-/, "").replace(/-/g, "_")}`,
      failure_area: "tool_server",
      error_kind: "unknown",
    });
  }
  return toResult(result);
}
