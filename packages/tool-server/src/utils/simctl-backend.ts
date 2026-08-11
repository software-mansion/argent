import { simctlLaunch, simctlTerminate } from "./sim-remote";

/**
 * Strategy for the simctl verbs that a tool handler shells out to, so the
 * shared iOS handler carries no `isRemote` branch in its body. Only the remote
 * sim uses it.
 *
 * The native-devtools DYLD env is not what keeps the local impl out: both
 * branches run the same `precheckNativeDevtools` before the verb. The local
 * impl resolves native-devtools lazily through `registry`, per device, via
 * `nativeDevtoolsRef(device)` rather than as an eager declared service - that
 * is what lets one impl cover the iOS and tvOS slices, and what stops a tvOS
 * udid spinning up the iOS-only injection. See `launch-app/platforms/ios.ts`.
 */
export interface SimctlBackend {
  launch(udid: string, bundleId: string): Promise<void>;
  terminate(udid: string, bundleId: string): Promise<void>;
}

export const remoteSimctl: SimctlBackend = {
  launch: simctlLaunch,
  terminate: simctlTerminate,
};
