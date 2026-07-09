import { describe, it, expect } from "vitest";
import { VariantProposalStore } from "../src/utils/variant-proposals";

// The unauthenticated submit route must not retain an unbounded number of
// selections nor an unbounded variantId in `this.submitted` — mirroring the
// annotation caps, "bound memory regardless of caller".
describe("VariantProposalStore — selection retention is bounded regardless of caller", () => {
  it("dedups selections per element and caps the variantId", () => {
    const s = new VariantProposalStore();
    const a = s.proposeVariant({ element: "Alpha", variant: { name: "v1", summary: "s" } });
    const sels: Array<{ elementId: string; variantId: string | null }> = [];
    for (let i = 0; i < 50_000; i++)
      sels.push({ elementId: a.elementId, variantId: "x".repeat(100) });
    sels.push({ elementId: a.elementId, variantId: "y".repeat(5_000_000) });
    s.submitSelection({ selections: sels });

    const submitted = (
      s as unknown as {
        submitted: Array<{ elementId: string; variantId: string | null }>;
      }
    ).submitted;
    // Bounded to the number of distinct real proposals (1), not 50_001.
    expect(submitted.length).toBe(1);
    // The retained variantId is capped.
    expect((submitted[0]!.variantId ?? "").length).toBeLessThanOrEqual(200);
  });

  it("is behavior-preserving: the first selection per element still wins", () => {
    const s = new VariantProposalStore();
    const a = s.proposeVariant({ element: "Alpha", variant: { name: "v1", summary: "s" } });
    // First dup picks the real variant; later dups (skip / bogus) are dead weight.
    s.submitSelection({
      selections: [
        { elementId: a.elementId, variantId: a.variantId },
        { elementId: a.elementId, variantId: null },
        { elementId: a.elementId, variantId: "nonexistent" },
      ],
    });
    const out = s.getLastOutcome();
    expect(out?.status).toBe("completed");
    const alpha = out?.selections.find((x) => x.element === "Alpha");
    expect(alpha?.chosenVariant?.id).toBe(a.variantId);
  });

  it("keeps a selection for every distinct element (does not drop later elements)", () => {
    const s = new VariantProposalStore();
    const a = s.proposeVariant({ element: "Alpha", variant: { name: "v1", summary: "s" } });
    const b = s.proposeVariant({ element: "Beta", variant: { name: "v1", summary: "s" } });
    s.submitSelection({
      selections: [
        { elementId: a.elementId, variantId: a.variantId },
        { elementId: b.elementId, variantId: b.variantId },
      ],
    });
    const out = s.getLastOutcome();
    const picked = out?.selections.map((x) => x.element) ?? [];
    expect(picked).toContain("Alpha");
    expect(picked).toContain("Beta");
  });
});
