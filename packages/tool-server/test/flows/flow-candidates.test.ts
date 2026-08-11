import { describe, expect, it } from "vitest";
import type { DescribeNode } from "../../src/tools/describe/contract";
import { diagnoseScope, rankCandidates } from "../../src/tools/flows/flow-candidates";
import { flowMatchAll } from "../../src/tools/flows/flow-actions";
import { parseFlow, type FlowSelector } from "../../src/tools/flows/flow-utils";
import { label, n, screen } from "./harness";

/** The selector a suggested `selectorYaml` parses back to, through the real parser. */
function reparse(selectorYaml: string | undefined): FlowSelector {
  const flow = parseFlow(["steps:", `  - tap: ${selectorYaml ?? ""}`].join("\n"));
  const step = flow.steps[0];
  if (step === undefined || step.kind !== "tap" || step.selector === undefined) {
    throw new Error(`suggested selector did not parse as a tap target: ${String(selectorYaml)}`);
  }
  return step.selector;
}

describe("rankCandidates", () => {
  it("ranks an identifier typo above the text reading of the same bare-string selector", () => {
    // `tap: submitBtn` is looked up as an identifier AND as text, so both
    // readings must be scored — and the identifier near-miss, which is a typo
    // in the flow file with near-certainty, has to come first.
    const button = n({
      role: "AXButton",
      identifier: "submit-btn",
      frame: { x: 0.1, y: 0.5, width: 0.3, height: 0.06 },
    });
    const tree = screen([
      button,
      label("Submit", { frame: { x: 0.1, y: 0.6, width: 0.3, height: 0.04 } }),
      label("Cancel", { frame: { x: 0.1, y: 0.7, width: 0.3, height: 0.04 } }),
    ]);

    const { candidates, total } = rankCandidates(tree, { text: "submitBtn", loose: true });

    expect(candidates.map((c) => [c.basis, c.node.identifier ?? c.node.label])).toEqual([
      ["identifier-near", "submit-btn"],
      ["text-contained-by", "Submit"],
    ]);
    expect(candidates[0]!.score).toBeGreaterThan(candidates[1]!.score);
    expect(candidates[0]!.selectorYaml).toBe('{"id":"submit-btn"}');
    // "Cancel" is neither a typo of nor a substring relation to the needle.
    expect(total).toBe(2);
  });

  it("never reads a node's label and value as one joined string", () => {
    // THE trap: `nodeText` joins label and value, but `matchNode` compares them
    // separately — so scoring the join would rate this slider an exact match
    // for a selector that matches nothing, not even the node it was read from.
    const slider = n({
      role: "AXSlider",
      label: "Volume",
      value: "50%",
      frame: { x: 0.1, y: 0.3, width: 0.6, height: 0.05 },
    });
    // The element that legitimately DOES carry the joined string: a flattened
    // container whose descendants' text was hoisted into `subtreeText`.
    const container = n({
      role: "AXGroup",
      subtreeText: "Volume 50%",
      frame: { x: 0.05, y: 0.28, width: 0.9, height: 0.1 },
    });
    const tree = screen([slider, container]);

    const { candidates } = rankCandidates(tree, { text: "Volume 50%" });

    expect(candidates.some((c) => c.basis === "text-exact" && c.node.label === "Volume")).toBe(
      false
    );
    const forSlider = candidates.find((c) => c.node.label === "Volume");
    expect(forSlider).toMatchObject({ basis: "text-contained-by", score: 0.7 });
    // The hoisted-text container is the honest exact hit, and it ranks first.
    expect(candidates[0]).toMatchObject({ basis: "text-exact", score: 0.95 });
    expect(candidates[0]!.node.text).toBe("Volume 50%");
    // A generic-role container with no stable field yields no paste-able
    // selector — the row is still worth printing, so the field is omitted
    // rather than the ranking failing.
    expect(candidates[0]!.selectorYaml).toBeUndefined();
  });

  it("collapses a container and its text leaf into one suggestion", () => {
    // A flattened tree routinely carries both; they derive the same selector
    // for the same rectangle, so two rows would be one suggestion printed twice.
    const frame = { x: 0.1, y: 0.2, width: 0.4, height: 0.05 };
    const tree = screen([
      n({ role: "AXGroup", label: "Check out", clickable: true, frame }),
      n({ role: "AXStaticText", label: "Check out", frame }),
    ]);

    const { candidates, total } = rankCandidates(tree, { text: "Checkout" });

    expect(candidates).toHaveLength(1);
    expect(total).toBe(1);
    expect(candidates[0]).toMatchObject({
      basis: "text-near",
      selectorYaml: '{"text":"Check out"}',
    });
  });

  it("never suggests an element the selector already matched", () => {
    // "Which element did you MEAN instead" has no answer that is the element
    // you already named. A zero-area exact match is reported as
    // `actual.invisibleMatches`; repeating it here would spend one of five
    // slots proposing the selector that just failed.
    const tree = screen([
      n({
        role: "AXButton",
        identifier: "checkout-cta",
        label: "Checkout",
        frame: { x: 0.5, y: 0.9, width: 0, height: 0 },
      }),
    ]);

    expect(rankCandidates(tree, { identifier: "checkout-cta" }).candidates).toEqual([]);
  });

  it("applies the visibility penalty to a near miss that is not itself a match", () => {
    const tree = screen([
      n({
        role: "AXButton",
        identifier: "checkout-cta",
        label: "Checkout",
        frame: { x: 0.5, y: 0.9, width: 0, height: 0 },
      }),
    ]);

    const { candidates } = rankCandidates(tree, { identifier: "checkout-ctaa" });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      basis: "identifier-near",
      note: "zero-area frame",
    });
    expect(candidates[0]!.score).toBeLessThan(0.5);
  });

  it("notes disabled and scrolled-out elements on a gesture step", () => {
    const tree = screen([
      n({
        role: "AXButton",
        label: "Checkout",
        clickable: true,
        frame: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
      }),
      n({
        role: "AXButton",
        label: "Checkout",
        disabled: true,
        frame: { x: 0.1, y: 0.2, width: 0.3, height: 0.05 },
      }),
      n({
        role: "AXStaticText",
        label: "Checkout",
        scrollHidden: 3,
        frame: { x: 0.1, y: 0.3, width: 0.3, height: 0.05 },
      }),
    ]);

    // A near miss, not a match: an element the selector already resolves to is
    // never a candidate, so the modifiers have to be observed on elements the
    // selector merely came close to.
    const { candidates } = rankCandidates(tree, { text: "Chekout" }, { gesture: true });

    expect(candidates.map((c) => c.note)).toEqual([
      undefined,
      "scrolled out of its container — add a scroll-to step",
      "disabled",
    ]);
    // clickable adds, disabled subtracts, off the same near-miss base.
    expect(candidates[0]!.score).toBeGreaterThan(candidates[1]!.score);
    expect(candidates[1]!.score).toBeGreaterThan(candidates[2]!.score);
  });

  it("caps candidates at the limit while total counts every distinct match", () => {
    const tree = screen(
      Array.from({ length: 8 }, (_, i) =>
        label(`Chekout ${i}`, { frame: { x: 0.1, y: 0.1 * i, width: 0.3, height: 0.04 } })
      )
    );

    const capped = rankCandidates(tree, { text: "Checkout" });
    expect(capped.candidates).toHaveLength(5); // FLOW_FAILURE_CANDIDATE_LIMIT
    expect(capped.total).toBe(8);
    expect(capped.candidates[0]!.node.label).toBe("Chekout 0"); // reading order breaks the tie

    const tighter = rankCandidates(tree, { text: "Checkout" }, { limit: 2 });
    expect(tighter.candidates).toHaveLength(2);
    expect(tighter.total).toBe(8);
  });

  it("suggests YAML that round-trips through the flow parser and resolves back", () => {
    const button = n({
      role: "AXButton",
      identifier: "submit-btn",
      label: "Submit order",
      frame: { x: 0.1, y: 0.5, width: 0.3, height: 0.06 },
    });
    const text = label("Check out", { frame: { x: 0.1, y: 0.7, width: 0.3, height: 0.04 } });
    const tree = screen([button, text]);

    const byId = rankCandidates(tree, { text: "submitBtn", loose: true }).candidates[0]!;
    expect(byId.selectorYaml).toBe('{"id":"submit-btn"}');
    const idSelector = reparse(byId.selectorYaml);
    expect(idSelector).toEqual({ identifier: "submit-btn" });
    // The suggestion is only useful if it resolves to the element it described.
    expect(flowMatchAll(tree, idSelector)).toEqual([button]);

    const byText = rankCandidates(tree, { text: "Checkout" }).candidates[0]!;
    expect(byText.selectorYaml).toBe('{"text":"Check out"}');
    // Strict, never sugared back to a bare (loose) string: a suggestion must
    // not silently gain the identifier-first fallback it was never verified
    // against.
    const textSelector = reparse(byText.selectorYaml);
    expect(textSelector).toEqual({ text: "Check out" });
    expect(flowMatchAll(tree, textSelector)).toEqual([text]);
  });

  it("ranks a 3000-node tree with long subtree text in well under a second", () => {
    // The cost bound is load-bearing, not decorative: `editDistance` is O(n·m)
    // and a flattened container's `subtreeText` is the whole screen's text, so
    // an untruncated near-miss pass turns a failure report into a hang. Wall
    // clock is asserted so the truncation cannot be removed silently — measured
    // at ~55 ms with the 128-char bound and ~1.6 s without it, so lifting the
    // bound fails this assertion rather than merely slowing it down.
    const filler = "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(150);
    const children: DescribeNode[] = Array.from({ length: 3000 }, (_, i) =>
      n({
        role: "AXStaticText",
        identifier: `row-${i}`,
        label: `Row ${i}`,
        subtreeText: `Row ${i} ${filler}`,
        frame: { x: 0, y: i / 3000, width: 0.5, height: 0.0003 },
      })
    );
    const needle = n({
      role: "AXButton",
      identifier: "submit-buton",
      frame: { x: 0.1, y: 0.9, width: 0.3, height: 0.06 },
    });
    const tree = screen([...children, needle]);

    const started = Date.now();
    const { candidates } = rankCandidates(tree, { text: "submitButton", loose: true });
    const elapsed = Date.now() - started;

    expect(candidates[0]?.node.identifier).toBe("submit-buton");
    expect(elapsed).toBeLessThan(1000);
  });
});

