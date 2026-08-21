import { mkdtemp, open, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  ArchiveError,
  extractZipArchive,
  looksLikeZip,
  safeExtractTarGzArchive,
} from "@argent/archive";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { InstallAppParams } from "./types";
import { downloadAppArtifact, type DownloadedAppArtifact } from "./download";
import { resolveAndroidPackageName } from "./android-manifest";
import { resolveIosBundleId } from "./ios-bundle";

const MAX_SEARCH_DEPTH = 6;
const MAX_ARCHIVE_DEPTH = 2;
const MAX_EXTRACTED_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;

export interface PreparedAppArtifact {
  installablePath: string;
  bundleId: string;
  cleanup(): Promise<void>;
}

function artifactFailure(message: string, cause?: unknown): FailureError {
  return new FailureError(
    message,
    {
      error_code: FAILURE_CODES.APP_INSTALL_ARTIFACT_INVALID,
      failure_stage: "app_install_materialize_artifact",
      failure_area: "tool_server",
      error_kind: "validation",
    },
    cause === undefined
      ? undefined
      : {
          cause:
            cause instanceof Error
              ? cause
              : new Error(typeof cause === "string" ? cause : "Unknown artifact error"),
        }
  );
}

async function cleanupPrepared(download: DownloadedAppArtifact, tempDirs: string[]): Promise<void> {
  for (const directory of [...tempDirs].reverse()) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
  await download.cleanup().catch(() => {});
}

async function hasGzipHeader(filePath: string): Promise<boolean> {
  const file = await open(filePath, "r").catch(() => undefined);
  if (!file) return false;
  try {
    const header = Buffer.alloc(2);
    const { bytesRead } = await file.read(header, 0, 2, 0);
    return bytesRead === 2 && header[0] === 0x1f && header[1] === 0x8b;
  } finally {
    await file.close();
  }
}

async function extractArchive(
  filePath: string,
  tempDirs: string[],
  signal?: AbortSignal
): Promise<string> {
  const outputDir = await mkdtemp(join(tmpdir(), "argent-app-archive-"));
  tempDirs.push(outputDir);
  try {
    if (await looksLikeZip(filePath)) {
      await extractZipArchive(filePath, outputDir, { signal });
      return outputDir;
    }
    if (await hasGzipHeader(filePath)) {
      await safeExtractTarGzArchive(filePath, outputDir, {
        maxUncompressedBytes: MAX_EXTRACTED_ARTIFACT_BYTES,
        signal,
      });
      return outputDir;
    }
  } catch (error) {
    if (error instanceof FailureError) throw error;
    if (signal?.aborted) throw error;
    if (error instanceof ArchiveError) {
      throw artifactFailure(error.message, error);
    }
    throw artifactFailure("Could not extract the downloaded app artifact.", error);
  }
  throw artifactFailure(
    "Downloaded app artifact must be an APK, IPA/ZIP, .tar.gz, or .tgz archive."
  );
}

async function collectPaths(
  rootPath: string,
  matches: (entryPath: string, kind: "file" | "directory") => boolean
): Promise<string[]> {
  const results: string[] = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: rootPath, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const entries = await readdir(current.path, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const entryPath = join(current.path, entry.name);
      const kind = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : undefined;
      if (!kind) continue;
      if (matches(entryPath, kind)) {
        results.push(entryPath);
        continue;
      }
      if (kind === "directory" && current.depth < MAX_SEARCH_DEPTH) {
        queue.push({ path: entryPath, depth: current.depth + 1 });
      }
    }
  }
  return results;
}

function isNestedArchivePath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    lower.endsWith(".zip") ||
    lower.endsWith(".ipa") ||
    lower.endsWith(".tar.gz") ||
    lower.endsWith(".tgz")
  );
}

async function findSingleNestedArchive(rootPath: string): Promise<string | undefined> {
  const archives = await collectPaths(
    rootPath,
    (entryPath, kind) => kind === "file" && isNestedArchivePath(entryPath)
  );
  if (archives.length > 1) {
    throw artifactFailure(
      `Downloaded artifact contains multiple nested archives; expected one app (${archives.map((archive) => basename(archive)).join(", ")}).`
    );
  }
  return archives[0];
}

