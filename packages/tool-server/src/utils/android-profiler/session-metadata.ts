import { promises as fs } from "fs";

export interface AndroidNativeProfilerMetadata {
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

  const parsed = JSON.parse(raw) as Partial<AndroidNativeProfilerMetadata>;
  if (
    parsed.platform !== "android" ||
    typeof parsed.appProcess !== "string" ||
    parsed.appProcess.trim() === "" ||
    (parsed.wallClockStartMs !== null && typeof parsed.wallClockStartMs !== "number")
  ) {
    throw new Error(`Invalid Android profiler metadata sidecar at ${metadataPath}`);
  }

  return {
    platform: "android",
    appProcess: parsed.appProcess,
    wallClockStartMs: parsed.wallClockStartMs,
  };
}
