import type {
  NativeDevtoolsApi,
  NativeDevtoolsInitFailedResult,
} from "../../blueprints/native-devtools";

export interface LaunchAppParams {
  udid: string;
  bundleId: string;
  /** Android-only. */
  activity?: string;
  /** Apple-only: appended to the simctl / devicectl launch argv after the bundle id. */
  launchArgs?: string[];
}

export type LaunchAppResult =
  | {
      launched: boolean;
      bundleId: string;
      /** Mac apps: the `.app` that runs. */
      appPath?: string;
      /** Mac apps: the arguments the app runs with. */
      args?: string[];
      note?: string;
      /** Once network-capture-start started native network capture for the app: whether it followed the app into this process, or that it is stopped. */
      networkCapture?: string;
    }
  | NativeDevtoolsInitFailedResult;

export interface LaunchAppIosServices {
  nativeDevtools: NativeDevtoolsApi;
}
export type LaunchAppVegaServices = Record<string, never>;
export type LaunchAppHarmonyServices = Record<string, never>;
