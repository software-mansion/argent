import { describe, it, expect } from "vitest";
import { VariantProposalStore } from "../src/utils/variant-proposals";

// A CLI (`argent lens`) session boundary is a fresh start on BOTH ends: a
// proposal staged during a session that the user never submitted must NOT bleed
// into a subsequent NON-CLI round's outcome once the session ends.
describe("VariantProposalStore — CLI session boundary resets stale round state", () => {
  it("an unsubmitted lens proposal does not bleed into a later non-CLI outcome", async () => {
    const s = new VariantProposalStore();
    s.setCliSession(true, [{ id: "x", name: "X" }]);
    s.proposeVariant({ element: "Alpha", variant: { name: "a", summary: "s" } }); // staged, never submitted
    s.setCliSession(false); // session ends

    // A later NON-CLI flow proposes a different element and awaits.
    const beta = s.proposeVariant({ element: "Beta", variant: { name: "b", summary: "s" } });
    s.submitSelection({ selections: [{ elementId: beta.elementId, variantId: beta.variantId }] });
    const out = await s.awaitSelection({ timeoutMs: 5 });

    expect(out.status).toBe("completed");
    if (out.status === "completed") {
      const names = [
        ...out.selections.map((x) => x.element),
        ...out.unselected.map((x) => x.element),
      ];
      expect(names).toContain("Beta");
      // Alpha belonged to the ended lens session — it must be gone.
      expect(names).not.toContain("Alpha");
    }
  });

  it("ending a clean CLI session does not gratuitously bump the round", () => {
    const s = new VariantProposalStore();
    s.setCliSession(true);
    s.setCliSession(false); // nothing staged -> no reset
    expect(s.proposeVariant({ element: "Foo", variant: { name: "f", summary: "s" } }).round).toBe(
      1
    );
  });
});
