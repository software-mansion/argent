// Typed telemetry event names and property shapes. sanitize.ts enforces the
// same surface at runtime.

// Installation events

export interface InstallationCliInitStartProps {
  package_manager: "npm" | "yarn" | "pnpm" | "bun" | "unknown";
  is_non_interactive: boolean;
}

export interface InstallationCliInitCompleteProps {
  duration_ms: number;
  is_success: boolean;
  editors_configured_count: number;
}

export interface InstallationCliInitCancelProps {
  step: "global_install" | "editors" | "scope" | "skills" | "allowlist";
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
}

export interface InstallationAllowlistDecisionProps {
  is_enabled: boolean;
  applicable_adapter_count: number;
}

export interface InstallationSkillInstallProps {
  method: "default" | "interactive" | "manual";
  is_online: boolean;
  has_offline_cache: boolean;
}

export interface InstallationSkillInstallResultProps {
  is_success: boolean;
}

export interface InstallationRulesAgentsCopyProps {
  copied_count: number;
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

export interface InstallationPackageActionProps {
  trigger: InstallationPackageActionTrigger;
  action: InstallationPackageAction;
  is_success: boolean;
  duration_ms: number;
}

export interface InstallationCliUpdateStartProps {}

export interface InstallationCliUpdateCompleteProps {
  duration_ms: number;
}

export interface InstallationCliUpdateFailProps {
  duration_ms: number;
}

export interface InstallationCliUninstallStartProps {}

export interface InstallationCliUninstallCompleteProps {
  has_pruned_content: boolean;
  has_uninstalled_package: boolean;
}

// Tool usage events

export interface ToolInvokeProps {
  tool: string;
  tool_invocation_id: string;
  platform?: "ios" | "android";
  /** sha256(udid).slice(0, 12), salted with cli major version. */
  device_id_hash?: string;
}

export interface ToolCompleteProps {
  tool: string;
  tool_invocation_id: string;
  platform?: "ios" | "android";
  duration_ms: number;
}

export interface ToolFailProps {
  tool: string;
  tool_invocation_id: string;
  platform?: "ios" | "android";
  duration_ms: number;
}

// Lifecycle events

export interface ToolserverStartProps {}

export interface ToolserverStopProps {
  reason: "idle" | "signal" | "crash";
  uptime_ms: number;
  total_tool_calls: number;
}

// Consent transition events

export interface TelemetryOptOutProps {}

export interface TelemetryCommandCompleteProps {
  subcommand: "status" | "enable" | "disable" | "help" | "unknown";
  duration_ms: number;
}

// Discriminated union for typed-track()

export interface EventPropertyMap {
  "installation:cli_init_start": InstallationCliInitStartProps;
  "installation:cli_init_complete": InstallationCliInitCompleteProps;
  "installation:cli_init_cancel": InstallationCliInitCancelProps;
  "installation:global_install_decision": InstallationGlobalInstallDecisionProps;
  "installation:update_decision": InstallationUpdateDecisionProps;
  "installation:editors_select": InstallationEditorsSelectProps;
  "installation:allowlist_decision": InstallationAllowlistDecisionProps;
  "installation:skill_install": InstallationSkillInstallProps;
  "installation:skill_install_result": InstallationSkillInstallResultProps;
  "installation:rules_agents_copy": InstallationRulesAgentsCopyProps;
  "installation:package_action": InstallationPackageActionProps;
  "installation:cli_update_start": InstallationCliUpdateStartProps;
  "installation:cli_update_complete": InstallationCliUpdateCompleteProps;
  "installation:cli_update_fail": InstallationCliUpdateFailProps;
  "installation:cli_uninstall_start": InstallationCliUninstallStartProps;
  "installation:cli_uninstall_complete": InstallationCliUninstallCompleteProps;
  "tool:invoke": ToolInvokeProps;
  "tool:complete": ToolCompleteProps;
  "tool:fail": ToolFailProps;
  "toolserver:start": ToolserverStartProps;
  "toolserver:stop": ToolserverStopProps;
  "telemetry:opt_out": TelemetryOptOutProps;
  "telemetry:command_complete": TelemetryCommandCompleteProps;
}

export type EventName = keyof EventPropertyMap;

/** Static list consumed by sanitize.ts and coverage tests. */
export const EVENT_NAMES: readonly EventName[] = [
  "installation:cli_init_start",
  "installation:cli_init_complete",
  "installation:cli_init_cancel",
  "installation:global_install_decision",
  "installation:update_decision",
  "installation:editors_select",
  "installation:allowlist_decision",
  "installation:skill_install",
  "installation:skill_install_result",
  "installation:rules_agents_copy",
  "installation:package_action",
  "installation:cli_update_start",
  "installation:cli_update_complete",
  "installation:cli_update_fail",
  "installation:cli_uninstall_start",
  "installation:cli_uninstall_complete",
  "tool:invoke",
  "tool:complete",
  "tool:fail",
  "toolserver:start",
  "toolserver:stop",
  "telemetry:opt_out",
  "telemetry:command_complete",
];
