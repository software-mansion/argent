import { execFileSync } from "child_process";
import type { IosCaptureStrategy } from "./types";
import { deviceStrategy } from "./device";
import { allProcessesStrategy } from "./all-processes";

/**
 * Pick the iOS capture strategy, in precedence order:
 *  1. `ARGENT_IOS_CAPTURE` ("device" | "all-processes") — an explicit escape hatch
 *     in both directions.
 *  2. Xcode 26.4 and later deadlock in the `--device` recording handshake, so they
 *     take the all-processes fallback.
 *  3. Unknown version → device strategy, preserving the original behaviour.
 */

const ENV_OVERRIDE = "ARGENT_IOS_CAPTURE";

interface XcodeVersion {
  major: number;
  minor: number;
}

/**
 * Why a strategy was chosen, so callers that gate on the decision (the
 * malloc_stack_logging guard, which rejects anything but `device`) can name the real
 * cause instead of always blaming a degraded Xcode.
 */
export type CaptureStrategyReason =
  | {
      kind: "env-override";
      strategyName: IosCaptureStrategy["name"];
      /** The value the operator set, trimmed with case preserved — may be an alias or
       *  mixed-case form of `strategyName`, so quote THIS when echoing it back. */
      rawValue: string;
    }
  | { kind: "degraded-xcode"; major: number; minor: number }
  | { kind: "default" };

interface CaptureStrategyDecision {
  strategy: IosCaptureStrategy;
  reason: CaptureStrategyReason;
  /** Set when ARGENT_IOS_CAPTURE held an unrecognised value that was ignored. */
  invalidOverride?: string;
}

type OverrideParse =
  | { kind: "device"; raw: string }
  | { kind: "all-processes"; raw: string }
  | { kind: "none" }
  | { kind: "invalid"; raw: string };

function parseEnvOverride(): OverrideParse {
  // Keep the operator's original spelling for echoing back; classify on a lower-cased
  // copy so aliases and casing still match.
  const original = process.env[ENV_OVERRIDE]?.trim();
  if (!original) return { kind: "none" };
  const raw = original.toLowerCase();
  if (raw === "device") return { kind: "device", raw: original };
  if (raw === "all-processes" || raw === "all_processes" || raw === "allprocesses") {
    return { kind: "all-processes", raw: original };
  }
  return { kind: "invalid", raw: original };
}

function readActiveXcodeVersion(): XcodeVersion | null {
  try {
    // `xcodebuild -version` honours DEVELOPER_DIR / xcode-select and prints e.g.
    // "Xcode 26.5\nBuild version 17F42". execFileSync (no shell) keeps the
    // iOS-profiler subsystem shell-free.
    const out = execFileSync("xcodebuild", ["-version"], {
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
 * recording-start handshake: every 26.x from 26.4 up, plus all of 27+ assumed broken
 * for want of a known upper bound. Narrow this when Apple fixes it; until then a
 * known-good version needs ARGENT_IOS_CAPTURE=device.
 */
function isDegraded({ major, minor }: XcodeVersion): boolean {
  if (major === 26) return minor >= 4;
  return major >= 27;
}

/**
 * Resolve the strategy and the reason for it with no side effects — nothing is written
 * to stderr. Callers that may reject the decision outright (the malloc_stack_logging
 * guard) would otherwise print a "using the all-processes fallback" line for a capture
 * that never happens; {@link selectIosCaptureStrategy} logs for the normal record flow.
 */
export function resolveIosCaptureStrategy(): CaptureStrategyDecision {
  const override = parseEnvOverride();
  if (override.kind === "device") {
    return {
      strategy: deviceStrategy,
      reason: { kind: "env-override", strategyName: deviceStrategy.name, rawValue: override.raw },
    };
  }
  if (override.kind === "all-processes") {
    return {
      strategy: allProcessesStrategy,
      reason: {
        kind: "env-override",
        strategyName: allProcessesStrategy.name,
        rawValue: override.raw,
      },
    };
  }

  const invalidOverride = override.kind === "invalid" ? override.raw : undefined;

  const version = readActiveXcodeVersion();
  if (version && isDegraded(version)) {
    return {
      strategy: allProcessesStrategy,
      reason: { kind: "degraded-xcode", major: version.major, minor: version.minor },
      invalidOverride,
    };
  }

  return { strategy: deviceStrategy, reason: { kind: "default" }, invalidOverride };
}

/**
 * Warn on stderr when `ARGENT_IOS_CAPTURE` held an unrecognised value. Shared with the
 * malloc_stack_logging guard, which resolves via {@link resolveIosCaptureStrategy} and
 * would otherwise drop a typo'd override silently while advising the user to set that
 * very variable.
 */
export function warnIfInvalidCaptureOverride(decision: CaptureStrategyDecision): void {
  if (decision.invalidOverride) {
    process.stderr.write(
      `[native-profiler] ignoring unrecognised ${ENV_OVERRIDE}="${decision.invalidOverride}" ` +
        `(expected "device" or "all-processes"); falling back to auto-detection.\n`
    );
  }
}

export function selectIosCaptureStrategy(): IosCaptureStrategy {
  const decision = resolveIosCaptureStrategy();

  warnIfInvalidCaptureOverride(decision);

  switch (decision.reason.kind) {
    case "env-override":
      process.stderr.write(
        `[native-profiler] using "${decision.strategy.name}" capture (forced via ${ENV_OVERRIDE}).\n`
      );
      break;
    case "degraded-xcode":
      process.stderr.write(
        `[native-profiler] Xcode ${decision.reason.major}.${decision.reason.minor} has the xctrace ` +
          `--device recording-start deadlock; using the "${allProcessesStrategy.name}" ` +
          `capture fallback. Override with ${ENV_OVERRIDE}=device.\n`
      );
      break;
    case "default":
      break;
  }

  return decision.strategy;
}
