import type { NativeDevtoolsInitFailedResult } from "../../blueprints/native-devtools";

export interface RestartAppParams {
  udid: string;
  bundleId: string;
  activity?: string;
}

export type RestartAppResult =
  | { restarted: boolean; bundleId: string }
  | NativeDevtoolsInitFailedResult;
