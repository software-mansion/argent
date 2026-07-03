// Typed telemetry event names and property shapes. sanitize.ts enforces the
// same surface at runtime.

import type { FailureSignal } from "@argent/registry";
import type { AiTelemetryProps } from "./ai-identity.js";

// Single source of truth for the device platform enum: the TS union below and
// sanitize.ts's runtime allowlist both derive from this tuple, so adding a
// platform can't silently drift the two apart.
export const PLATFORMS = ["ios", "ios-remote", "android", "chromium", "vega"] as const;
export type Platform = (typeof PLATFORMS)[number];

// Installation events

export type FailureTelemetryProps = Partial<FailureSignal>;

export interface InstallationCliInitStartProps {
  package_manager: "npm" | "yarn" | "pnpm" | "bun" | "unknown";
  is_non_interactive: boolean;
}

export interface InstallationCliInitCompleteProps extends FailureTelemetryProps {
  duration_ms: number;
  is_success: boolean;
  editors_configured_count: number;
  install_mode?: "global" | "local";
}

export interface InstallationCliInitCancelProps {
  step: "global_install" | "editors" | "scope" | "skills" | "allowlist" | "install_mode";
}

export interface InstallationInstallModeDecisionProps {
  install_mode: "global" | "local";
}

export interface InstallationGlobalInstallDecisionProps {
  /** The developer-only `--from <tarball>` path is not reported. */
  decision: "install" | "cancel" | "already_installed";
}

export interface InstallationUpdateDecisionProps {
  from_major: number;
  to_major: number;
  decision: "update" | "skip" | "no_update";
}

export interface InstallationEditorsSelectProps {
  /** Bounded list of adapter names — sanitizer caps to 16 elements. */
  editors: string[];
  detected_editor_count: number;
  scope: "local" | "global" | "custom";
  install_mode?: "global" | "local";
}

export interface InstallationAllowlistDecisionProps {
  is_enabled: boolean;
}

export interface InstallationSkillInstallProps {
  method: "default" | "interactive" | "manual";
  is_online: boolean;
  has_offline_cache: boolean;
  outcome: "success" | "failure" | "skipped";
}

export interface InstallationSkillRefreshResultProps extends FailureTelemetryProps {
  is_success: boolean;
  scope_count: number;
  synced_count: number;
  pruned_count: number;
  failed_count: number;
}

export type InstallationPackageActionTrigger = "init" | "update" | "mcp_update";

export type InstallationPackageAction =
  | "fresh_install"
  | "already_installed"
  | "init_triggered_update"
  | "no_update"
  | "update_skipped"
  | "update_failed"
  | "standalone_update"
  | "standalone_install"
  | "mcp_update";

export interface InstallationPackageActionProps extends FailureTelemetryProps {
  trigger: InstallationPackageActionTrigger;
  action: InstallationPackageAction;
  is_success: boolean;
  duration_ms: number;
}

export type InstallationCliUpdateStartProps = Record<string, never>;

export interface InstallationCliUpdateCompleteProps {
  duration_ms: number;
  install_mode?: "global" | "local";
}

export interface InstallationCliUpdateFailProps extends FailureTelemetryProps {
  duration_ms: number;
  install_mode?: "global" | "local";
}

export type InstallationCliUninstallStartProps = Record<string, never>;

export interface InstallationCliUninstallCompleteProps extends FailureTelemetryProps {
  has_pruned_content: boolean;
  has_uninstalled_package: boolean;
  install_mode?: "global" | "local";
}

// Tool usage events

export interface ToolInvokeProps extends AiTelemetryProps {
  tool: string;
  tool_invocation_id: string;
  platform?: Platform;
}

export interface ToolCompleteProps extends AiTelemetryProps {
  tool: string;
  tool_invocation_id: string;
  platform?: Platform;
  duration_ms: number;
}

export interface ToolFailProps extends FailureTelemetryProps, AiTelemetryProps {
  tool: string;
  tool_invocation_id?: string;
  platform?: Platform;
  duration_ms: number;
}

// CLI command events

export interface CliRunFailProps extends FailureTelemetryProps {
  tool: string;
  duration_ms: number;
}

// Lifecycle events

export type ToolserverStartProps = Record<string, never>;

export interface ToolserverStopProps extends FailureTelemetryProps {
  reason: "idle" | "signal" | "crash";
  uptime_ms: number;
  total_tool_calls: number;
}

// Discriminated union for typed-track()

export interface EventPropertyMap {
  "installation:cli_init_start": InstallationCliInitStartProps;
  "installation:cli_init_complete": InstallationCliInitCompleteProps;
  "installation:cli_init_cancel": InstallationCliInitCancelProps;
  "installation:install_mode_decision": InstallationInstallModeDecisionProps;
  "installation:global_install_decision": InstallationGlobalInstallDecisionProps;
  "installation:update_decision": InstallationUpdateDecisionProps;
  "installation:editors_select": InstallationEditorsSelectProps;
  "installation:allowlist_decision": InstallationAllowlistDecisionProps;
  "installation:skill_install": InstallationSkillInstallProps;
  "installation:skill_refresh_result": InstallationSkillRefreshResultProps;
  "installation:package_action": InstallationPackageActionProps;
  "installation:cli_update_start": InstallationCliUpdateStartProps;
  "installation:cli_update_complete": InstallationCliUpdateCompleteProps;
  "installation:cli_update_fail": InstallationCliUpdateFailProps;
  "installation:cli_uninstall_start": InstallationCliUninstallStartProps;
  "installation:cli_uninstall_complete": InstallationCliUninstallCompleteProps;
  "tool:invoke": ToolInvokeProps;
  "tool:complete": ToolCompleteProps;
  "tool:fail": ToolFailProps;
  "cli:run_fail": CliRunFailProps;
  "toolserver:start": ToolserverStartProps;
  "toolserver:stop": ToolserverStopProps;
}

export type EventName = keyof EventPropertyMap;

/** Static list consumed by sanitize.ts and coverage tests. */
export const EVENT_NAMES: readonly EventName[] = [
  "installation:cli_init_start",
  "installation:cli_init_complete",
  "installation:cli_init_cancel",
  "installation:install_mode_decision",
  "installation:global_install_decision",
  "installation:update_decision",
  "installation:editors_select",
  "installation:allowlist_decision",
  "installation:skill_install",
  "installation:skill_refresh_result",
  "installation:package_action",
  "installation:cli_update_start",
  "installation:cli_update_complete",
  "installation:cli_update_fail",
  "installation:cli_uninstall_start",
  "installation:cli_uninstall_complete",
  "tool:invoke",
  "tool:complete",
  "tool:fail",
  "cli:run_fail",
  "toolserver:start",
  "toolserver:stop",
];
