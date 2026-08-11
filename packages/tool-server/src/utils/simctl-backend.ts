import { simctlLaunch, simctlTerminate } from "./sim-remote";

/**
 * Strategy for the simctl verbs that a tool handler shells out to, so the
 * shared iOS handler carries no `isRemote` branch in its body. Only the remote
 * sim needs it: the local iOS impl shells out to `xcrun` itself because it also
 * has to inject the native-devtools DYLD env before the app starts.
 */
export interface SimctlBackend {
  launch(udid: string, bundleId: string): Promise<void>;
  terminate(udid: string, bundleId: string): Promise<void>;
}

export const remoteSimctl: SimctlBackend = {
  launch: simctlLaunch,
  terminate: simctlTerminate,
};
