import { FAILURE_CODES, FailureError } from "@argent/registry";
import { prepareIosRemoteArtifact } from "../artifact";
import type { InstallAppParams, InstallAppResult } from "../types";

type IosInstaller = (udid: string, appPath: string, signal?: AbortSignal) => Promise<void>;

export async function installDownloadedIosApp(
  params: InstallAppParams,
  signal: AbortSignal | undefined,
  install: IosInstaller,
  failureStage: string
): Promise<InstallAppResult> {
  const artifact = await prepareIosRemoteArtifact(params, signal);
  try {
    await install(params.udid, artifact.installablePath, signal);
    return { installed: true, bundleId: artifact.bundleId };
  } catch (error) {
    if (error instanceof FailureError) throw error;
    throw new FailureError(
      `Failed to install downloaded iOS app bundle on ${params.udid}.`,
      {
        error_code: FAILURE_CODES.IOS_INSTALL_FAILED,
        failure_stage: failureStage,
        failure_area: "tool_server",
        error_kind: signal?.aborted ? "unknown" : "subprocess",
        failure_command: "unknown",
      },
      { cause: error instanceof Error ? error : new Error(String(error)) }
    );
  } finally {
    await artifact.cleanup();
  }
}
