import { simctlLaunch, simctlTerminate } from "./sim-remote";

/**
 * The simctl verbs a tool handler shells out to, behind one interface so the
 * shared iOS handler (`launch-app/platforms/shared.ts` and its restart-app
 * twin) carries no `isRemote` branch in its body.
 *
 * One implementation today, `remoteSimctl`, with `ios-remote` as its only
 * caller. The local iOS impl could satisfy the shared handler's parameter:
 * `buildIosLaunchHandler` takes `(services: LaunchAppIosServices, params)`, and
 * `launch-app/platforms/ios.ts` resolves a concrete `NativeDevtoolsApi` out of
 * the registry before its own `precheckNativeDevtools`, so `{ nativeDevtools }`
 * is in hand at that point. What keeps it off is one level up: the tool's
 * `services()` returns `{}` for `platform === "ios"` (`launch-app/index.ts`,
 * `restart-app/index.ts`) because only `ios-remote` declares the eager service,
 * so `services.nativeDevtools` would be `undefined` at runtime. Local iOS
 * resolves it lazily inside its handler instead - which is what stops a tvOS
 * udid spinning up the iOS-only injection - and shells out to `xcrun` itself.
 * Merging the two branches means changing that `services()` first.
 */
export interface SimctlBackend {
  launch(udid: string, bundleId: string): Promise<void>;
  terminate(udid: string, bundleId: string): Promise<void>;
}

export const remoteSimctl: SimctlBackend = {
  launch: simctlLaunch,
  terminate: simctlTerminate,
};
