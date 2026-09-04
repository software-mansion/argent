import { promises as fs } from "fs";
import { FAILURE_CODES, FailureError } from "@argent/registry";

interface AndroidNativeProfilerMetadata {
  platform: "android";
  appProcess: string;
  wallClockStartMs: number | null;
}

export function androidNativeProfilerMetadataPath(pftracePath: string): string {
  return `${pftracePath}.metadata.json`;
}

export async function writeAndroidNativeProfilerMetadata(
  pftracePath: string,
  metadata: AndroidNativeProfilerMetadata
): Promise<void> {
  await fs.writeFile(
    androidNativeProfilerMetadataPath(pftracePath),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8"
  );
}

export async function readAndroidNativeProfilerMetadata(
  pftracePath: string
): Promise<AndroidNativeProfilerMetadata | null> {
  const metadataPath = androidNativeProfilerMetadataPath(pftracePath);
  let raw: string;
  try {
    raw = await fs.readFile(metadataPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  // Present-but-unusable gets its own code: PROFILER_NATIVE_METADATA_MISSING
  // means no usable appProcess at the profiler-load call site.
  let parsed: Partial<AndroidNativeProfilerMetadata>;
  try {
    parsed = JSON.parse(raw) as Partial<AndroidNativeProfilerMetadata>;
  } catch (err) {
    throw new FailureError(
      `Android profiler metadata sidecar at ${metadataPath} is not valid JSON.`,
      {
        error_code: FAILURE_CODES.PROFILER_NATIVE_METADATA_INVALID,
        failure_stage: "android_metadata_parse",
        failure_area: "tool_server",
        error_kind: "validation",
      },
      { cause: err instanceof Error ? err : new Error(String(err)) }
    );
  }
  if (
    parsed.platform !== "android" ||
    typeof parsed.appProcess !== "string" ||
    parsed.appProcess.trim() === "" ||
    (parsed.wallClockStartMs !== null && typeof parsed.wallClockStartMs !== "number")
  ) {
    throw new FailureError(`Invalid Android profiler metadata sidecar at ${metadataPath}`, {
      error_code: FAILURE_CODES.PROFILER_NATIVE_METADATA_INVALID,
      failure_stage: "android_metadata_validate",
      failure_area: "tool_server",
      error_kind: "validation",
    });
  }

  return {
    platform: "android",
    appProcess: parsed.appProcess,
    wallClockStartMs: parsed.wallClockStartMs,
  };
}
