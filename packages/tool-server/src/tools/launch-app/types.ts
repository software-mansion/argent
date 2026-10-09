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
      note?: string;
      /** Android, while native network capture is on for the app: whether it followed the app into this process. */
      networkCapture?: string;
    }
  | NativeDevtoolsInitFailedResult;

export interface LaunchAppIosServices {
  nativeDevtools: NativeDevtoolsApi;
}
export type LaunchAppVegaServices = Record<string, never>;
