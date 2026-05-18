import { describe, it, expect } from "vitest";
import { VariantProposalStore } from "../src/utils/variant-proposals";

const variant = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  summary: `${name} summary`,
  ...extra,
});

describe("VariantProposalStore — proposing (non-blocking)", () => {
  it("accumulates variants per element and across elements", () => {
    const s = new VariantProposalStore();
    const r1 = s.proposeVariant({ element: "Foo", variant: variant("Bold") });
    const r2 = s.proposeVariant({ element: "Foo", variant: variant("Ghost") });
    const r3 = s.proposeVariant({ element: "Bar", variant: variant("Large") });

    expect(r1.round).toBe(1);
    expect(r1.elementId).toBe(r2.elementId); // same element merges
    expect(r1.elementId).not.toBe(r3.elementId);
    expect(r2.variantCount).toBe(2);
    expect(r3.totalElements).toBe(2);

    const snap = s.snapshot();
    expect(snap.proposals).toHaveLength(2);
    expect(snap.proposals[0]!.variants.map((v) => v.name)).toEqual(["Bold", "Ghost"]);
    expect(snap.completed).toBe(false);
    expect(snap.agentWaiting).toBe(false);
  });

  it("defaults match to text:element and honors an explicit matcher", () => {
    const s = new VariantProposalStore();
    s.proposeVariant({ element: "Foo button", variant: variant("A") });
    s.proposeVariant({
      element: "Bar",
      match: { by: "identifier", value: "bar-id" },
      variant: variant("B"),
    });
    const [foo, bar] = s.snapshot().proposals;
    expect(foo!.match).toEqual({ by: "text", value: "Foo button" });
    expect(bar!.match).toEqual({ by: "identifier", value: "bar-id" });
  });

  it("returns no_proposals when awaiting before any proposal", async () => {
    const s = new VariantProposalStore();
    const out = await s.awaitSelection({ timeoutMs: 1000 });
    expect(out.status).toBe("no_proposals");
  });
});

describe("VariantProposalStore — blocking await + submit", () => {
  it("await blocks until submitSelection, then returns the structured outcome", async () => {
    const s = new VariantProposalStore();
    s.proposeVariant({ element: "Foo", variant: variant("Bold") }); // v1
    s.proposeVariant({ element: "Foo", variant: variant("Ghost") }); // v2
    s.proposeVariant({ element: "Bar", variant: variant("Large") }); // v3
    s.proposeVariant({ element: "Baz", variant: variant("Shadow") }); // v4

    const foo = s.snapshot().proposals.find((p) => p.element === "Foo")!;
    const bar = s.snapshot().proposals.find((p) => p.element === "Bar")!;
    const baz = s.snapshot().proposals.find((p) => p.element === "Baz")!;

    let resolved = false;
    const p = s.awaitSelection({ timeoutMs: 5000 }).then((o) => {
      resolved = true;
      return o;
    });
    await Promise.resolve();
    expect(resolved).toBe(false); // genuinely blocked
    expect(s.snapshot().agentWaiting).toBe(true);

    s.submitSelection({
      selections: [
        { elementId: foo.id, variantId: foo.variants[1]!.id }, // Ghost
        { elementId: bar.id, variantId: bar.variants[0]!.id, comment: "go big" },
        { elementId: baz.id, variantId: null }, // skipped
      ],
      globalComment: "ship it",
    });

    const out = await p;
    expect(resolved).toBe(true);
    expect(out.status).toBe("completed");
    if (out.status !== "completed") throw new Error("unreachable");
    expect(out.selections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          element: "Foo",
          chosenVariant: expect.objectContaining({ name: "Ghost" }),
        }),
        expect.objectContaining({
          element: "Bar",
          chosenVariant: expect.objectContaining({ name: "Large" }),
          comment: "go big",
        }),
      ])
    );
    expect(out.unselected).toEqual([{ element: "Baz" }]);
    expect(out.globalComment).toBe("ship it");
    expect(s.snapshot().agentWaiting).toBe(false);
  });

  it("resolves EVERY concurrent waiter with the same frozen outcome", async () => {
    const s = new VariantProposalStore();
    s.proposeVariant({ element: "Foo", variant: variant("Bold") });
    const foo = s.snapshot().proposals[0]!;

    const a = s.awaitSelection({ timeoutMs: 5000 });
    const b = s.awaitSelection({ timeoutMs: 5000 });
    expect(s.snapshot().agentWaiting).toBe(true);

    s.submitSelection({ selections: [{ elementId: foo.id, variantId: foo.variants[0]!.id }] });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.status).toBe("completed");
    expect(rb.status).toBe("completed");
    expect(ra).toEqual(rb); // identical frozen outcome, neither stranded
  });

  it("treats an invalid non-null variantId as unselected", async () => {
    const s = new VariantProposalStore();
    s.proposeVariant({ element: "Foo", variant: variant("Bold") });
    const foo = s.snapshot().proposals[0]!;
    const p = s.awaitSelection({ timeoutMs: 2000 });
    s.submitSelection({ selections: [{ elementId: foo.id, variantId: "does-not-exist" }] });
    const out = await p;
    if (out.status !== "completed") throw new Error("unreachable");
    expect(out.unselected).toEqual([{ element: "Foo" }]);
  });
});

