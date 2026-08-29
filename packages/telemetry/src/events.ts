// sanitize.ts enforces this same event surface at runtime.

import type { FailureSignal } from "@argent/registry";
import type { AiTelemetryProps } from "./ai-identity.js";

// Single source of truth for the telemetry device-platform enum: sanitize.ts's
// runtime allowlist derives from this tuple too, so the two can't drift.
//
// Deliberately a superset of the tool-server's device `Platform`
// (@argent/registry): a TV is a `runtimeKind` ("tv") layered on an `ios` /
// `android` device, not a platform of its own, so capability gating and dispatch
// stay TV-agnostic. `tvos` / `android-tv` exist for reporting only —
// tool-server/src/utils/telemetry-platform.ts refines them from the cached
// runtime kind.
export const PLATFORMS = [
  "ios",
  "ios-remote",
  "android",
  "chromium",
  "vega",
  "tvos",
  "android-tv",
] as const;
export type Platform = (typeof PLATFORMS)[number];

type FailureTelemetryProps = Partial<FailureSignal>;

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
  /**
   * The developer-only `--from <tarball>` path is not reported.
   * `install_local` and `set_prefix` are the recoveries offered when the
   * package manager's global directory cannot be written; `unrecoverable` is
   * the end of a global choice on a manager whose directory argent cannot
   * relocate.
   */
  decision:
    | "install"
    | "cancel"
    | "already_installed"
    | "install_local"
    | "set_prefix"
    | "unrecoverable";
}

export interface InstallationUpdateDecisionProps {
  from_major: number;
  to_major: number;
  decision: "update" | "skip" | "no_update";
}

export interface InstallationEditorsSelectProps {
  editors: string[];
  detected_editor_count: number;
  scope: "local" | "global" | "custom";
  install_mode?: "global" | "local";
}

export interface InstallationAllowlistDecisionProps {
  is_enabled: boolean;
}

// Post-write sweep in init/update: argent config in other scopes that would
// shadow or block the entry just written.
export interface InstallationStaleConfigCleanupProps {
  removed_count: number;
  warned_count: number;
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

type InstallationPackageActionTrigger = "init" | "update" | "mcp_update";

type InstallationPackageAction =
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
  // Local installs retry once (0 or 1). duration_ms spans ALL attempts, so the
  // final attempt is timed separately — otherwise the fast-fail duration
  // signature used to spot deterministic failure clusters washes out.
  retry_count?: number;
  last_attempt_duration_ms?: number;
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
  /**
   * Parameter names that failed zod validation on an HTTP tool call, plus the
   * literal "unrecognized_keys" for strict-object violations. Declared names
   * from Argent's own schemas only — never values, never user-typed keys.
   */
  invalid_params?: string[];
}

/**
 * Reasons debugger-status / debugger-log-registry return a structured
 * "not connected" result instead of failing.
 */
export const DEBUGGER_NOT_CONNECTED_REASONS = [
  "metro_not_running",
  "no_app_connected",
  "device_mismatch",
  "cdp_unreachable",
  "runtime_unresponsive",
  "stale_connection",
  "reconnecting",
] as const;
export type DebuggerNotConnectedReason = (typeof DEBUGGER_NOT_CONNECTED_REASONS)[number];

export const DEBUGGER_TOOL_OUTCOMES = ["connected", ...DEBUGGER_NOT_CONNECTED_REASONS] as const;
export type DebuggerToolOutcome = (typeof DEBUGGER_TOOL_OUTCOMES)[number];

/**
 * Emitted once per returned result of debugger-status / debugger-log-registry,
 * never on a thrown failure (unclassified faults, zod rejects and capability
 * gates emit tool:fail only). Not-connected preconditions raise no tool:fail —
 * this event is where they are counted; tool_invocation_id joins the
 * tool:invoke / tool:complete pair 1:1.
 */
export interface DebuggerToolOutcomeProps {
  tool: "debugger-status" | "debugger-log-registry";
  outcome: DebuggerToolOutcome;
  platform?: Platform;
  tool_invocation_id?: string;
}

export interface CliRunFailProps extends FailureTelemetryProps {
  tool: string;
  duration_ms: number;
}

export type ToolserverStartProps = Record<string, never>;

export interface ToolserverStopProps extends FailureTelemetryProps {
  // "deferred": lost the port bind (EADDRINUSE) to a healthy argent peer and
  // exited cleanly in its favor — kept distinct from "signal" so a supervisor
  // relaunch loop over deferrals stays identifiable.
  reason: "idle" | "signal" | "crash" | "deferred";
  uptime_ms: number;
  total_tool_calls: number;
  // Crash-only (see crash-diagnostics.ts), absent on clean idle/signal stops.
  // Coded values only — never the message or a raw stack.
  /** Error class name, e.g. "TypeError". */
  error_name?: string;
  /** Node system-error code, e.g. "EADDRINUSE". */
  error_syscall?: string;
  /** 16 hex chars: hash of the de-identified top stack frames. */
  crash_fingerprint?: string;
  /** Whether the crash landed before or after the HTTP listener bound. */
  crash_phase?: "startup" | "serving";
}

