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
      /** Mac apps: the arguments the app runs with. */
      args?: string[];
      note?: string;
    }
  | NativeDevtoolsInitFailedResult;

export interface LaunchAppIosServices {
  nativeDevtools: NativeDevtoolsApi;
}
export type LaunchAppVegaServices = Record<string, never>;
export type LaunchAppHarmonyServices = Record<string, never>;
