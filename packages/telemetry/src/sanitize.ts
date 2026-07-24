import {
  FAILURE_AREAS,
  FAILURE_CODES,
  FAILURE_COMMANDS,
  FAILURE_KINDS,
  FAILURE_SIGNAL_NAMES,
  FAILURE_SPAWN_CODES,
  NETWORK_FAILURES,
} from "@argent/registry";
import { PLATFORMS, type EventName, type EventPropertyMap } from "./events.js";
import { AI_CLIENTS } from "./ai-identity.js";

// Per-event property allowlist and validators. Unknown keys and invalid values
// are dropped before anything reaches PostHog.

export type Validator = (v: unknown) => unknown | undefined;

const oneOf =
  <T extends string>(opts: readonly T[]): Validator =>
  (v) =>
    typeof v === "string" && (opts as readonly string[]).includes(v) ? v : undefined;

const matches =
  (re: RegExp, max = 80): Validator =>
  (v) =>
    typeof v === "string" && v.length <= max && re.test(v) ? v : undefined;

const finiteNonNeg =
  (max = 2 ** 31): Validator =>
  (v) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? v : undefined;

const bool: Validator = (v) => (typeof v === "boolean" ? v : undefined);

const arrayOf =
  (elem: Validator, maxLen = 16): Validator =>
  (v) => {
    if (!Array.isArray(v)) return undefined;
    if (v.length > maxLen) return undefined;
    const out: unknown[] = [];
    for (const e of v) {
      const cleaned = elem(e);
      if (cleaned === undefined) return undefined;
      out.push(cleaned);
    }
    return out;
  };

// Shared validators

const TOOL_NAME = matches(/^[a-z][a-z0-9_-]{0,63}$/, 64);
const PLATFORM = oneOf(PLATFORMS);
const UUID = matches(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  36
);
const PACKAGE_MANAGER = oneOf(["npm", "yarn", "pnpm", "bun", "unknown"] as const);
const PACKAGE_ACTION_TRIGGER = oneOf(["init", "update", "mcp_update"] as const);
const PACKAGE_ACTION = oneOf([
  "fresh_install",
  "already_installed",
  "init_triggered_update",
  "no_update",
  "update_skipped",
  "update_failed",
  "standalone_update",
  "standalone_install",
  "mcp_update",
] as const);
const ADAPTER_NAME = matches(/^[a-z][a-z0-9-]{0,63}$/, 64);
const COUNT = finiteNonNeg();
const DURATION_MS = finiteNonNeg();
const MAJOR_VERSION = finiteNonNeg(9999);
const FAILURE_CODE_VALUES = new Set<string>(Object.values(FAILURE_CODES));
const ERROR_CODE: Validator = (v) =>
  typeof v === "string" && FAILURE_CODE_VALUES.has(v) ? v : undefined;
const FAILURE_STAGE = matches(/^[a-z][a-z0-9_]{1,79}$/, 80);
const FAILURE_AREA = oneOf(FAILURE_AREAS);
const ERROR_KIND = oneOf(FAILURE_KINDS);
const FAILURE_COMMAND = oneOf(FAILURE_COMMANDS);
const FAILURE_EXIT_CODE = finiteNonNeg(255);
const FAILURE_SIGNAL_NAME = oneOf(FAILURE_SIGNAL_NAMES);
const FAILURE_SPAWN_CODE = oneOf(FAILURE_SPAWN_CODES);
const NETWORK_FAILURE = oneOf(NETWORK_FAILURES);

const AI_CLIENT = oneOf(AI_CLIENTS);

const INSTALL_MODE = oneOf(["global", "local"] as const);

// Crash diagnostics (toolserver:stop, reason:"crash"). Each is a coded, non-
// identifying shape — the emit side (crash-diagnostics.ts) never produces free
// text, and these validators are the final gate that drops anything that isn't
// the expected coded form.
//
// error_name  — an error class name (a code identifier), e.g. TypeError.
// error_syscall — a Node system-error code: leading `E`, uppercase/digits/`_`,
//   bounded length. Covers EADDRINUSE, ECONNREFUSED, EAI_AGAIN, ERR_* — and by
//   construction can hold no path, space, or lowercase text.
// crash_fingerprint — exactly 16 lowercase hex chars (a truncated SHA-256).
const ERROR_NAME = matches(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, 64);
const ERROR_SYSCALL = matches(/^E[A-Z0-9_]{1,31}$/, 32);
const CRASH_FINGERPRINT = matches(/^[0-9a-f]{16}$/, 16);
const CRASH_PHASE = oneOf(["startup", "serving"] as const);

const AI_TELEMETRY = {
  ai_client: AI_CLIENT,
};

const FAILURE_SIGNAL = {
  error_code: ERROR_CODE,
  failure_stage: FAILURE_STAGE,
  failure_area: FAILURE_AREA,
  error_kind: ERROR_KIND,
  failure_command: FAILURE_COMMAND,
  failure_exit_code: FAILURE_EXIT_CODE,
  failure_signal: FAILURE_SIGNAL_NAME,
  failure_spawn_code: FAILURE_SPAWN_CODE,
  network_failure: NETWORK_FAILURE,
};

// Per-event validators
//
// The type forces one validator per declared property of every event (`-?`
// keeps optional props like `platform` required here), and forbids validators
// for properties the event type doesn't declare. So adding/removing a field in
// events.ts that isn't mirrored here is a compile error — the runtime allowlist
// can't silently drift from the typed event surface.
type ValidatorMap = {
  [E in EventName]: { [K in keyof EventPropertyMap[E]]-?: Validator };
};