describe("diagnoseScope", () => {
  const target: FlowSelector = { text: "Delete", within: { identifier: "profile-card" } };

  it("names a relational scope that resolved to nothing", () => {
    const tree = screen([label("Delete", { frame: { x: 0.1, y: 0.2, width: 0.3, height: 0.04 } })]);
    // The target IS on screen — the container it was scoped to is not, so the
    // target was never searched for and a message about it would send the
    // operator editing the one part of the selector that was correct.
    expect(diagnoseScope(tree, target)).toBe("within");
  });

  it("returns undefined when every scope resolved", () => {
    const tree = screen([
      n({
        role: "AXGroup",
        identifier: "profile-card",
        frame: { x: 0, y: 0.1, width: 1, height: 0.3 },
      }),
      label("Delete", { frame: { x: 0.1, y: 0.15, width: 0.3, height: 0.04 } }),
    ]);
    expect(diagnoseScope(tree, target)).toBeUndefined();
    // …and reports relations in the order the match engine applies them.
    expect(diagnoseScope(tree, { ...target, after: { text: "Nope" } })).toBe("after");
  });
});

describe("rows whose suggestion does not resolve back", () => {
  /**
   * Five same-rectangle rows, each derived to a DIFFERENT identifier, each
   * shadowed by a smaller node carrying that identifier — so `selectorToFrame`
   * lands on the shadow and every suggestion fails verification. A sixth,
   * lower-ranked row resolves cleanly.
   */
  function shadowedTree(): DescribeNode {
    const frame = { x: 0.1, y: 0.2, width: 0.5, height: 0.05 };
    const kids: DescribeNode[] = [];
    for (const [i, id] of ["a1", "a2", "a3", "a4", "a5"].entries()) {
      // Ranks (its label near-misses the needle) and derives `{id}`...
      kids.push(n({ identifier: id, label: "Checkout", frame }));
      // ...but a SMALLER node carries the same identifier and no matching
      // text, so it never ranks while `selectorToFrame` — which picks by area
      // — lands on it, and the suggestion fails verification.
      kids.push(
        n({ identifier: id, frame: { x: 0.8, y: 0.05 + i / 100, width: 0.02, height: 0.005 } })
      );
    }
    kids.push(
      n({
        identifier: "goodBtn",
        label: "Checkout",
        frame: { x: 0.1, y: 0.7, width: 0.4, height: 0.05 },
      })
    );
    return screen(kids);
  }

  it("collapses them to one row per rectangle instead of spending every slot", () => {
    // Splitting the suggestion into a cheap half (for the dedupe) and an
    // expensive half (verification) made the dedupe key stop depending on
    // whether a suggestion actually resolves — so five unusable rows for ONE
    // rectangle each took a slot and pushed the row that does resolve out of
    // the list entirely.
    const { candidates } = rankCandidates(shadowedTree(), { text: "Checkoutt" }, { limit: 5 });

    const rectangles = candidates.filter((c) => c.selectorYaml === undefined);
    expect(rectangles).toHaveLength(1);
    // ...and the row that DOES resolve still earns its place.
    expect(candidates.some((c) => c.selectorYaml === '{"id":"goodBtn"}')).toBe(true);
  });

  it("keeps the row itself — it still names the element and its rectangle", () => {
    const { candidates } = rankCandidates(shadowedTree(), { text: "Checkoutt" }, { limit: 5 });
    const bare = candidates.find((c) => c.selectorYaml === undefined);
    expect(bare?.node.label).toBe("Checkout");
    expect(bare?.node.frame.width).toBeGreaterThan(0);
  });
});
