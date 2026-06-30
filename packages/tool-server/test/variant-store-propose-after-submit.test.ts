import { describe, it, expect } from "vitest";
import { VariantProposalStore } from "../src/utils/variant-proposals";

const variant = (name: string) => ({ name, summary: `${name} summary` });

describe("variant store: propose after a waiter-less submit", () => {
  it("does not drop an element proposed after submit-without-await", async () => {
    const s = new VariantProposalStore();
    s.proposeVariant({ element: "Alpha", variant: variant("A1") });
    const a = s.snapshot().proposals.find((p) => p.element === "Alpha")!;
    // Submit with NO await parked → round becomes completed && !consumed.
    s.submitSelection({ selections: [{ elementId: a.id, variantId: a.variants[0]!.id }] });

    // A new element proposed during this lingering completed round must begin a
    // fresh round, not vanish behind the frozen pre-submit outcome.
    const b = s.proposeVariant({ element: "Beta", variant: variant("B1") });
    expect(b.totalElements).toBeGreaterThanOrEqual(1); // Beta is accepted

    const out = await s.awaitSelection({ timeoutMs: 200 });
    const mentioned = new Set<string>([
      ...(out.status === "completed" ? out.selections.map((x) => x.element) : []),
      ...(out.status === "completed" ? out.unselected.map((x) => x.element) : []),
      ...(out.status === "pending" ? out.proposedElements.map((x) => x.element) : []),
    ]);
    // Beta must be accounted for somewhere (presented for selection or in the
    // outcome), never silently dropped. After the fix it lands in a fresh round
    // that is still awaiting selection, so it shows up as a pending proposal.
    expect(mentioned.has("Beta")).toBe(true);
  });
});
