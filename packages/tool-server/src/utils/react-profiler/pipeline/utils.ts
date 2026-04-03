import type { DevToolsChangeDescription } from "../types/input";
import type { ReRenderReason } from "../types/output";

/**
 * Derive the re-render reason from a commit's change description.
 * hookTypes (fiber._debugHookTypes) is used to distinguish 'state' from 'hooks'.
 * Shared between 00-preprocess and 01-reduce to avoid duplication.
 */
export function deriveReason(
  cd: DevToolsChangeDescription | null,
  hookTypes?: string[] | null
): ReRenderReason {
  if (cd === null) return "unknown";
  if (cd.props !== null && cd.props.length > 0) return "props";
  if (cd.didHooksChange || (cd.hooks !== null && cd.hooks.length > 0)) {
    // Distinguish state-driven hook changes from generic hook changes
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
