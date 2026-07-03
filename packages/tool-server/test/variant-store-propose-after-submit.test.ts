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
    // fresh round, not vanish behind the frozen pre-submit outcome. Pre-fix,
    // Beta was appended onto the already-completed round 1 (round 1,
    // totalElements 2) and then dropped; the fix rolls a fresh round so Beta is
    // round 2's sole element.
    const b = s.proposeVariant({ element: "Beta", variant: variant("B1") });
    expect(b.round).toBe(2);
    expect(b.totalElements).toBe(1);

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

  it("bounds the undelivered-outcome queue against a runaway waiter-less submitter", async () => {
    // The submit route is unauthenticated. A caller that proposes-and-submits
    // repeatedly without ever awaiting rolls a fresh round each cycle and queues
    // one outcome per round; without a cap the queue grows without limit. It is
    // bounded to MAX_PENDING_OUTCOMES (32), keeping the most recent decisions.
    const s = new VariantProposalStore();
    for (let i = 0; i < 50; i++) {
      s.proposeVariant({ element: `El${i}`, variant: variant(`V${i}`) });
      const p = s.snapshot().proposals[0]!;
      s.submitSelection({ selections: [{ elementId: p.id, variantId: p.variants[0]!.id }] });
    }
    // Drain every queued outcome; count completions and note the first/last round.
    let completed = 0;
    let firstRound = 0;
    let lastRound = 0;
    for (let i = 0; i < 60; i++) {
      const out = await s.awaitSelection({ timeoutMs: 50 });
      if (out.status !== "completed") break;
      if (completed === 0) firstRound = out.round;
      lastRound = out.round;
      completed++;
    }
    expect(completed).toBe(32); // capped, not 50
    // Oldest entries were dropped; the most recent decisions are retained.
    expect(firstRound).toBe(19);
    expect(lastRound).toBe(50);
  });

  it("an already-aborted await does not drain (and lose) a queued outcome", async () => {
    // The pendingOutcomes fast-path mutates state (shift()). If the caller's
    // signal is already aborted (HTTP client disconnected before the request
    // reached awaitSelection), draining the queue for a dead caller would
    // permanently destroy the human's already-submitted selection — the exact
    // loss the queue exists to prevent. It must reject with AbortError instead,
    // leaving the outcome for the next live await.
    const s = new VariantProposalStore();
    s.proposeVariant({ element: "Alpha", variant: variant("A1") });
    const a = s.snapshot().proposals[0]!;
    s.submitSelection({ selections: [{ elementId: a.id, variantId: a.variants[0]!.id }] });

    const ac = new AbortController();
    ac.abort();
    await expect(s.awaitSelection({ timeoutMs: 1_000, signal: ac.signal })).rejects.toMatchObject({
      name: "AbortError",
    });

    // The decision survived: a fresh live await still delivers Alpha.
    const retry = await s.awaitSelection({ timeoutMs: 100 });
    expect(retry.status).toBe("completed");
    if (retry.status === "completed") {
      expect(retry.selections.map((x) => x.element)).toContain("Alpha");
    }
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
    // The precise property is a clean start: the session reset the round and
    // dropped the stale queue, so there is nothing to deliver. `not completed`
    // alone would also pass for a stranded `pending`, which would be a bug.
    expect(out.status).toBe("no_proposals");
  });

  it("delivers a submit made DURING a CLI session (consumed, nothing queued) as a clean no_proposals", async () => {
    // The CLI-session submit branch marks the round consumed and deliberately
    // queues nothing (the `argent lens` watcher reads the outcome over HTTP; no
    // await is parked). await_user_selection is hidden during a real CLI session,
    // but if it is reached it must report the round already done — never a
    // phantom completion and never a strand. This pins that branch through the
    // public awaitSelection surface, which no other test exercises.
    const s = new VariantProposalStore();
    s.setCliSession(true, [{ id: "x", name: "X" }]);
    s.proposeVariant({ element: "Alpha", variant: variant("A1") });
    const a = s.snapshot().proposals.find((p) => p.element === "Alpha")!;
    // No await parked → the CLI-session branch runs (consumed = true, no queue).
    s.submitSelection({ selections: [{ elementId: a.id, variantId: a.variants[0]!.id }] });
    const out = await s.awaitSelection({ timeoutMs: 100 });
    expect(out.status).toBe("no_proposals");
  });

  it("preserves selection/global/annotation comments across the roll on the drain path", async () => {
    // The queue-drain path freezes the outcome (buildOutcome) BEFORE reset()
    // clears the live comment/annotation state, then delivers that frozen copy
    // after an intervening propose_variant rolls the round. Only the element
    // NAME was pinned before; assert the full comment payload survives the roll,
    // since the drain depends on that separate frozen object.
    const s = new VariantProposalStore();
    s.proposeVariant({ element: "Alpha", variant: variant("A1") });
    const a = s.snapshot().proposals.find((p) => p.element === "Alpha")!;
    s.submitSelection({
      selections: [{ elementId: a.id, variantId: a.variants[0]!.id, comment: "make it blue" }],
      globalComment: "overall: tighten spacing",
      annotations: [
        { target: "Save button", match: { by: "label", value: "Save" }, comment: "too small" },
      ],
    });

    // Roll the round out from under the frozen outcome.
    s.proposeVariant({ element: "Beta", variant: variant("B1") });

    const first = await s.awaitSelection({ timeoutMs: 200 });
    expect(first.status).toBe("completed");
    if (first.status === "completed") {
      const alpha = first.selections.find((x) => x.element === "Alpha");
      expect(alpha?.comment).toBe("make it blue");
      expect(first.globalComment).toBe("overall: tighten spacing");
      expect(first.annotations).toHaveLength(1);
      expect(first.annotations[0]!.comment).toBe("too small");
      expect(first.annotations[0]!.match.value).toBe("Save");
    }
  });

  it("signals morePending when a completed outcome is drained while a fresh round is live", async () => {
    // A waiter-less submit is queued; a later propose rolls a fresh round. The
    // drained (old-round) completed outcome must carry morePending=true so the
    // agent — told to apply-and-stop on completed — awaits again instead of
    // stranding the freshly-staged round.
    const s = new VariantProposalStore();
    s.proposeVariant({ element: "Alpha", variant: variant("A1") });
    const a = s.snapshot().proposals.find((p) => p.element === "Alpha")!;
    s.submitSelection({ selections: [{ elementId: a.id, variantId: a.variants[0]!.id }] });
    s.proposeVariant({ element: "Beta", variant: variant("B1") });

    const first = await s.awaitSelection({ timeoutMs: 200 });
    expect(first.status).toBe("completed");
    if (first.status === "completed") {
      expect(first.round).toBe(1);
      expect(first.morePending).toBe(true);
    }
    // The signalled round then surfaces on the next await.
    const second = await s.awaitSelection({ timeoutMs: 200 });
    expect(second.status).toBe("pending");
  });

  it("does not signal morePending on a plain single-round completion", async () => {
    // The common case (submit with a waiter parked, no roll) must NOT set
    // morePending — the agent should apply and stop as before.
    const s = new VariantProposalStore();
    s.proposeVariant({ element: "Alpha", variant: variant("A1") });
    const a = s.snapshot().proposals.find((p) => p.element === "Alpha")!;
    const pending = s.awaitSelection({ timeoutMs: 2_000 });
    s.submitSelection({ selections: [{ elementId: a.id, variantId: a.variants[0]!.id }] });
    const out = await pending;
    expect(out.status).toBe("completed");
    if (out.status === "completed") {
      expect(out.morePending).toBeUndefined();
    }
  });

  it("bounds a queued outcome's size: caps matcher value and annotation count", async () => {
    // MAX_PENDING_OUTCOMES bounds the COUNT of queued outcomes, but each retained
    // outcome must also be size-bounded: the submit route is unauthenticated, and
    // an annotation's match.value was otherwise ingested uncapped and in unbounded
    // number. Assert both are clamped in the frozen, queued outcome.
    const s = new VariantProposalStore();
    s.proposeVariant({ element: "Alpha", variant: variant("A1") });
    const a = s.snapshot().proposals[0]!;
    // Over-cap on both axes (cap is 200 annotations / 200-char matcher value) —
    // no need for pathological sizes to prove the clamp.
    const bigValue = "x".repeat(5_000);
    const manyAnnotations = Array.from({ length: 1_000 }, () => ({
      target: "t",
      match: { by: "text" as const, value: bigValue },
      comment: "c",
    }));
    // Waiter-less submit → the outcome is frozen and queued.
    s.submitSelection({
      selections: [{ elementId: a.id, variantId: a.variants[0]!.id }],
      annotations: manyAnnotations,
    });
    const out = await s.awaitSelection({ timeoutMs: 100 });
    expect(out.status).toBe("completed");
    if (out.status === "completed") {
      expect(out.annotations.length).toBeLessThanOrEqual(200);
      expect(out.annotations[0]!.match.value.length).toBeLessThanOrEqual(200);
    }
  });
});
