import { describe, it, expect } from "vitest";
import { renderByIndex } from "../src/tools/profiler/query/profiler-commit-query";
import type { DevToolsFiberCommit } from "../src/utils/react-profiler/types/input";

function fiber(
  componentName: string,
  actualDuration: number,
  extra: Partial<DevToolsFiberCommit> = {}
): DevToolsFiberCommit {
  return {
    commitIndex: 1,
    timestamp: 2868,
    commitDuration: 18.7,
    componentName,
    actualDuration,
    selfDuration: actualDuration / 2,
    didRender: true,
    changeDescription: null,
    ...extra,
  } as DevToolsFiberCommit;
}

/** 30 fibers spanning 10 distinct component names, descending in cost. */
function commit(): DevToolsFiberCommit[] {
  const out: DevToolsFiberCommit[] = [];
  for (let i = 0; i < 30; i++) {
    out.push(fiber(`Comp${i % 10}`, 30 - i));
  }
  return out;
}

describe("profiler-commit-query by_index — top_n", () => {
  it("returns every fiber when top_n is not given", () => {
    // by_index is the drill-down the analyze report points at for a full
    // breakdown, so an unrequested cap would make it show less than the report.
    const out = renderByIndex(commit(), 1);
    expect(out.split("\n").filter((l) => l.startsWith("| `")).length).toBe(30);
    expect(out).toContain("Full Detail");
    expect(out).not.toContain("cheaper fibers hidden");
  });

  it("caps the table when top_n is given, keeping the costliest fibers", () => {
    const out = renderByIndex(commit(), 1, 8);
    const rows = out.split("\n").filter((l) => l.startsWith("| `"));
    expect(rows.length).toBe(8);
    // Sorted by actualDuration desc, so the retained rows are 30..23.
    expect(rows[0]).toContain("| 30.0 |");
    expect(rows[7]).toContain("| 23.0 |");
  });

  it("reports the true fiber total alongside the shown count", () => {
    const out = renderByIndex(commit(), 1, 8);
    expect(out).toContain("**Fibers:** 30 (showing 8)");
    // The heading must stop claiming full detail once it is not full.
    expect(out).not.toContain("Full Detail");
  });

  it("says how many distinct components the truncated view actually covers", () => {
    // The trap this guards: 8 fibers can be far fewer than 8 components, so a
    // caller cannot infer coverage from the row count.
    const out = renderByIndex(commit(), 1, 8);
    expect(out).toContain("22 cheaper fibers hidden");
    expect(out).toContain("10 distinct components");
    expect(out).toContain("Omit top_n for everything");
  });

  it("keeps the root-cause chain when its fiber is too cheap to make the cut", () => {
    // The fiber carrying the root cause is usually cheap — it triggers the
    // cascade rather than doing the work — so it falls outside any top_n.
    // Scanning the truncated list instead of the full commit would silently
    // drop the single most useful line in this output.
    const commits = [
      ...commit(),
      fiber("TinyTrigger", 0.01, {
        rootCauseParent: "ParentThatChanged",
        rootCauseChain: ["Root", "Middle"],
        rootCauseReason: "props",
      }),
    ];
    const out = renderByIndex(commits, 1, 5);
    expect(out).toContain("**Root cause chain:**");
    expect(out).toContain("ParentThatChanged");
    // ...and the cheap fiber itself is indeed not in the table.
    expect(out.split("\n").filter((l) => l.startsWith("| `TinyTrigger`")).length).toBe(0);
  });

  it("adds no truncation notice when top_n exceeds the fiber count", () => {
    const out = renderByIndex(commit(), 1, 500);
    expect(out).not.toContain("cheaper fibers hidden");
    expect(out).toContain("Full Detail");
    expect(out).not.toContain("(showing");
  });

  it("leaves the not-found path alone", () => {
    expect(renderByIndex(commit(), 99, 5)).toBe("_Commit #99 not found in stored data._");
  });
});
