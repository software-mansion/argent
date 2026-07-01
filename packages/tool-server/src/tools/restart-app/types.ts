import type { NativeDevtoolsInitFailedResult } from "../../blueprints/native-devtools";

export interface RestartAppParams {
  udid: string;
  bundleId: string;
  activity?: string;
}

export type RestartAppResult =
  | { restarted: boolean; bundleId: string }
  | NativeDevtoolsInitFailedResult;

// Vega's restart handler takes no services (it drives the `vega`/`kepler` CLI
// directly); the explicit empty shape keeps `dispatchByPlatform`'s per-branch
// generics distinct. iOS resolves native-devtools lazily through `registry` in
// its handler rather than via an eager service, so it needs no service type
// here; Android likewise uses the generic empty record.
export type RestartAppVegaServices = Record<string, never>;