// Lens (variant-proposal) funnel. The generic tool:* path counts the agent's
// `propose_variant` / `await_user_selection` calls, which only prove the AGENT
// acted; these events capture the human side — preview loaded → round decided
// OR abandoned. Aggregate counts, booleans, durations and the device `platform`
// enum only: never element names, comment text, variant code, file paths or raw
// device identifiers.

// Emitted when a HUMAN renders a proposal round in a VISIBLE preview window, on
// an explicit client signal (`POST /preview/opened`; the client gates on
// `document.visibilityState`) rather than inferred from a page load or poll. A
// server-side per-round dedup keeps it to once per round across MCP respawn,
// reused CLI window and multiple tabs. The counts are sampled server-side when
// the client reports the round, so they reflect what was staged when the human
// first saw it.
export interface LensPreviewOpenedProps {
  /** Proposal round the human rendered in the preview. */
  round: number;
  /** Elements with staged proposals when the round was reported (0 for a CLI up-front open). */
  element_count: number;
  /** Total variants staged across all elements when the round was reported (0 for a CLI up-front open). */
  variant_count: number;
  /** Whether an `argent lens` CLI session owns the window (vs the MCP path). */
  is_cli_session: boolean;
  /**
   * Device platform the variants target. Omitted when the round staged no
   * proposals (`element_count === 0`, e.g. a CLI up-front open) so the store's
   * device — which deliberately survives `reset()` — can't attribute a
   * zero-count open to a prior flow's device. TV targets report `tvos` /
   * `android-tv` once the runtime-kind cache is warm, as with `tool:*`.
   */
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
  /** Skipped elements the user commented on — a "needs changes" signal (chosen-with-comment = element_comment_count - skipped_comment_count). */
  skipped_comment_count: number;
  /** Whether the user left a round-wide comment. */
  has_global_comment: boolean;
  /**
   * Whether the human opened the element-comment inspector (the "Add comment"
   * spotlight) at least once this round — registers an open even when it
   * produced no saved comment, which `annotation_count` cannot show.
   */
  inspector_used: boolean;
  /** Whether the human clicked "Show them" (or its collapsed pill) to reveal off-screen variant choices. */
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

// The other end of the funnel: a round with staged proposals discarded before
// the human submitted (window closed, `argent lens` exited mid-review, round
// superseded). Fires at most once per round, from the store's single reset()
// choke point — the drop-off `preview_opened`/`round_completed` can't show.
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

// Fired ONCE per `argent lens` CLI invocation, at session begin: the tool:* path
// counts the agent's calls and lens:preview_opened fires once PER ROUND, so
// neither can count how many times a human ran `argent lens`. Counting these
// events gives invocations; distinct telemetry ids over them give unique users.
export interface LensCliSessionStartedProps {
  /**
   * Coding-agent choices offered in the window's picker. `argent lens` sends 0
   * when no picker is shown (an `--agent` override, a remembered-and-still-
   * installed choice, or a single installed agent — the CLI resolves the agent
   * itself and posts an empty list) and >= 2 when it forwards a real choice. 1
   * is unreachable from `argent lens`, so a 1 means a hand-crafted POST. A
   * count, never the agent names.
   */
  agent_choice_count: number;
}

export interface EventPropertyMap {
  "installation:cli_init_start": InstallationCliInitStartProps;
  "installation:cli_init_complete": InstallationCliInitCompleteProps;
  "installation:cli_init_cancel": InstallationCliInitCancelProps;
  "installation:install_mode_decision": InstallationInstallModeDecisionProps;
  "installation:global_install_decision": InstallationGlobalInstallDecisionProps;
  "installation:update_decision": InstallationUpdateDecisionProps;
  "installation:editors_select": InstallationEditorsSelectProps;
  "installation:allowlist_decision": InstallationAllowlistDecisionProps;
  "installation:stale_config_cleanup": InstallationStaleConfigCleanupProps;
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
  "debugger:tool_outcome": DebuggerToolOutcomeProps;
  "cli:run_fail": CliRunFailProps;
  "toolserver:start": ToolserverStartProps;
  "toolserver:stop": ToolserverStopProps;
  "lens:preview_opened": LensPreviewOpenedProps;
  "lens:round_completed": LensRoundCompletedProps;
  "lens:round_abandoned": LensRoundAbandonedProps;
  "lens:cli_session_started": LensCliSessionStartedProps;
}

export type EventName = keyof EventPropertyMap;

export const EVENT_NAMES: readonly EventName[] = [
  "installation:cli_init_start",
  "installation:cli_init_complete",
  "installation:cli_init_cancel",
  "installation:install_mode_decision",
  "installation:global_install_decision",
  "installation:update_decision",
  "installation:editors_select",
  "installation:allowlist_decision",
  "installation:stale_config_cleanup",
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
  "debugger:tool_outcome",
  "cli:run_fail",
  "toolserver:start",
  "toolserver:stop",
  "lens:preview_opened",
  "lens:round_completed",
  "lens:round_abandoned",
  "lens:cli_session_started",
];
