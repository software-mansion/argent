import { execFileSync } from "child_process";
import type { IosCaptureStrategy } from "./types";
import { deviceStrategy } from "./device";
import { allProcessesStrategy } from "./all-processes";

/**
 * Pick the iOS capture strategy for the current environment.
 *
 * Order of precedence:
 *  1. The `ARGENT_IOS_CAPTURE` env override ("device" | "all-processes") — an
 *     explicit escape hatch for both directions.
 *  2. Active Xcode version: 26.4 and later are "degraded" (the `--device` recording
 *     handshake deadlocks) → use the all-processes fallback. Only ≤ 26.3 uses the
 *     device path; when Apple ships a fixed build, narrow isDegraded() to re-enable it.
 *  3. If the version can't be determined, default to the device strategy so the
 *     original behaviour is preserved; force the fallback via the env override.
 */

const ENV_OVERRIDE = "ARGENT_IOS_CAPTURE";

interface XcodeVersion {
  major: number;
  minor: number;
}

/**
 * Why a given strategy was chosen. Callers that need to explain or gate on the
 * decision (e.g. the malloc_stack_logging guard, which rejects when the strategy
 * isn't `device`) can attribute the outcome accurately instead of assuming it is
 * always a degraded Xcode.
 */
export type CaptureStrategyReason =
  | {
      kind: "env-override";
      strategyName: IosCaptureStrategy["name"];
      /** The literal ARGENT_IOS_CAPTURE value the operator set (trimmed, case preserved),
       *  which may be an alias/mixed-case form of `strategyName` — quote THIS when echoing
       *  the override back to the user so the message names what they actually set. */
      rawValue: string;
    }
  | { kind: "degraded-xcode"; major: number; minor: number }
  | { kind: "default" };

export interface CaptureStrategyDecision {
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
  // Keep the original (trimmed, case-preserved) value so callers can echo exactly
  // what the operator set; classify on a lower-cased copy so aliases/case still match.
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
    // `xcodebuild -version` honours DEVELOPER_DIR / xcode-select and prints
    // e.g. "Xcode 26.5\nBuild version 17F42". Argv (execFileSync, no shell) to
    // keep the iOS-profiler subsystem uniformly shell-free.
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
 * recording-start handshake. Known broken from 26.4 onwards with no upper bound; we
 * conservatively treat ALL of 27+ as broken by default (the regression has shipped
 * across every build tested so far, 26.4 through 27.x). When Apple fixes it, narrow
 * this bound — until then, force the original path on a known-good version via
 * ARGENT_IOS_CAPTURE=device.
 */
function isDegraded({ major, minor }: XcodeVersion): boolean {
  if (major === 26) return minor >= 4;
  return major >= 27;
}

/**
 * Resolve the capture strategy **and why** it was chosen, with **no side effects**
 * — nothing is written to stderr. Callers that log the decision (the normal record
 * flow, via {@link selectIosCaptureStrategy}) can do so; callers that may reject
 * the decision outright (the malloc_stack_logging guard) get the reason without a
 * misleading "using the all-processes fallback" line that never actually happens.
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
 * Warn (once, to stderr) when `ARGENT_IOS_CAPTURE` held an unrecognised value that
 * was ignored. Shared by the normal record flow ({@link selectIosCaptureStrategy})
 * and the malloc_stack_logging guard, which resolves the strategy directly via
 * {@link resolveIosCaptureStrategy} (side-effect-free) and would otherwise swallow a
 * typo'd override silently — leaving the user with no clue their value was dropped.
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
