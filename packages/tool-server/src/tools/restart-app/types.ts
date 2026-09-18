import type {
  NativeDevtoolsApi,
  NativeDevtoolsInitFailedResult,
} from "../../blueprints/native-devtools";

export interface RestartAppParams {
  udid: string;
  bundleId: string;
  activity?: string;
}

export type RestartAppResult =
  | {
      restarted: boolean;
      bundleId: string;
      /**
       * Android only: set when the launch overran Android's wait window and was
       * confirmed by checking the app's process instead. The app is up but may not
       * be interactive yet.
       */
      note?: string;
    }
  | NativeDevtoolsInitFailedResult;

export interface RestartAppIosServices {
  nativeDevtools: NativeDevtoolsApi;
}
export type RestartAppVegaServices = Record<string, never>;
