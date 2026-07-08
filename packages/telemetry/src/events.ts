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
}

export interface InstallationCliUpdateFailProps extends FailureTelemetryProps {
  duration_ms: number;
}

export type InstallationCliUninstallStartProps = Record<string, never>;

export interface InstallationCliUninstallCompleteProps extends FailureTelemetryProps {
  has_pruned_content: boolean;
  has_uninstalled_package: boolean;
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

// Lens (variant-proposal) events
//
// The agent CALLS `propose_variant` / `await_user_selection`, which the generic
// tool:invoke/complete/fail path already counts — but those calls only prove the
// AGENT acted. They can't tell us whether a HUMAN opened the preview or what they
// decided. These events capture the human side of the funnel: preview loaded →
// round decided OR abandoned. All carry only privacy-safe aggregate counts /
// booleans / durations plus the device `platform` enum — never element names,
// comment text, variant code, file paths, or raw device identifiers.

export interface LensPreviewOpenedProps {
  /** Proposal round on screen when the preview UI was loaded. */
  round: number;
  /** Elements with staged proposals at open time (0 for a CLI up-front open). */
  element_count: number;
  /** Total variants staged across all elements at open time (0 for a CLI up-front open). */
  variant_count: number;
  /** Whether an `argent lens` CLI session owns the window (vs the MCP path). */
  is_cli_session: boolean;
  /** Device platform the variants target; omitted until a device is bound (e.g. a CLI up-front open). */
  platform?: Platform;
}

export interface LensRoundCompletedProps {
  round: number;
  /** Elements the agent proposed variants for. */
  element_count: number;
  /** Total variants offered across all elements. */
  variant_count: number;
  /** Free-form inspector comments the user pinned to on-screen elements. */
  annotation_count: number;
  /** Proposed elements the user attached a per-element comment to (chosen or skipped). */
  element_comment_count: number;
  /** Skipped elements the user left a per-element comment on (a "needs changes" signal; chosen-with-comment = element_comment_count - skipped_comment_count). */
  skipped_comment_count: number;
  /** Whether the user left a round-wide comment. */
  has_global_comment: boolean;
  /**
   * Whether the human opened the element-comment "inspector" (the "Add comment"
   * spotlight) at least once during this round — an adoption signal for the
   * inspector button that `annotation_count` (a comment-volume proxy) can't
   * give: this registers an open even when it produced no saved comment.
   */
  inspector_used: boolean;
  /**
   * Whether the human clicked "Show them" (or its collapsed pill) to reveal
   * off-screen variant choices at least once during this round.
   */
  offscreen_revealed: boolean;
  /** Whether an `argent lens` CLI session owns the window (vs the MCP path). */
  is_cli_session: boolean;
  /** Whether an `await_user_selection` call was parked to receive this submit. */
  had_parked_await: boolean;
  /** From the first proposal staged in this round to the submit. */
  round_duration_ms: number;
  /** Device platform the variants target; omitted when no device was bound. */
  platform?: Platform;
}

// The other end of the funnel: a round that had staged proposals but was
// discarded before the human submitted (window closed, `argent lens` exited
// mid-review, or the round was superseded). Fires at most once per abandoned
// round, from the store's single reset() choke point. Drop-off is the metric
// `preview_opened`/`round_completed` alone can't give — this supplies the loss.
export interface LensRoundAbandonedProps {
  round: number;
  /** Elements that had staged proposals when the round was discarded. */
  element_count: number;
  /** Total variants staged across those elements. */
  variant_count: number;
  /** Whether an `await_user_selection` call was parked (i.e. the MCP window was shown) when abandoned. */
  had_parked_await: boolean;
  /** Whether an `argent lens` CLI session owned the window. */
  is_cli_session: boolean;
  /** Device platform the variants targeted; omitted when no device was bound. */
  platform?: Platform;
}

// Fired ONCE per `argent lens` CLI invocation, at the session-begin transition.
// The generic tool:* path counts the agent's propose_variant/await_user_selection
// calls (which fire many times per session), and lens:preview_opened fires once
// PER ROUND — so neither can count how many times a human ran `argent lens`.
// This is the per-invocation marker: a plain count of these events is the
// invocation total, and distinct telemetry ids over them are the unique-user
// population for the tool. Privacy-safe: only an aggregate count, no PII.
export interface LensCliSessionStartedProps {
  /**
   * Coding-agent choices offered in the window's picker (0/1 when no picker is
   * shown — a single installed agent or a remembered choice; >1 when the human
   * must pick). A privacy-safe count, never the agent names.
   */
  agent_choice_count: number;
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
  "lens:preview_opened": LensPreviewOpenedProps;
  "lens:round_completed": LensRoundCompletedProps;
  "lens:round_abandoned": LensRoundAbandonedProps;
  "lens:cli_session_started": LensCliSessionStartedProps;
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
  "lens:preview_opened",
  "lens:round_completed",
  "lens:round_abandoned",
  "lens:cli_session_started",
];
