import type {
  NativeDevtoolsApi,
  NativeDevtoolsInitFailedResult,
} from "../../blueprints/native-devtools";

export interface LaunchAppParams {
  udid: string;
  bundleId: string;
  /** Android-only. */
  activity?: string;
}

export type LaunchAppResult =
  | {
      launched: boolean;
      bundleId: string;
      /**
       * Android: the launch overran the platform's wait window and was confirmed
       * by checking the app's process, so the app may not be interactive yet.
       * Physical iPhone: runner signing is not ready.
       */
      note?: string;
    }
  | NativeDevtoolsInitFailedResult;

export interface LaunchAppIosServices {
  nativeDevtools: NativeDevtoolsApi;
}
export type LaunchAppVegaServices = Record<string, never>;
