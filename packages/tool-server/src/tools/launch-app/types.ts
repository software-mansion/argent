import type { NativeDevtoolsInitFailedResult } from "../../blueprints/native-devtools";

export interface LaunchAppParams {
  udid: string;
  bundleId: string;
  /** Android-only: ignored on iOS. */
  activity?: string;
}

export type LaunchAppResult =
  | { launched: boolean; bundleId: string }
  | NativeDevtoolsInitFailedResult;
