/**
 * The wait tools report a wait that did not hold as `{ success: false }`
 * rather than throwing. The e2e runner, run-sequence and the recorder name
 * these tools here, by id, rather than read `success: false` of every tool.
 */

export const AWAIT_UI_ELEMENT_TOOL_ID = "await-ui-element";
export const AWAIT_NETWORK_REQUEST_TOOL_ID = "await-network-request";

const WAIT_TOOL_IDS: ReadonlySet<string> = new Set([
  AWAIT_UI_ELEMENT_TOOL_ID,
  AWAIT_NETWORK_REQUEST_TOOL_ID,
]);

/**
 * WHY a wait came back `success: false`. Only `unmet` judges the condition:
 *
 * - `unmet`: the source was read and the condition was false there.
 * - `unreadable`: the source never answered, so nothing was observed.
 * - `cancelled`: the caller gave up before the deadline. Also no verdict.
 */
export type UnmetWaitCause = "unmet" | "unreadable" | "cancelled";

/**
 * True when `result` is a wait of one of {@link WAIT_TOOL_IDS} that did not
 * hold. `unknown`, because the result crosses the registry boundary untyped.
 */
export function isUnmetWaitResult(tool: string, result: unknown): boolean {
  return (
    WAIT_TOOL_IDS.has(tool) &&
    typeof result === "object" &&
    result !== null &&
    (result as { success?: unknown }).success === false
  );
}

/**
 * How far behind the loop's exit the last TRUSTED read may lie before "the
 * condition was false" stops being honest, as a multiple of the poll interval.
 * One interval of sleep, plus one interval of latency for the deadline poll to
 * also come back dark. The flow runner's copy of await-ui-element's loop
 * uses the same tolerance as `CONDITION_DARK_TAIL_TOLERANCE_MS`.
 */
const DARK_TAIL_TOLERANCE_INTERVALS = 2;

/**
 * The same tolerance in absolute time. `pollIntervalMs` is the caller's, up to
 * 5000ms, so the multiple alone would reach 10s — and a source that answered
 * once and then went silent would still come back `unmet`. Past a couple of
 * seconds the trusted reads no longer credibly describe the deadline, however
 * sparsely the caller polls.
 *
 * Set above the default interval's own tolerance (2 x 400ms), so the routine
 * deadline straddle still reads as the blip it is.
 */
const DARK_TAIL_TOLERANCE_MAX_MS = 2000;

/** The dark-tail tolerance of a wait that polls every `pollIntervalMs`. */
export function darkTailToleranceMs(pollIntervalMs: number): number {
  return Math.min(DARK_TAIL_TOLERANCE_INTERVALS * pollIntervalMs, DARK_TAIL_TOLERANCE_MAX_MS);
}
