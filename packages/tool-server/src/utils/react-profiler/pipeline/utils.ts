import type { DevToolsChangeDescription } from "../types/input";
import type { ReRenderReason } from "../types/output";

/** hookTypes (fiber._debugHookTypes) is what separates 'state' from 'hooks'. */
export function deriveReason(
  cd: DevToolsChangeDescription | null,
  hookTypes?: string[] | null
): ReRenderReason {
  if (cd === null) return "unknown";
  if (cd.props !== null && cd.props.length > 0) return "props";
  if (cd.didHooksChange || (cd.hooks !== null && cd.hooks.length > 0)) {
    if (hookTypes && cd.hooks) {
      const isState = cd.hooks.some((idx) => {
        const ht = hookTypes[idx];
        return ht === "State" || ht === "Reducer" || ht === "useState" || ht === "useReducer";
      });
      if (isState) return "state";
    }
    return "hooks";
  }
  if (cd.context === true) return "context";
  if (cd.state === true) return "state";
  return "parent";
}

export function emptyReasonHistogram(): Record<ReRenderReason, number> {
  return { parent: 0, props: 0, hooks: 0, context: 0, state: 0, force_update: 0, unknown: 0 };
}

/**
 * The reason with the most renders. A tie goes to the first in the histogram's
 * key order, so the report's table and `render_counts` name the same one.
 */
export function dominantReason(histogram: Record<ReRenderReason, number>): ReRenderReason {
  let best: ReRenderReason = "unknown";
  let bestCount = -1;
  for (const [reason, count] of Object.entries(histogram) as [ReRenderReason, number][]) {
    if (count > bestCount) {
      bestCount = count;
      best = reason;
    }
  }
  return best;
}
