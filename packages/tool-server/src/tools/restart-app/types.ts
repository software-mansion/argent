import type {
  NativeDevtoolsApi,
  NativeDevtoolsInitFailedResult,
} from "../../blueprints/native-devtools";

export interface RestartAppParams {
  udid: string;
  bundleId: string;
  /** Android-only: ignored on iOS. */
  activity?: string;
  /** Apple-only: appended to the simctl / devicectl launch argv after the bundle id. */
  launchArgs?: string[];
}

export type RestartAppResult =
  | {
      restarted: boolean;
      bundleId: string;
      /** Once network-capture-start started native network capture for the app: whether it followed the app into the new process, or that it is stopped. */
      networkCapture?: string;
    }
  | NativeDevtoolsInitFailedResult;

export interface RestartAppIosServices {
  nativeDevtools: NativeDevtoolsApi;
}
export type RestartAppVegaServices = Record<string, never>;
export type RestartAppHarmonyServices = Record<string, never>;
