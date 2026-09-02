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
