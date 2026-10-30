import type { Registry } from "@argent/registry";
import { macosAppRef, type MacosAppApi, type MacosLaunchResult } from "../../blueprints/macos-app";
import { InvalidToolInputError } from "../../utils/capability";
import {
  macosAppIdFromBundleId,
  parseMacosAppBundleId,
  resolveDevice,
} from "../../utils/device-info";
import { assertMacosAppsEnabled, inspectMacosApp } from "../../utils/macos-apps";

export type MacosBootResult = Pick<
  MacosLaunchResult,
  "bundleId" | "pid" | "appPath" | "sandboxed" | "logPath" | "args" | "alreadyRunning" | "note"
> & {
  platform: "macos";
  /** `macos-app-<bundle id>`: the device id every other tool takes. */
  id: string;
  booted: true;
};

/**
 * Starts a native Mac app with the argent library, from `appPath`, or for a
 * device id from the path argent recorded at the last start, else from
 * Spotlight. An app argent already runs is returned as it is unless `force`
 * restarts it.
 */
export async function bootMacosApp(
  registry: Registry,
  opts: { appPath?: string; deviceId?: string; args?: string[]; force?: boolean }
): Promise<MacosBootResult> {
  assertMacosAppsEnabled("boot-device", opts.deviceId ? resolveDevice(opts.deviceId) : undefined);
  const info = opts.appPath ? await inspectMacosApp(opts.appPath) : undefined;
  const bundleId = info?.bundleId ?? parseMacosAppBundleId(opts.deviceId ?? "");
  if (!bundleId) {
    throw new InvalidToolInputError(
      `'${opts.deviceId}' is not a Mac app device id: expected macos-app-<bundle id>.`
    );
  }
  const device = resolveDevice(macosAppIdFromBundleId(bundleId));
  const ref = macosAppRef(device);
  const app = await registry.resolveService<MacosAppApi>(ref.urn, ref.options);
  // Exactly the arguments of this call, none when absent: an explicit boot
  // never reuses the arguments of an earlier start (launch-app and restart-app do).
  const { pid, appPath, sandboxed, logPath, args, alreadyRunning, note } = await app.launch({
    appPath: info?.appPath,
    args: opts.args ?? [],
    takeOver: opts.force,
    force: opts.force,
  });
  return {
    platform: "macos",
    id: device.id,
    bundleId,
    pid,
    appPath,
    sandboxed,
    logPath,
    args,
    booted: true,
    ...(alreadyRunning ? { alreadyRunning } : {}),
    ...(note ? { note } : {}),
  };
}
