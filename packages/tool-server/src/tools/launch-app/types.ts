import type {
  NativeDevtoolsApi,
  NativeDevtoolsInitFailedResult,
} from "../../blueprints/native-devtools";

export interface LaunchAppParams {
  udid: string;
  bundleId: string;
  /** Android-only. */
  activity?: string;
  /** Apple simulator-only: appended to the simctl launch argv after the bundle id. */
  launchArgs?: string[];
}

export type LaunchAppResult =
  | { launched: boolean; bundleId: string }
  | NativeDevtoolsInitFailedResult;

export interface LaunchAppIosServices {
  nativeDevtools: NativeDevtoolsApi;
}
export type LaunchAppAndroidServices = Record<string, never>;
export type LaunchAppVegaServices = Record<string, never>;