async function resolveAndroidArtifact(
  sourcePath: string,
  tempDirs: string[],
  depth = 0,
  signal?: AbortSignal
): Promise<{ installablePath: string; bundleId: string }> {
  try {
    return { installablePath: sourcePath, bundleId: await resolveAndroidPackageName(sourcePath) };
  } catch (directError) {
    if (depth >= MAX_ARCHIVE_DEPTH) throw directError;
  }

  const extractedPath = await extractArchive(sourcePath, tempDirs, signal);
  const apkPaths = await collectPaths(
    extractedPath,
    (entryPath, kind) => kind === "file" && entryPath.toLowerCase().endsWith(".apk")
  );
  if (apkPaths.length > 1) {
    throw artifactFailure(
      `Downloaded artifact contains multiple APKs; expected one (${apkPaths.map((apkPath) => basename(apkPath)).join(", ")}).`
    );
  }
  if (apkPaths[0]) {
    return {
      installablePath: apkPaths[0],
      bundleId: await resolveAndroidPackageName(apkPaths[0]),
    };
  }

  const nestedArchive = await findSingleNestedArchive(extractedPath);
  if (nestedArchive) return resolveAndroidArtifact(nestedArchive, tempDirs, depth + 1, signal);
  throw artifactFailure("Downloaded Android artifact does not contain an APK.");
}

async function resolveIosArtifact(
  sourcePath: string,
  tempDirs: string[],
  depth = 0,
  signal?: AbortSignal
): Promise<{ installablePath: string; bundleId: string }> {
  const sourceStat = await stat(sourcePath).catch(() => undefined);
  if (sourceStat?.isDirectory() && sourcePath.toLowerCase().endsWith(".app")) {
    return { installablePath: sourcePath, bundleId: await resolveIosBundleId(sourcePath) };
  }
  if (depth >= MAX_ARCHIVE_DEPTH) {
    throw artifactFailure("Downloaded iOS artifact does not contain an .app bundle.");
  }

  const extractedPath = await extractArchive(sourcePath, tempDirs, signal);
  const appPaths = await collectPaths(
    extractedPath,
    (entryPath, kind) => kind === "directory" && entryPath.toLowerCase().endsWith(".app")
  );
  if (appPaths.length > 1) {
    throw artifactFailure(
      `Downloaded artifact contains multiple .app bundles; expected one (${appPaths.map((appPath) => basename(appPath)).join(", ")}).`
    );
  }
  if (appPaths[0]) {
    return {
      installablePath: appPaths[0],
      bundleId: await resolveIosBundleId(appPaths[0]),
    };
  }

  const nestedArchive = await findSingleNestedArchive(extractedPath);
  if (nestedArchive) return resolveIosArtifact(nestedArchive, tempDirs, depth + 1, signal);
  throw artifactFailure("Downloaded iOS artifact does not contain an .app bundle.");
}

async function prepareRemoteArtifact(
  params: InstallAppParams,
  platform: "android" | "ios",
  signal?: AbortSignal
): Promise<PreparedAppArtifact> {
  const download = await downloadAppArtifact(params.url, params.headers, signal);
  const tempDirs: string[] = [];
  try {
    const artifact =
      platform === "android"
        ? await resolveAndroidArtifact(download.path, tempDirs, 0, signal)
        : await resolveIosArtifact(download.path, tempDirs, 0, signal);
    return {
      ...artifact,
      cleanup: async () => {
        await cleanupPrepared(download, tempDirs);
      },
    };
  } catch (error) {
    await cleanupPrepared(download, tempDirs);
    throw error;
  }
}

export async function prepareAndroidRemoteArtifact(
  params: InstallAppParams,
  signal?: AbortSignal
): Promise<PreparedAppArtifact> {
  return prepareRemoteArtifact(params, "android", signal);
}

export async function prepareIosRemoteArtifact(
  params: InstallAppParams,
  signal?: AbortSignal
): Promise<PreparedAppArtifact> {
  return prepareRemoteArtifact(params, "ios", signal);
}
