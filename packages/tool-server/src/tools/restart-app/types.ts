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
      /** Android, while native network capture is on for the app: whether it followed the app into the new process. */
      networkCapture?: string;
    }
  | NativeDevtoolsInitFailedResult;

export interface RestartAppIosServices {
  nativeDevtools: NativeDevtoolsApi;
}
export type RestartAppVegaServices = Record<string, never>;
