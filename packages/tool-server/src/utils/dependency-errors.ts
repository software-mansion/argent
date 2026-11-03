import { FAILURE_CODES, withFailureSignal, type ToolDependency } from "@argent/registry";
import {
  xcodeFirstLaunchHint,
  xcodeFirstLaunchPending,
  type XcodeWrapper,
} from "./xcode-first-launch";

/**
 * Thrown when a declared host-binary dependency (e.g. `adb`, `xcrun`) can't be
 * resolved. The HTTP dispatcher maps it to 424; `.message` is the install hint,
 * safe to bubble straight to the agent.
 */
export class DependencyMissingError extends Error {
  readonly missing: ToolDependency[];
  constructor(missing: ToolDependency[], message: string) {
    super(message);
    this.name = "DependencyMissingError";
    this.missing = missing;
    withFailureSignal(this, {
      error_code: FAILURE_CODES.TOOL_DEPENDENCY_MISSING,
      failure_stage: "tool_dependency_preflight",
      failure_area: "tool_server",
      error_kind: "dependency_missing",
    });
  }
}

/**
 * `wrappers` would start Xcode's component install, which waits forever for
 * an administrator password. Mapped to 424 like any missing dependency, with
 * the hint as the message, but counted apart from a missing `xcrun` in failure
 * telemetry.
 */
export class XcodeFirstLaunchPendingError extends DependencyMissingError {
  constructor(wrappers: readonly XcodeWrapper[]) {
    super(["xcrun"], xcodeFirstLaunchHint(wrappers));
    this.name = "XcodeFirstLaunchPendingError";
    withFailureSignal(this, {
      error_code: FAILURE_CODES.TOOL_XCODE_FIRST_LAUNCH_PENDING,
      failure_stage: "xcode_first_launch_check",
      failure_area: "tool_server",
      error_kind: "dependency_missing",
    });
  }
}

/**
 * Refuse before spawning `wrapper` while it would start Xcode's component
 * install. Called where the argv is built, so no caller can reach the wrapper
 * without it.
 *
 * @throws XcodeFirstLaunchPendingError
 */
export function assertXcodeFirstLaunchDone(wrapper: XcodeWrapper): void {
  if (xcodeFirstLaunchPending(wrapper)) throw new XcodeFirstLaunchPendingError([wrapper]);
}
