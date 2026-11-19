import { describe, it, expect } from "vitest";
import { buildHotCommitSummaries } from "../../src/utils/react-profiler/pipeline/00-hot-commits";
import type {
  DevToolsChangeDescription,
  DevToolsFiberCommit,
} from "../../src/utils/react-profiler/types/input";

const RERENDER: DevToolsChangeDescription = {
  props: ["now"],
  state: null,
  hooks: null,
  context: null,
  didHooksChange: false,
  isFirstMount: false,
};
const MOUNT: DevToolsChangeDescription = { ...RERENDER, props: null, isFirstMount: true };

function fiber(
  componentName: string,
  selfDuration: number,
  changeDescription: DevToolsChangeDescription | null
): DevToolsFiberCommit {
  return {
    commitIndex: 0,
    timestamp: 100,
    componentName,
    actualDuration: selfDuration,
    selfDuration,
    commitDuration: 40,
    didRender: true,
    changeDescription,
  };
}

function entries(fibers: DevToolsFiberCommit[]) {
  const [commit] = buildHotCommitSummaries(fibers, [0]);
  return { commit: commit!, byName: new Map(commit!.components.map((c) => [c.name, c])) };
}

/**
 * React DevTools records no change description for a context fiber, on any
 * render. `render_counts` counts those as "no change data" and `cascade_tree`
 * prints `unknown`; the report called them mounts, so 30 providers re-rendering
 * on a tick read as 30 providers remounting.
 */
describe("fibers with no change data in a hot commit", () => {
  it("are not mounts", () => {
    const { byName } = entries([
      fiber("ThemeContext.Provider", 1, null),
      fiber("ThemeContext.Provider", 1, null),
      fiber("Row", 30, RERENDER),
    ]);
    const provider = byName.get("ThemeContext.Provider")!;
    expect(provider.count).toBe(2);
    expect(provider.isFirstMount).toBeUndefined();
    // No change data means no known reason either.
    expect(provider.reason).toBeUndefined();
    expect(byName.get("Row")).toMatchObject({ reason: "props", topChangedProps: ["now"] });
  });

  it("do not turn a commit into an initial render", () => {
    // 30 of 40 ms in providers: as mounts that was "Initial render: 1 component mounted".
    const { commit } = entries([
      fiber("ThemeContext.Provider", 30, null),
      fiber("Row", 5, RERENDER),
    ]);
    expect(commit.isInitialRender).toBeUndefined();
    expect(commit.rootCauseComponent).toBe("Row");
  });

  it("leave real mounts as they were", () => {
    const { commit, byName } = entries([fiber("Screen", 30, MOUNT), fiber("Row", 5, RERENDER)]);
    expect(byName.get("Screen")).toMatchObject({ isFirstMount: true });
    expect(byName.get("Screen")!.reason).toBeUndefined();
    expect(commit.isInitialRender).toBe(true);
  });

  it("do not borrow a reason from a mount of the same name", () => {
    // The group is no longer all mounts, and its first entry's change
    // description says nothing about why the others rendered.
    const { byName } = entries([fiber("Cell", 2, MOUNT), fiber("Cell", 2, null)]);
    expect(byName.get("Cell")!.isFirstMount).toBeUndefined();
    expect(byName.get("Cell")!.reason).toBeUndefined();
  });
});
