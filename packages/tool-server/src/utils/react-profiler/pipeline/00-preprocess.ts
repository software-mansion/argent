/**
 * Stage 0: for each commit whose reason is 'parent', walks the parentName chain
 * within the same commit batch to the nearest ancestor that had a real change and
 * records it in the rootCause* fields for the later stages.
 */
import type { DevToolsFiberCommit } from "../types/input";
import { deriveReason } from "./utils";

export function preprocess(commits: DevToolsFiberCommit[]): DevToolsFiberCommit[] {
  // Last write wins for duplicate component names within one commit.
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
