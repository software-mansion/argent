// Typed telemetry event names and property shapes. sanitize.ts enforces the
// same surface at runtime.

import type { FailureSignal } from "@argent/registry";
import type { AiTelemetryProps } from "./ai-identity.js";

// Single source of truth for the telemetry device-platform enum: the TS union
// below and sanitize.ts's runtime allowlist both derive from this tuple, so
// adding a platform can't silently drift the two apart.
//
// This is the *telemetry* platform, deliberately a superset of the tool-server's
// device `Platform` (@argent/registry): `tvos` and `android-tv` have no
// standalone device platform there — a TV is a `runtimeKind` ("tv") layered on
// an `ios`/`android` device, not its own platform, so capability gating and
// dispatch stay TV-agnostic. Telemetry splits them out only for reporting: the
// inference in tool-server/http.ts maps `ios`->`tvos` / `android`->`android-tv`
// when a device's cached runtime kind is "tv".
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

// Stale argent config (entries in other scopes that would shadow or block the
// one just written) removed or flagged by the post-write sweep in init/update.
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
  // Local-install retry visibility: how many times the retry-once fired (0/1)
  // and the duration of the final attempt alone — duration_ms spans ALL
  // attempts, which would otherwise wash out the fast-fail duration signature
  // used to spot deterministic failure clusters.
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
  // "deferred": a redundant instance lost the port bind (EADDRINUSE) to a
  // healthy argent peer and exited cleanly in its favor — kept distinct from
  // "signal" so a supervisor relaunch loop over deferrals stays identifiable.
  reason: "idle" | "signal" | "crash" | "deferred";
  uptime_ms: number;
  total_tool_calls: number;
  // Crash-only diagnostics (see crash-diagnostics.ts). All anonymous: a coded
  // class name, a coded syscall, and a hash — never the message or a raw stack.
  // Absent on clean (idle/signal) stops.
  /** Error class name, e.g. "TypeError". */
  error_name?: string;
  /** Node system-error code, e.g. "EADDRINUSE". */
  error_syscall?: string;
  /** 16 hex chars: hash of the de-identified top stack frames. */
  crash_fingerprint?: string;
  /** Whether the crash landed before or after the HTTP listener bound. */
  crash_phase?: "startup" | "serving";
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

// Emitted when a HUMAN renders a proposal round in a VISIBLE preview window,
// driven by an explicit client signal (`POST /preview/opened`) rather than
// inferred from a page load or poll. Fires once per round across all surfaces
// (MCP respawn, reused CLI window, multiple tabs) via a server-side per-round
// dedup, and never from a backgrounded tab (the client gates on
// `document.visibilityState`). The counts are sampled server-side at the moment
// the client reports the round, so they reflect what was staged when the human
// first saw it — consistent across MCP and CLI (both go through the same client
// signal), not a fresh-load vs poll-tick mix.
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
   * Device platform the variants target. Omitted whenever the round staged no
   * proposals (`element_count === 0`) — including a CLI up-front open — so the
   * store's device (which deliberately survives `reset()`) can't attribute a
   * zero-count open to a prior flow's device. A TV target is reported as
   * `tvos` / `android-tv` once the runtime-kind cache is warm (as with `tool:*`).
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

// Fired ONCE per `argent lens` CLI invocation, on the session begin. The generic
// tool:* path counts the agent's propose_variant/await_user_selection calls
// (which fire many times per session), and lens:preview_opened fires once PER
// ROUND — so neither can count how many times a human ran `argent lens`. This is
// the per-invocation marker: a plain count of these events is the invocation
// total, and distinct telemetry ids over them are the unique-user population for
// the tool. Privacy-safe: only an aggregate count, no PII.
export interface LensCliSessionStartedProps {
  /**
   * Coding-agent choices offered in the window's picker. In practice `argent lens`
   * sends only two values: 0 when no picker is shown (an `--agent` override, a
   * remembered-and-still-installed choice, or a single installed agent — the CLI
   * resolves the agent itself and posts an empty list), and >= 2 when it forwards
   * a real choice for the human to pick. 1 is unreachable from `argent lens` (a
   * lone installed agent is auto-selected, not offered), so a 1 in the data
   * indicates a hand-crafted POST, not the single-installed-agent case. A
   * privacy-safe count, never the agent names.
   */
  agent_choice_count: number;
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
  "cli:run_fail",
  "toolserver:start",
  "toolserver:stop",
  "lens:preview_opened",
  "lens:round_completed",
  "lens:round_abandoned",
  "lens:cli_session_started",
];
