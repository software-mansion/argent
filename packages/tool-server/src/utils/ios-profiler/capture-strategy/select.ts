import { execSync } from "child_process";
import type { IosCaptureStrategy } from "./types";
import { deviceStrategy } from "./device";
import { allProcessesStrategy } from "./all-processes";

/**
 * Pick the iOS capture strategy for the current environment.
 *
 * Order of precedence:
 *  1. The `ARGENT_IOS_CAPTURE` env override ("device" | "all-processes") — an
 *     explicit escape hatch for both directions.
 *  2. Active Xcode version: 26.4–27.0 are "degraded" (the `--device` recording
 *     handshake deadlocks) → use the all-processes fallback. Everything else
 *     (≤ 26.3, and whatever fixed version Apple ships) → use the device path.
 *  3. If the version can't be determined, default to the device strategy so the
 *     original behaviour is preserved; force the fallback via the env override.
 */

const ENV_OVERRIDE = "ARGENT_IOS_CAPTURE";

interface XcodeVersion {
  major: number;
  minor: number;
}

function readActiveXcodeVersion(): XcodeVersion | null {
  try {
    // `xcodebuild -version` honours DEVELOPER_DIR / xcode-select and prints
    // e.g. "Xcode 26.5\nBuild version 17F42".
    const out = execSync("xcodebuild -version", {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = out.match(/Xcode\s+(\d+)\.(\d+)/);
    if (!m) return null;
    return { major: Number(m[1]), minor: Number(m[2]) };
  } catch {
    return null;
  }
}

/**
 * True for Xcode versions where `xctrace record --device <sim>` deadlocks at the
 * recording-start handshake. Currently 26.4 through 27.0 (the upper bound is the
 * last version observed broken; revisit when Apple ships a fix and either bound
 * this range or drop the entry).
 */
function isDegraded({ major, minor }: XcodeVersion): boolean {
  if (major === 26) return minor >= 4;
  if (major === 27) return minor <= 0;
  return false;
}

function fromEnv(): IosCaptureStrategy | null {
  const raw = process.env[ENV_OVERRIDE]?.trim().toLowerCase();
  if (!raw) return null;
  if (raw === "device") return deviceStrategy;
  if (raw === "all-processes" || raw === "all_processes" || raw === "allprocesses") {
    return allProcessesStrategy;
  }
  process.stderr.write(
    `[native-profiler] ignoring unrecognised ${ENV_OVERRIDE}="${raw}" ` +
      `(expected "device" or "all-processes"); falling back to auto-detection.\n`
  );
  return null;
}

export function selectIosCaptureStrategy(): IosCaptureStrategy {
  const override = fromEnv();
  if (override) {
    process.stderr.write(
      `[native-profiler] using "${override.name}" capture (forced via ${ENV_OVERRIDE}).\n`
    );
    return override;
  }

  const version = readActiveXcodeVersion();
  if (version && isDegraded(version)) {
    process.stderr.write(
      `[native-profiler] Xcode ${version.major}.${version.minor} has the xctrace ` +
        `--device recording-start deadlock; using the "${allProcessesStrategy.name}" ` +
        `capture fallback. Override with ${ENV_OVERRIDE}=device.\n`
    );
    return allProcessesStrategy;
  }

  return deviceStrategy;
}
