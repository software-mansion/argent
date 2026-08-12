import { simctlLaunch, simctlTerminate } from "./sim-remote";

/**
 * Strategy for the simctl verbs that a tool handler shells out to, so the
 * shared iOS handler carries no `isRemote` branch in its body. Only the remote
 * sim uses it.
 *
 * The native-devtools DYLD env is not what keeps the local impl out: both
 * branches run the same `precheckNativeDevtools` before the verb. The handler
 * signature is. `buildIosLaunchHandler` and `buildIosRestartHandler` read
 * `services.nativeDevtools`, and `ios-remote` is the only platform that
 * declares that service. The local impl declares none - it resolves
 * native-devtools per device inside its own handler - so it has nothing to
 * hand the shared builder, and shells out to `xcrun` itself. See
 * `launch-app/platforms/ios.ts`.
 */
export interface SimctlBackend {
  launch(udid: string, bundleId: string): Promise<void>;
  terminate(udid: string, bundleId: string): Promise<void>;
}

export const remoteSimctl: SimctlBackend = {
  launch: simctlLaunch,
  terminate: simctlTerminate,
};
