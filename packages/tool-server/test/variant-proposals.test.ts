import { describe, it, expect } from "vitest";
import { VariantProposalStore } from "../src/utils/variant-proposals";

const variant = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  summary: `${name} summary`,
  ...extra,
});

const KNOWN_PLATFORMS = new Set(["ios", "ios-remote", "android", "chromium", "vega"]);

/**
 * Assert a Lens telemetry payload carries only privacy-safe primitives: numbers,
 * booleans, `undefined`, or (only for `platform`) a known platform enum. Any
 * leaked user content — an element name, comment, id, or path — would be an
 * arbitrary string that is none of these, so this fails without needing to know
 * the specific text (strictly stronger than a literal blocklist).
 */
function assertPrivacySafe(payload: unknown): void {
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    const ok =
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === undefined ||
      (key === "platform" && typeof value === "string" && KNOWN_PLATFORMS.has(value));
    expect(ok, `field ${key}=${JSON.stringify(value)} is not a privacy-safe primitive`).toBe(true);
  }
}

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

  it("delivers element annotations and a previewImage through the outcome", async () => {
    const s = new VariantProposalStore();
    s.proposeVariant({
      element: "Foo",
      variant: { name: "Bold", summary: "s", previewImage: "/tmp/shot.png" },
    });
    const foo = s.snapshot().proposals[0]!;
    expect(foo.variants[0]!.previewImage).toBe("/tmp/shot.png");
    expect(s.findVariant(foo.id, foo.variants[0]!.id)?.previewImage).toBe("/tmp/shot.png");

    const p = s.awaitSelection({ timeoutMs: 2000 });
    s.submitSelection({
      selections: [{ elementId: foo.id, variantId: foo.variants[0]!.id }],
      annotations: [
        { target: "Search bar", match: { by: "text", value: "Search" }, comment: "add clear (x)" },
        { target: "", match: { by: "label", value: "" }, comment: "   " }, // dropped (blank)
      ],
    });
    const out = await p;
    if (out.status !== "completed") throw new Error("unreachable");
    expect(out.annotations).toEqual([
      { target: "Search bar", match: { by: "text", value: "Search" }, comment: "add clear (x)" },
    ]);
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

  it("notifyWindowUnavailable settles a parked waiter with a pending fallback message", async () => {
    const s = new VariantProposalStore();
    s.proposeVariant({ element: "Foo", variant: variant("Bold") });
    s.proposeVariant({ element: "Bar", variant: variant("Tall") });
    const p = s.awaitSelection({ timeoutMs: 5000 });
    expect(s.snapshot().agentWaiting).toBe(true);

    s.notifyWindowUnavailable("electron not found", "http://127.0.0.1:9999/preview/");

    const out = await p; // must not hang for the full timeout
    expect(out.status).toBe("pending");
    if (out.status !== "pending") throw new Error("unreachable");
    expect(out.message).toContain("http://127.0.0.1:9999/preview/");
    expect(out.message).toContain("electron");
    expect(out.message).toMatch(/await_user_selection again/i);
    expect(out.proposedElements).toEqual([
      { element: "Foo", variantCount: 1 },
      { element: "Bar", variantCount: 1 },
    ]);
    expect(s.snapshot().agentWaiting).toBe(false);
  });

  it("notifyWindowUnavailable falls back to a generic URL hint when url is null", async () => {
    const s = new VariantProposalStore();
    s.proposeVariant({ element: "Foo", variant: variant("Bold") });
    const p = s.awaitSelection({ timeoutMs: 5000 });
    s.notifyWindowUnavailable("spawn ENOENT", null);
    const out = await p;
    if (out.status !== "pending") throw new Error("unreachable");
    expect(out.message).toContain("the tool-server /preview/ URL");
    expect(out.message).toContain("spawn ENOENT");
  });

  it("notifyWindowUnavailable is a no-op when nothing is parked", () => {
    const s = new VariantProposalStore();
    s.proposeVariant({ element: "Foo", variant: variant("Bold") });
    // No await parked → must not throw and must leave the round intact.
    expect(() => s.notifyWindowUnavailable("electron not found", null)).not.toThrow();
    expect(s.snapshot().completed).toBe(false);
    expect(s.snapshot().agentWaiting).toBe(false);
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

  it("throws only when there are neither proposals nor comments", () => {
    const s = new VariantProposalStore();
    expect(() => s.submitSelection({ selections: [] })).toThrow(/nothing to submit/i);
    expect(() =>
      s.submitSelection({ selections: [], annotations: [{ comment: "   " } as any] })
    ).toThrow(/nothing to submit/i);
  });

  it("delivers an annotations-only round (no proposals) via the await fast-path", async () => {
    const s = new VariantProposalStore();
    // No propose_variant at all — user only pinned an inspector comment.
    const r = s.submitSelection({
      selections: [],
      annotations: [
        { target: "Tab bar", match: { by: "role", value: "TabBar" }, comment: "raise contrast" },
      ],
    });
    expect(r.ok).toBe(true);
    const out = await s.awaitSelection({ timeoutMs: 1000 });
    expect(out.status).toBe("completed");
    if (out.status !== "completed") throw new Error("unreachable");
    expect(out.selections).toEqual([]);
    expect(out.annotations).toEqual([
      { target: "Tab bar", match: { by: "role", value: "TabBar" }, comment: "raise contrast" },
    ]);
  });
});

describe("VariantProposalStore — comment length caps (unauth selection route)", () => {
  // The selection route (POST /preview/variants/selection) is unauthenticated,
  // so every free-text field is capped on ingestion to bound memory. The cap
  // (2000 chars) matches the one annotations already used.
  const CAP = 2_000;

  it("truncates a selection comment, the globalComment, and an annotation comment to the cap", async () => {
    const s = new VariantProposalStore();
    s.proposeVariant({ element: "Foo", variant: variant("Bold") });
    const foo = s.snapshot().proposals[0]!;

    const huge = "x".repeat(CAP + 500);
    const p = s.awaitSelection({ timeoutMs: 2000 });
    s.submitSelection({
      selections: [{ elementId: foo.id, variantId: foo.variants[0]!.id, comment: huge }],
      globalComment: huge,
      annotations: [{ target: "Bar", match: { by: "text", value: "Bar" }, comment: huge }],
    });
    const out = await p;
    if (out.status !== "completed") throw new Error("unreachable");

    const sel = out.selections.find((x) => x.element === "Foo")!;
    expect(sel.comment).toHaveLength(CAP);
    expect(out.globalComment).toHaveLength(CAP);
    expect(out.annotations[0]!.comment).toHaveLength(CAP);
  });

  it("leaves a comment shorter than the cap unchanged", async () => {
    const s = new VariantProposalStore();
    s.proposeVariant({ element: "Foo", variant: variant("Bold") });
    const foo = s.snapshot().proposals[0]!;
    const p = s.awaitSelection({ timeoutMs: 2000 });
    s.submitSelection({
      selections: [{ elementId: foo.id, variantId: foo.variants[0]!.id, comment: "go big" }],
      globalComment: "ship it",
    });
    const out = await p;
    if (out.status !== "completed") throw new Error("unreachable");
    expect(out.selections.find((x) => x.element === "Foo")!.comment).toBe("go big");
    expect(out.globalComment).toBe("ship it");
  });
});

describe("VariantProposalStore — preview-window lifecycle events", () => {
  it("emits awaitParked exactly when a waiter parks (not on fast-path returns)", async () => {
    const s = new VariantProposalStore();
    let parked = 0;
    s.events.on("awaitParked", () => parked++);

    // Fast path 1: no proposals → returns immediately, no park.
    await s.awaitSelection({ timeoutMs: 10 });
    expect(parked).toBe(0);

    // Real park: proposals exist + nothing submitted yet.
    s.proposeVariant({ element: "Foo", variant: variant("Bold") });
    const p = s.awaitSelection({ timeoutMs: 30 });
    expect(parked).toBe(1);
    await p; // timeout → pending

    // Second real park on the same round.
    const p2 = s.awaitSelection({ timeoutMs: 30 });
    expect(parked).toBe(2);
    await p2;
  });

  it("emits selectionSubmitted on every successful submit", () => {
    const s = new VariantProposalStore();
    let submitted = 0;
    s.events.on("selectionSubmitted", () => submitted++);

    s.proposeVariant({ element: "Foo", variant: variant("Bold") });
    s.submitSelection({ selections: [] });
    expect(submitted).toBe(1);

    // A second round must produce a second event.
    s.proposeVariant({ element: "Bar", variant: variant("Tall") });
    s.submitSelection({ selections: [] });
    expect(submitted).toBe(2);
  });
});

describe("VariantProposalStore — CLI Lens session (`argent lens`)", () => {
  it("toggles snapshot.cliSession and emits cliSessionChanged with the state", () => {
    const s = new VariantProposalStore();
    const seen: boolean[] = [];
    s.events.on("cliSessionChanged", (active) => seen.push(active));

    expect(s.snapshot().cliSession).toBe(false);
    s.setCliSession(true);
    expect(s.snapshot().cliSession).toBe(true);
    expect(s.isCliSession()).toBe(true);
    s.setCliSession(true); // idempotent — no event
    s.setCliSession(false);
    expect(s.snapshot().cliSession).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it("carries the agent picker choices and records the human's pick", () => {
    const s = new VariantProposalStore();
    expect(s.snapshot().lensAgents).toEqual([]);
    expect(s.snapshot().lensAgentChoice).toBeNull();

    s.setCliSession(true, [
      { id: "claude", name: "Claude Code" },
      { id: "codex", name: "Codex CLI" },
    ]);
    expect(s.snapshot().lensAgents.map((a) => a.id)).toEqual(["claude", "codex"]);
    expect(s.snapshot().lensAgentChoice).toBeNull();

    s.setLensAgentChoice("codex");
    expect(s.snapshot().lensAgentChoice).toBe("codex");
    expect(s.getLensAgentChoice()).toBe("codex");
    expect(s.getLensAgentRemember()).toBe(false);

    // Ending the session clears the picker state.
    s.setCliSession(false);
    expect(s.snapshot().lensAgents).toEqual([]);
    expect(s.snapshot().lensAgentChoice).toBeNull();
  });

  it("records the remember flag with the pick and clears it on session end", () => {
    const s = new VariantProposalStore();
    s.setCliSession(true, [{ id: "claude", name: "Claude Code" }]);
    s.setLensAgentChoice("claude", true);
    expect(s.getLensAgentChoice()).toBe("claude");
    expect(s.getLensAgentRemember()).toBe(true);

    s.setCliSession(false);
    expect(s.getLensAgentChoice()).toBeNull();
    expect(s.getLensAgentRemember()).toBe(false);
  });

  it("a re-begin replaces stale choices and clears a prior pick", () => {
    const s = new VariantProposalStore();
    s.setCliSession(true, [{ id: "claude", name: "Claude Code" }]);
    s.setLensAgentChoice("claude");
    // Same active state, but a fresh begin must refresh the offered agents.
    s.setCliSession(true, [{ id: "gemini", name: "Gemini CLI" }]);
    expect(s.snapshot().lensAgents.map((a) => a.id)).toEqual(["gemini"]);
    expect(s.snapshot().lensAgentChoice).toBeNull();
  });

  it("exposes the last submitted outcome via getLastOutcome (null until submit)", () => {
    const s = new VariantProposalStore();
    expect(s.getLastOutcome()).toBeNull();

    s.proposeVariant({ element: "Foo", variant: variant("Bold") });
    s.submitSelection({
      selections: [],
      annotations: [{ target: "Foo", match: { by: "text", value: "Foo" }, comment: "make it pop" }],
      globalComment: "overall: tighter",
    });

    const out = s.getLastOutcome();
    expect(out?.status).toBe("completed");
    expect(out?.annotations[0]!.comment).toBe("make it pop");
    expect(out?.globalComment).toBe("overall: tighter");
  });

  it("rolls to a fresh round on the next propose after a CLI-session submit", () => {
    const s = new VariantProposalStore();
    s.setCliSession(true);
    expect(s.proposeVariant({ element: "Foo", variant: variant("Bold") }).round).toBe(1);
    s.submitSelection({ selections: [] });
    // No await consumes a CLI-session round, but the next propose must still open
    // a NEW round (not append to the submitted one) and clear the stale outcome.
    const r = s.proposeVariant({ element: "Bar", variant: variant("Tall") });
    expect(r.round).toBe(2);
    expect(r.totalElements).toBe(1);
    expect(s.getLastOutcome()).toBeNull();
  });

  it("without a CLI session, a submitted-but-unconsumed round rolls on the next propose", () => {
    const s = new VariantProposalStore();
    expect(s.proposeVariant({ element: "Foo", variant: variant("Bold") }).round).toBe(1);
    s.submitSelection({ selections: [] }); // no waiter parked → completed && !consumed
    // The next propose opens a FRESH round rather than appending behind the
    // frozen outcome (appending would silently drop the new element). The
    // earlier submitted outcome is not lost — it is queued in `pendingOutcomes`
    // and delivered on the next await, so rolling here is safe.
    const r = s.proposeVariant({ element: "Bar", variant: variant("Tall") });
    expect(r.round).toBe(2);
    expect(r.totalElements).toBe(1);
  });

  it("beginning a CLI session clears a leftover submitted round from a prior flow", () => {
    const s = new VariantProposalStore();
    // Simulate a prior NON-CLI flow that left completed=true/consumed=false: a
    // parked await timed out (waiter removed) and the user then submitted.
    s.proposeVariant({ element: "Old", variant: variant("Bold") });
    s.submitSelection({ selections: [] }); // completed, but nothing consumed it
    expect(s.getLastOutcome()).not.toBeNull();

    s.setCliSession(true); // begin → must reset the stale round

    // The session's first propose opens a FRESH round with only its own element,
    // not appended to the leftover "Old" round, and the stale outcome is gone.
    const r = s.proposeVariant({ element: "New", variant: variant("Tall") });
    expect(r.totalElements).toBe(1);
    expect(s.snapshot().proposals.map((p) => p.element)).toEqual(["New"]);
    expect(s.getLastOutcome()).toBeNull();
  });

  it("beginning a CLI session on a clean store does not bump the round past 1", () => {
    const s = new VariantProposalStore();
    s.setCliSession(true); // nothing to clear → no needless reset
    expect(s.proposeVariant({ element: "Foo", variant: variant("Bold") }).round).toBe(1);
  });
});

describe("VariantProposalStore — Lens-owned devices", () => {
  it("tracks owned devices and drains them once", () => {
    const s = new VariantProposalStore();
    expect(s.isDeviceOwned("udid-1")).toBe(false);

    s.markDeviceOwned("udid-1");
    s.markDeviceOwned("udid-2");
    s.markDeviceOwned("udid-1"); // dedup
    expect(s.isDeviceOwned("udid-1")).toBe(true);

    const drained = s.takeOwnedDevices();
    expect(drained.sort()).toEqual(["udid-1", "udid-2"]);
    // Drained: a second take is empty, and ownership is cleared.
    expect(s.takeOwnedDevices()).toEqual([]);
    expect(s.isDeviceOwned("udid-1")).toBe(false);
  });

  it("ignores blank ids and trims", () => {
    const s = new VariantProposalStore();
    s.markDeviceOwned("   ");
    s.markDeviceOwned(" udid-3 ");
    expect(s.isDeviceOwned("udid-3")).toBe(true);
    expect(s.takeOwnedDevices()).toEqual(["udid-3"]);
  });
});

describe("VariantProposalStore — roundCompleted telemetry event", () => {
  it("emits once per round with privacy-safe aggregate stats", async () => {
    const s = new VariantProposalStore();
    const stats: unknown[] = [];
    s.events.on("roundCompleted", (x) => stats.push(x));

    s.proposeVariant({ element: "Foo", variant: variant("Bold") }); // v1
    s.proposeVariant({ element: "Foo", variant: variant("Ghost") }); // v2
    s.proposeVariant({ element: "Bar", variant: variant("Large") }); // v3
    s.proposeVariant({ element: "Baz", variant: variant("Shadow") }); // v4
    const foo = s.snapshot().proposals.find((p) => p.element === "Foo")!;
    const bar = s.snapshot().proposals.find((p) => p.element === "Bar")!;
    const baz = s.snapshot().proposals.find((p) => p.element === "Baz")!;

    const p = s.awaitSelection({ timeoutMs: 5000 }); // park a waiter
    await Promise.resolve();
    s.submitSelection({
      selections: [
        { elementId: foo.id, variantId: foo.variants[1]!.id }, // chosen
        { elementId: bar.id, variantId: null, comment: "tweak this" }, // skipped + comment
        { elementId: baz.id, variantId: null }, // skipped, no comment
      ],
      globalComment: "ship it",
      annotations: [
        { target: "Header", match: { by: "text", value: "Header" }, comment: "move up" },
      ],
    });
    await p;

    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({
      round: 1,
      element_count: 3,
      variant_count: 4,
      annotation_count: 1,
      element_comment_count: 1, // only Bar carried a per-element comment
      skipped_comment_count: 1, // and Bar was skipped, so that comment is a skip comment
      has_global_comment: true,
      is_cli_session: false,
      had_parked_await: true,
    });
    // No device was bound (no udid passed), so platform is omitted.
    expect((stats[0] as { platform?: string }).platform).toBeUndefined();
    const dur = (stats[0] as { round_duration_ms: number }).round_duration_ms;
    expect(typeof dur).toBe("number");
    expect(dur).toBeGreaterThanOrEqual(0);
    // Payload must be counts/booleans only — no element names, comments, ids.
    expect(JSON.stringify(stats[0])).not.toMatch(/ship it|tweak this|move up|Foo|Bar|Baz|Header/);
    // Content-agnostic guard (strictly stronger than the literal blocklist): every
    // value must be a number, a boolean, or (only for `platform`) a known platform
    // enum — any leaked free-text would be a string that is none of those.
    assertPrivacySafe(stats[0]);
  });

  it("captures platform and variant counts from the bound device", () => {
    const s = new VariantProposalStore();
    const stats: unknown[] = [];
    s.events.on("roundCompleted", (x) => stats.push(x));

    // Bind a chromium device via udid; propose one element with two variants.
    s.proposeVariant({ element: "Foo", udid: "chromium-cdp-9222", variant: variant("Bold") });
    s.proposeVariant({ element: "Foo", variant: variant("Ghost") });
    const foo = s.snapshot().proposals[0]!;
    s.submitSelection({ selections: [{ elementId: foo.id, variantId: foo.variants[0]!.id }] });

    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({
      element_count: 1,
      variant_count: 2,
      platform: "chromium",
    });
    assertPrivacySafe(stats[0]);
  });

  it("counts element_comment_count and skipped_comment_count independently (chosen-with-comment vs skipped-with-comment)", () => {
    const s = new VariantProposalStore();
    const stats: Array<{ element_comment_count: number; skipped_comment_count: number }> = [];
    s.events.on("roundCompleted", (x) => stats.push(x));

    s.proposeVariant({ element: "Foo", variant: variant("Bold") });
    s.proposeVariant({ element: "Bar", variant: variant("Large") });
    const foo = s.snapshot().proposals.find((p) => p.element === "Foo")!;
    const bar = s.snapshot().proposals.find((p) => p.element === "Bar")!;

    s.submitSelection({
      selections: [
        { elementId: foo.id, variantId: foo.variants[0]!.id, comment: "keep this" }, // CHOSEN + comment
        { elementId: bar.id, variantId: null, comment: "needs work" }, // SKIPPED + comment
      ],
    });

    expect(stats).toHaveLength(1);
    // Both elements carry a per-element comment (element_comment_count = 2), but
    // only the skipped one is a skip-comment (skipped_comment_count = 1). The two
    // counts MUST differ here — if the two filters (chosen vs skipped) were
    // swapped or aliased, this asymmetric case fails, unlike a 1/1 case where a
    // swap is invisible. So chosen-with-comment = 2 - 1 = 1 is pinned.
    expect(stats[0]!.element_comment_count).toBe(2);
    expect(stats[0]!.skipped_comment_count).toBe(1);
  });

  it("does NOT re-emit on a resubmit of the same round", () => {
    const s = new VariantProposalStore();
    let count = 0;
    s.events.on("roundCompleted", () => count++);
    s.proposeVariant({ element: "Foo", variant: variant("Bold") });
    const foo = s.snapshot().proposals[0]!;

    s.submitSelection({ selections: [{ elementId: foo.id, variantId: foo.variants[0]!.id }] });
    s.submitSelection({ selections: [{ elementId: foo.id, variantId: null }] }); // resubmit
    expect(count).toBe(1);
  });

  it("re-emits for a fresh round after an auto-roll, with had_parked_await=false when queued", () => {
    const s = new VariantProposalStore();
    const rounds: number[] = [];
    s.events.on("roundCompleted", (x) => rounds.push(x.round));

    // Round 1: submit with no await parked -> queued, had_parked_await=false.
    s.proposeVariant({ element: "Foo", variant: variant("A") });
    const foo1 = s.snapshot().proposals[0]!;
    s.submitSelection({ selections: [{ elementId: foo1.id, variantId: foo1.variants[0]!.id }] });

    // Next propose auto-rolls into round 2; submit again.
    s.proposeVariant({ element: "Bar", variant: variant("B") });
    const bar = s.snapshot().proposals[0]!;
    s.submitSelection({ selections: [{ elementId: bar.id, variantId: bar.variants[0]!.id }] });

    expect(rounds).toEqual([1, 2]);
  });

  it("flags is_cli_session and had_parked_await=false on the CLI path", () => {
    const s = new VariantProposalStore();
    const stats: Array<{ is_cli_session: boolean; had_parked_await: boolean }> = [];
    s.events.on("roundCompleted", (x) => stats.push(x));
    s.setCliSession(true, []);
    s.proposeVariant({ element: "Foo", variant: variant("A") });
    const foo = s.snapshot().proposals[0]!;
    s.submitSelection({ selections: [{ elementId: foo.id, variantId: foo.variants[0]!.id }] });

    expect(stats).toHaveLength(1);
    expect(stats[0]!.is_cli_session).toBe(true);
    expect(stats[0]!.had_parked_await).toBe(false);
  });

  it("forwards the UI's inspector_used / offscreen_revealed usage flags", () => {
    const s = new VariantProposalStore();
    const stats: Array<{ inspector_used: boolean; offscreen_revealed: boolean }> = [];
    s.events.on("roundCompleted", (x) => stats.push(x));
    s.proposeVariant({ element: "Foo", variant: variant("A") });
    const foo = s.snapshot().proposals[0]!;
    // Asymmetric on purpose (true/false) so a swap or aliasing of the two flags
    // is caught — a matching pair would hide it.
    s.submitSelection({
      selections: [{ elementId: foo.id, variantId: foo.variants[0]!.id }],
      inspectorUsed: true,
      offscreenRevealed: false,
    });

    expect(stats).toHaveLength(1);
    expect(stats[0]!.inspector_used).toBe(true);
    expect(stats[0]!.offscreen_revealed).toBe(false);
    assertPrivacySafe(stats[0]);
  });

  it("defaults inspector_used / offscreen_revealed to false when the UI omits them", () => {
    const s = new VariantProposalStore();
    const stats: Array<{ inspector_used: boolean; offscreen_revealed: boolean }> = [];
    s.events.on("roundCompleted", (x) => stats.push(x));
    s.proposeVariant({ element: "Foo", variant: variant("A") });
    const foo = s.snapshot().proposals[0]!;
    // An older UI (or a bare submit) sends no usage flags — they must read false,
    // never undefined, so the sanitizer's bool validator keeps them.
    s.submitSelection({ selections: [{ elementId: foo.id, variantId: foo.variants[0]!.id }] });

    expect(stats).toHaveLength(1);
    expect(stats[0]!.inspector_used).toBe(false);
    expect(stats[0]!.offscreen_revealed).toBe(false);
  });
});

describe("VariantProposalStore — cliSessionStarted telemetry event", () => {
  it("emits once on a begin transition with the picker size", () => {
    const s = new VariantProposalStore();
    const stats: unknown[] = [];
    s.events.on("cliSessionStarted", (x) => stats.push(x));

    s.setCliSession(true, [
      { id: "claude", name: "Claude" },
      { id: "cursor", name: "Cursor" },
    ]);

    expect(stats).toHaveLength(1);
    expect(stats[0]).toEqual({ agent_choice_count: 2 });
    // Privacy: only an aggregate count leaves — never the agent ids/names.
    assertPrivacySafe(stats[0]);
    expect(JSON.stringify(stats[0])).not.toMatch(/claude|cursor|Claude|Cursor/);
  });

  it("reports agent_choice_count 0 when no picker is offered", () => {
    const s = new VariantProposalStore();
    const stats: Array<{ agent_choice_count: number }> = [];
    s.events.on("cliSessionStarted", (x) => stats.push(x));
    s.setCliSession(true, []);
    expect(stats).toHaveLength(1);
    expect(stats[0]!.agent_choice_count).toBe(0);
  });

  it("emits once per begin (every invocation) with the current picker, never on session end", () => {
    const s = new VariantProposalStore();
    const stats: Array<{ agent_choice_count: number }> = [];
    s.events.on("cliSessionStarted", (x) => stats.push(x));

    s.setCliSession(true, [{ id: "claude", name: "Claude" }]); // invocation 1 (1 agent)
    s.setCliSession(false, []); // end never counts
    expect(stats).toHaveLength(1);

    s.setCliSession(true, []); // invocation 2 (clean re-begin, no picker)
    // A begin while the store is STILL marked active — a prior session's end
    // never landed (e.g. `argent lens` was killed) — is a real new invocation
    // and MUST count. A transition-only guard would miss it and under-count the
    // very metric this event exists for. Its payload must also reflect THIS
    // begin's picker size, not a stale one.
    s.setCliSession(true, [{ id: "cursor", name: "Cursor" }]); // invocation 3, no transition (1 agent)
    expect(stats.map((x) => x.agent_choice_count)).toEqual([1, 0, 1]);
  });
});

describe("VariantProposalStore — roundAbandoned telemetry event", () => {
  it("emits once with aggregate stats when a staged round is discarded via reset()", () => {
    const s = new VariantProposalStore();
    const stats: unknown[] = [];
    s.events.on("roundAbandoned", (x) => stats.push(x));

    s.proposeVariant({ element: "Foo", udid: "chromium-cdp-9222", variant: variant("Bold") });
    s.proposeVariant({ element: "Foo", variant: variant("Ghost") });
    s.proposeVariant({ element: "Bar", variant: variant("Large") });
    s.reset(); // human closed the window / session ended without submitting

    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({
      round: 1,
      element_count: 2,
      variant_count: 3,
      had_parked_await: false,
      is_cli_session: false,
      platform: "chromium",
    });
    assertPrivacySafe(stats[0]);
  });

  it("does NOT emit for the happy-path roll after a completed round", () => {
    const s = new VariantProposalStore();
    let abandoned = 0;
    let completed = 0;
    s.events.on("roundAbandoned", () => abandoned++);
    s.events.on("roundCompleted", () => completed++);

    s.proposeVariant({ element: "Foo", variant: variant("A") });
    const foo = s.snapshot().proposals[0]!;
    s.submitSelection({ selections: [{ elementId: foo.id, variantId: foo.variants[0]!.id }] });
    // This propose auto-rolls (reset on a COMPLETED round) — not an abandonment.
    s.proposeVariant({ element: "Bar", variant: variant("B") });

    expect(completed).toBe(1);
    expect(abandoned).toBe(0);
  });

  it("does NOT emit when reset() runs on an empty round", () => {
    const s = new VariantProposalStore();
    let abandoned = 0;
    s.events.on("roundAbandoned", () => abandoned++);
    s.reset(); // nothing staged
    expect(abandoned).toBe(0);
  });

  it("flags had_parked_await=true when a parked await is superseded by reset()", async () => {
    const s = new VariantProposalStore();
    const stats: Array<{ had_parked_await: boolean }> = [];
    s.events.on("roundAbandoned", (x) => stats.push(x));

    s.proposeVariant({ element: "Foo", variant: variant("A") });
    const parked = s.awaitSelection({ timeoutMs: 5000 });
    await Promise.resolve();
    s.reset(); // supersede the round out from under the parked await

    const outcome = await parked; // the await must settle, not hang
    expect(outcome.status).toBe("no_proposals");
    expect(stats).toHaveLength(1);
    expect(stats[0]!.had_parked_await).toBe(true);
  });

  it("emits exactly once per abandoned round (a second reset can't double count)", () => {
    const s = new VariantProposalStore();
    let abandoned = 0;
    s.events.on("roundAbandoned", () => abandoned++);
    s.proposeVariant({ element: "Foo", variant: variant("A") });
    s.reset();
    s.reset(); // round now empty — no second emit
    expect(abandoned).toBe(1);
  });
});
