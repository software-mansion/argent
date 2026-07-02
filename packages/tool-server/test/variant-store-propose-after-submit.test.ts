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

    // Alpha's already-decided outcome is delivered first (it must never be
    // silently discarded), then a second await surfaces Beta's fresh round.
    const outs = [
      await s.awaitSelection({ timeoutMs: 200 }),
      await s.awaitSelection({ timeoutMs: 200 }),
    ];
    const mentioned = new Set<string>();
    for (const out of outs) {
      if (out.status === "completed") {
        for (const x of [...out.selections, ...out.unselected]) mentioned.add(x.element);
      } else if (out.status === "pending") {
        for (const x of out.proposedElements) mentioned.add(x.element);
      }
    }
    // Beta must be accounted for somewhere (presented for selection or in the
    // outcome), never silently dropped.
    expect(mentioned.has("Beta")).toBe(true);
    expect(mentioned.has("Alpha")).toBe(true);
  });

  it("delivers the already-submitted-but-undelivered outcome before the rolled round's pending state", async () => {
    // Regression: the naive fix above made Beta's fresh round visible, but at
    // the cost of destroying Alpha's already-submitted (and not yet retrieved)
    // selection outright — reset() nulled `lastOutcome` with nothing else
    // holding onto it. The agent must still get Alpha's answer; it just
    // arrives on the first await, before Beta's round is presented.
    const s = new VariantProposalStore();
    s.proposeVariant({ element: "Alpha", variant: variant("A1") });
    const a = s.snapshot().proposals.find((p) => p.element === "Alpha")!;
    s.submitSelection({ selections: [{ elementId: a.id, variantId: a.variants[0]!.id }] });

    s.proposeVariant({ element: "Beta", variant: variant("B1") });

    const first = await s.awaitSelection({ timeoutMs: 200 });
    expect(first.status).toBe("completed");
    if (first.status === "completed") {
      expect(first.selections.map((x) => x.element)).toContain("Alpha");
    }

    const second = await s.awaitSelection({ timeoutMs: 200 });
    expect(second.status).toBe("pending");
    if (second.status === "pending") {
      expect(second.proposedElements.map((x) => x.element)).toContain("Beta");
    }
  });

  it("still resolves normally when propose_variant is called before any submission", async () => {
    // No completed round exists yet, so pendingOutcomes is empty and behavior
    // is unchanged: propose, submit, await in the normal order.
    const s = new VariantProposalStore();
    s.proposeVariant({ element: "Alpha", variant: variant("A1") });
    const a = s.snapshot().proposals.find((p) => p.element === "Alpha")!;
    const pending = s.awaitSelection({ timeoutMs: 2_000 });
    s.submitSelection({ selections: [{ elementId: a.id, variantId: a.variants[0]!.id }] });
    const out = await pending;
    expect(out.status).toBe("completed");
    if (out.status === "completed") {
      expect(out.selections.map((x) => x.element)).toContain("Alpha");
    }
  });

  it("a repeat waiter-less submit does NOT deliver the outcome twice", async () => {
    // The submit route is unauthenticated and the preview UI re-enables its
    // Complete button, so the same round can be submitted more than once with
    // no await parked. Only ONE completion may ever be delivered — the second
    // await must report the round already returned, not a phantom duplicate.
    const s = new VariantProposalStore();
    s.proposeVariant({ element: "Alpha", variant: variant("A1") });
    const a = s.snapshot().proposals.find((p) => p.element === "Alpha")!;
    const sel = [{ elementId: a.id, variantId: a.variants[0]!.id }];
    s.submitSelection({ selections: sel });
    s.submitSelection({ selections: sel });
    const first = await s.awaitSelection({ timeoutMs: 200 });
    const second = await s.awaitSelection({ timeoutMs: 200 });
    expect(first.status).toBe("completed");
    expect(second.status).toBe("no_proposals");
  });

  it("a repeat submit AFTER the outcome was consumed does not resurrect it", async () => {
    // submit → await (delivers + consumes) → submit again → await must NOT
    // re-deliver the already-consumed outcome, and must not strand.
    const s = new VariantProposalStore();
    s.proposeVariant({ element: "Alpha", variant: variant("A1") });
    const a = s.snapshot().proposals.find((p) => p.element === "Alpha")!;
    const sel = [{ elementId: a.id, variantId: a.variants[0]!.id }];
    s.submitSelection({ selections: sel });
    expect((await s.awaitSelection({ timeoutMs: 200 })).status).toBe("completed");
    s.submitSelection({ selections: sel });
    expect((await s.awaitSelection({ timeoutMs: 200 })).status).toBe("no_proposals");
  });

  it("starting a CLI session does not leak a prior waiter-less outcome into its first await", async () => {
    // A queued-but-undelivered outcome from a prior (possibly non-CLI) flow
    // must not surface as the CLI session's first await result.
    const s = new VariantProposalStore();
    s.proposeVariant({ element: "Alpha", variant: variant("A1") });
    const a = s.snapshot().proposals.find((p) => p.element === "Alpha")!;
    s.submitSelection({ selections: [{ elementId: a.id, variantId: a.variants[0]!.id }] });
    s.setCliSession(true, [{ id: "x", name: "X" }]);
    const out = await s.awaitSelection({ timeoutMs: 100 });
    expect(out.status).not.toBe("completed");
  });
});