export const ALLOWED: ValidatorMap = {
  "installation:cli_init_start": {
    package_manager: PACKAGE_MANAGER,
    is_non_interactive: bool,
  },
  "installation:cli_init_complete": {
    duration_ms: DURATION_MS,
    is_success: bool,
    editors_configured_count: COUNT,
    install_mode: INSTALL_MODE,
    ...FAILURE_SIGNAL,
  },
  "installation:cli_init_cancel": {
    step: oneOf([
      "global_install",
      "editors",
      "scope",
      "skills",
      "allowlist",
      "install_mode",
    ] as const),
  },
  "installation:install_mode_decision": {
    install_mode: INSTALL_MODE,
  },
  "installation:global_install_decision": {
    // `from_tar` is intentionally absent; the installer skips that dev path.
    decision: oneOf(["install", "cancel", "already_installed"] as const),
  },
  "installation:update_decision": {
    from_major: MAJOR_VERSION,
    to_major: MAJOR_VERSION,
    decision: oneOf(["update", "skip", "no_update"] as const),
  },
  "installation:editors_select": {
    editors: arrayOf(ADAPTER_NAME),
    detected_editor_count: COUNT,
    scope: oneOf(["local", "global", "custom"] as const),
    install_mode: INSTALL_MODE,
  },
  "installation:allowlist_decision": {
    is_enabled: bool,
  },
  "installation:stale_config_cleanup": {
    removed_count: COUNT,
    warned_count: COUNT,
  },
  "installation:skill_install": {
    method: oneOf(["default", "interactive", "manual"] as const),
    is_online: bool,
    has_offline_cache: bool,
    outcome: oneOf(["success", "failure", "skipped"] as const),
  },
  "installation:skill_refresh_result": {
    is_success: bool,
    scope_count: COUNT,
    synced_count: COUNT,
    pruned_count: COUNT,
    failed_count: COUNT,
    ...FAILURE_SIGNAL,
  },
  "installation:package_action": {
    trigger: PACKAGE_ACTION_TRIGGER,
    action: PACKAGE_ACTION,
    is_success: bool,
    duration_ms: DURATION_MS,
    retry_count: COUNT,
    last_attempt_duration_ms: DURATION_MS,
    ...FAILURE_SIGNAL,
  },
  "installation:cli_update_start": {},
  "installation:cli_update_complete": {
    duration_ms: DURATION_MS,
    install_mode: INSTALL_MODE,
  },
  "installation:cli_update_fail": {
    duration_ms: DURATION_MS,
    install_mode: INSTALL_MODE,
    ...FAILURE_SIGNAL,
  },
  "installation:cli_uninstall_start": {},
  "installation:cli_uninstall_complete": {
    has_pruned_content: bool,
    has_uninstalled_package: bool,
    install_mode: INSTALL_MODE,
    ...FAILURE_SIGNAL,
  },
  "tool:invoke": {
    tool: TOOL_NAME,
    tool_invocation_id: UUID,
    platform: PLATFORM,
    ...AI_TELEMETRY,
  },
  "tool:complete": {
    tool: TOOL_NAME,
    tool_invocation_id: UUID,
    platform: PLATFORM,
    duration_ms: DURATION_MS,
    ...AI_TELEMETRY,
  },
  "tool:fail": {
    tool: TOOL_NAME,
    tool_invocation_id: UUID,
    platform: PLATFORM,
    duration_ms: DURATION_MS,
    ...FAILURE_SIGNAL,
    ...AI_TELEMETRY,
  },
  "cli:run_fail": {
    tool: TOOL_NAME,
    duration_ms: DURATION_MS,
    ...FAILURE_SIGNAL,
  },
  "toolserver:start": {},
  "toolserver:stop": {
    reason: oneOf(["idle", "signal", "crash", "deferred"] as const),
    uptime_ms: DURATION_MS,
    total_tool_calls: COUNT,
    ...FAILURE_SIGNAL,
    error_name: ERROR_NAME,
    error_syscall: ERROR_SYSCALL,
    crash_fingerprint: CRASH_FINGERPRINT,
    crash_phase: CRASH_PHASE,
  },
  "lens:preview_opened": {
    round: COUNT,
    element_count: COUNT,
    variant_count: COUNT,
    is_cli_session: bool,
    platform: PLATFORM,
  },
  "lens:round_completed": {
    round: COUNT,
    element_count: COUNT,
    variant_count: COUNT,
    annotation_count: COUNT,
    element_comment_count: COUNT,
    skipped_comment_count: COUNT,
    has_global_comment: bool,
    inspector_used: bool,
    offscreen_revealed: bool,
    is_cli_session: bool,
    had_parked_await: bool,
    round_duration_ms: DURATION_MS,
    platform: PLATFORM,
  },
  "lens:round_abandoned": {
    round: COUNT,
    element_count: COUNT,
    variant_count: COUNT,
    had_parked_await: bool,
    is_cli_session: bool,
    platform: PLATFORM,
  },
  "lens:cli_session_started": {
    agent_choice_count: COUNT,
  },
};

/** Strip keys and values that are not allowed for this event. */
export function sanitize(event: string, raw: Record<string, unknown>): Record<string, unknown> {
  const validators = (ALLOWED as Record<string, Record<string, Validator>>)[event];
  if (!validators) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    const validate = validators[k];
    if (!validate) continue;
    const cleaned = validate(v);
    if (cleaned !== undefined) out[k] = cleaned;
  }
  return out;
}

/** Re-export of the validator combinators for unit tests. */
export const _testValidators = { oneOf, matches, finiteNonNeg, bool, arrayOf };