describe("VariantProposalStore — timeout / abort / lifecycle", () => {
  it("returns a re-awaitable pending outcome on timeout", async () => {
    const s = new VariantProposalStore();
    s.proposeVariant({ element: "Foo", variant: variant("Bold") });
    const out = await s.awaitSelection({ timeoutMs: 20 });
    expect(out.status).toBe("pending");
    if (out.status !== "pending") throw new Error("unreachable");
    expect(out.proposedElements).toEqual([{ element: "Foo", variantCount: 1 }]);
    expect(s.snapshot().agentWaiting).toBe(false);
    // still re-awaitable
    const again = s.awaitSelection({ timeoutMs: 20 });
    await expect(again).resolves.toMatchObject({ status: "pending" });
  });

  it("rejects with AbortError on client disconnect and clears the waiter", async () => {
    const s = new VariantProposalStore();
    s.proposeVariant({ element: "Foo", variant: variant("Bold") });
    const ac = new AbortController();
    const p = s.awaitSelection({ timeoutMs: 5000, signal: ac.signal });
    expect(s.snapshot().agentWaiting).toBe(true);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(s.snapshot().agentWaiting).toBe(false);
  });

  it("rolls to a fresh round after a completed round is consumed", async () => {
    const s = new VariantProposalStore();
    s.proposeVariant({ element: "Foo", variant: variant("Bold") });
    const foo = s.snapshot().proposals[0]!;
    const p = s.awaitSelection({ timeoutMs: 2000 });
    s.submitSelection({ selections: [{ elementId: foo.id, variantId: foo.variants[0]!.id }] });
    await p; // consumes round 1

    // awaiting a consumed/closed round must not hang
    const closed = await s.awaitSelection({ timeoutMs: 2000 });
    expect(closed.status).toBe("no_proposals");

    const r = s.proposeVariant({ element: "New", variant: variant("X") });
    expect(r.round).toBe(2);
    expect(s.snapshot().proposals.map((x) => x.element)).toEqual(["New"]);
  });

  it("wakes a parked waiter when the round is superseded by reset()", async () => {
    const s = new VariantProposalStore();
    s.proposeVariant({ element: "Foo", variant: variant("Bold") });
    const p = s.awaitSelection({ timeoutMs: 5000 });
    expect(s.snapshot().agentWaiting).toBe(true);
    s.reset();
    const out = await p; // must not hang
    expect(out.status).toBe("no_proposals");
    expect(s.snapshot().agentWaiting).toBe(false);
  });

  it("throws on submit with no proposals (HTTP layer maps to 400)", () => {
    const s = new VariantProposalStore();
    expect(() => s.submitSelection({ selections: [] })).toThrow(/no proposals/i);
  });
});
