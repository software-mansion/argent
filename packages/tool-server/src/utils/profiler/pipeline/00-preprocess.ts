/**
 * Stage 0: Preprocess — Parent Chain Tracing
 *
 * For each fiber commit whose reason is 'parent', walks up the parentName chain
 * within the same React commit batch to find the root cause component — the
 * ancestor that actually had a props/hooks/state/context change.
 *
 * Annotates the commit with rootCause* fields so Stage 1 can aggregate them
 * into a parentTrigger finding, giving the LLM actionable "what triggered this
 * parent cascade" information rather than just "dominantReason: parent".
 */
import type { DevToolsFiberCommit } from "../types/input";
import { deriveReason } from "./utils";

export function preprocess(
  commits: DevToolsFiberCommit[],
): DevToolsFiberCommit[] {
  // Group by commitIndex → Map<componentName, DevToolsFiberCommit>
  // Last-write wins for duplicate component names in the same commit (edge case).
  const commitMap = new Map<number, Map<string, DevToolsFiberCommit>>();
  for (const c of commits) {
    let m = commitMap.get(c.commitIndex);
    if (!m) {
      m = new Map();
      commitMap.set(c.commitIndex, m);
    }
    m.set(c.componentName, c);
  }

  return commits.map((c) => {
    const cd = c.changeDescription;
    if (!cd || cd.isFirstMount) return c;

    const reason = deriveReason(cd, c.hookTypes);
    if (reason !== "parent" || !c.parentName) return c;

    const commitComponents = commitMap.get(c.commitIndex);
    if (!commitComponents) return c;

    // Walk the parent chain to find the first ancestor with a non-parent reason
    let current: string | null = c.parentName;
    const visited = new Set<string>([c.componentName]);
    const chain: string[] = [];

    while (current !== null && !visited.has(current)) {
      visited.add(current);
      const parent = commitComponents.get(current);
      if (!parent) break;

      const parentCd = parent.changeDescription;
      if (!parentCd) break;

      const parentReason = deriveReason(parentCd, parent.hookTypes);
      chain.push(current);
      if (parentReason !== "parent") {
        return {
          ...c,
          rootCauseParent: current,
          rootCauseReason: parentReason,
          rootCauseProps: parentCd.props,
          rootCauseHooks: parentCd.hooks,
          rootCauseHookTypes: parent.hookTypes ?? null,
          rootCauseChain: chain,
        };
      }

      current = parent.parentName ?? null;
    }

    return c;
  });
}
