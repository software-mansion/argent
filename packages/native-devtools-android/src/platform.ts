import * as os from "node:os";
import * as path from "node:path";
import { TraceProcessorUnavailableError } from "./errors";

/**
 * Host-platform suffixes argent publishes `trace_processor_shell` for. These
 * mirror the `for PLATFORM in …` loop in argent-private's
 * build-native-binaries.yml and the `uname` case-switch in
 * scripts/download-native-binaries.sh — keep all three in sync.
 */
export type TraceProcessorPlatform = "mac-arm64" | "mac-amd64" | "linux-amd64" | "linux-arm64";

/**
 * Map this host's OS + CPU to the platform suffix of the matching
 * `trace_processor_shell` release asset. Mirrors the `uname -s -m` case-switch
 * in scripts/download-native-binaries.sh (Node reports `x86_64` as `x64` and
 * `aarch64` as `arm64`). Throws `TraceProcessorUnavailableError(unsupported_platform)`
 * on Windows or any arch we don't publish a binary for.
 *
 * `platform`/`arch` default to the running process but are injectable so the
 * mapping table can be unit-tested without spawning sub-processes.
 */
export function detectHostPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): TraceProcessorPlatform {
  if (platform === "darwin") {
    if (arch === "arm64") return "mac-arm64";
    if (arch === "x64") return "mac-amd64";
  } else if (platform === "linux") {
    if (arch === "x64") return "linux-amd64";
    if (arch === "arm64") return "linux-arm64";
  }
  throw new TraceProcessorUnavailableError("unsupported_platform", {
    platform: `${platform}-${arch}`,
  });
}

/**
 * Non-throwing variant of {@link detectHostPlatform}. Returns null on an
 * unsupported host so callers that want to *skip* (the installer's optional
 * download, the wrong-arch error's best-effort platform tag) don't have to
 * try/catch.
 */
export function tryDetectHostPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): TraceProcessorPlatform | null {
  try {
    return detectHostPlatform(platform, arch);
  } catch {
    return null;
  }
}

/**
 * Version-keyed cache directory for a downloaded `trace_processor_shell`:
 * `~/.argent/trace-processor/<perfetto-version>/<platform>/`. Keying on the
 * Perfetto version means a version bump auto-invalidates the cache (a new path)
 * rather than silently serving a stale binary; living under `~/.argent` (next
 * to tool-server.json) survives reinstalls / npx GC and works for global/root
 * installs. Mirrors the Playwright/Cypress download-cache pattern.
 */
export function traceProcessorCacheDir(
  version: string,
  platform: TraceProcessorPlatform
): string {
  return path.join(os.homedir(), ".argent", "trace-processor", version, platform);
}

/** Full path to the cached binary inside {@link traceProcessorCacheDir}. */
export function traceProcessorCachePath(
  version: string,
  platform: TraceProcessorPlatform
): string {
  return path.join(traceProcessorCacheDir(version, platform), "trace_processor_shell");
}
