import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { Registry } from "@argent/registry";

// Capture telemetry without touching PostHog: keep every real export (other
// modules in the router's import graph read them at load) and spy only `track`.
vi.mock("@argent/telemetry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@argent/telemetry")>();
  return { ...actual, track: vi.fn() };
});

import { createPreviewRouter } from "../src/preview";
import { variantProposalStore } from "../src/utils/variant-proposals";
import { track } from "@argent/telemetry";

const mockTrack = vi.mocked(track);

function app() {
  const registry = { invokeTool: vi.fn() } as unknown as Registry;
  const a = express();
  // Mirror the real server (http.ts mounts express.json app-wide before the
  // preview router) so POST bodies to /variants/selection are parsed. Harmless
  // for the GET cases (no body).
  a.use(express.json());
  a.use(createPreviewRouter(registry));
  return a;
}

const previewOpenedCalls = () =>
  mockTrack.mock.calls.filter(([event]) => event === "lens:preview_opened");

beforeEach(() => {
  mockTrack.mockClear();
  // The store is a process singleton; clear any round state a prior test left so
  // each case starts from an empty, uncompleted round. `reset()` deliberately
  // does NOT clear `cliSession`, so drop a leaked CLI session too — otherwise a
  // prior CLI test could make a "bare load, no CLI" case emit via the cliSession
  // disjunct under --sequence.shuffle. Neither call routes through `track`, so
  // the mockClear above stays effective.
  variantProposalStore.setCliSession(false, []);
  variantProposalStore.reset();
});

describe("GET /preview/ — lens:preview_opened telemetry", () => {
  it("emits once when a human loads the preview during a live proposal round", async () => {
    const a = app();
    variantProposalStore.proposeVariant({
      element: "Foo",
      variant: { name: "Bold", summary: "s" },
    });
    const round = variantProposalStore.snapshot().round;

    const res = await request(a).get("/");

    expect(res.status).toBe(200);
    const calls = previewOpenedCalls();
    expect(calls).toHaveLength(1);
    const payload = calls[0]![1] as Record<string, unknown>;
    // This test binds no udid, but the store `device` is a process singleton NOT
    // cleared by reset() (see variant-proposals.ts), so `platform` can carry over
    // from an earlier test (e.g. under --sequence.shuffle). Assert only the fields
    // this test controls, and separately pin the exact key set so an unexpected
    // field still can't leak in — rather than a `platform: undefined` toEqual that
    // is order-fragile. (A fresh-store test pins platform=undefined directly.)
    expect(payload).toMatchObject({
      round,
      element_count: 1,
      variant_count: 1,
      is_cli_session: false,
    });
    expect(Object.keys(payload).sort()).toEqual([
      "element_count",
      "is_cli_session",
      "platform",
      "round",
      "variant_count",
    ]);
    // Any carried-over platform must still be a known-safe enum, never content.
    expect(payload.platform === undefined || typeof payload.platform === "string").toBe(true);
  });

  it("reports variant_count and platform from the bound device", async () => {
    const a = app();
    variantProposalStore.proposeVariant({
      element: "Foo",
      udid: "chromium-cdp-9222",
      variant: { name: "Bold", summary: "s" },
    });
    variantProposalStore.proposeVariant({
      element: "Foo",
      variant: { name: "Ghost", summary: "s" },
    });
    const round = variantProposalStore.snapshot().round;

    await request(a).get("/");

    const calls = previewOpenedCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toEqual({
      round,
      element_count: 1,
      variant_count: 2,
      is_cli_session: false,
      platform: "chromium",
    });
  });

  it("dedups within the same round (a refresh counts once)", async () => {
    const a = app();
    variantProposalStore.proposeVariant({
      element: "Foo",
      variant: { name: "Bold", summary: "s" },
    });

    await request(a).get("/");
    await request(a).get("/"); // refresh, same round

    expect(previewOpenedCalls()).toHaveLength(1);
  });

  it("re-emits on the FIRST load of a NEW round (dedup is per-round, not once-ever)", async () => {
    const a = app();
    // Round N: stage a proposal and open the preview — first emit.
    variantProposalStore.proposeVariant({
      element: "Foo",
      variant: { name: "Bold", summary: "s" },
    });
    const roundN = variantProposalStore.snapshot().round;
    await request(a).get("/");
    expect(previewOpenedCalls()).toHaveLength(1);

    // Finalize round N, then propose again — proposeVariant auto-rolls into a
    // fresh round N+1 once the prior round is completed.
    const foo = variantProposalStore.snapshot().proposals[0]!;
    variantProposalStore.submitSelection({
      selections: [{ elementId: foo.id, variantId: foo.variants[0]!.id }],
    });
    variantProposalStore.proposeVariant({
      element: "Bar",
      variant: { name: "Ghost", summary: "s" },
    });
    const roundNext = variantProposalStore.snapshot().round;
    expect(roundNext).toBe(roundN + 1);

    // The first load of the NEW round MUST emit again. A regression to a
    // fire-once boolean (instead of the `round !== lastOpenedRound` guard) would
    // wrongly suppress this and leave the count at 1.
    await request(a).get("/");
    const calls = previewOpenedCalls();
    expect(calls).toHaveLength(2);
    // platform is intentionally not asserted: the store `device` is a process
    // singleton not cleared by reset(), so it can carry over from a prior test.
    expect(calls[1]![1]).toMatchObject({
      round: roundNext,
      element_count: 1,
      variant_count: 1,
      is_cli_session: false,
    });
  });

  it("does NOT emit for a bare load with nothing staged and no CLI session", async () => {
    const a = app();
    // Fresh router + no proposals staged this round: a stray preview load isn't
    // a real "opened" signal, so it must not be counted.
    const res = await request(a).get("/");

    expect(res.status).toBe(200);
    expect(previewOpenedCalls()).toHaveLength(0);
  });

  it("emits for a CLI up-front open with zero proposals staged", async () => {
    const a = app();
    // An `argent lens` CLI session opens the window before any variant is staged,
    // so the `cliSession` disjunct — not proposals — is what makes the load count.
    variantProposalStore.setCliSession(true, []);
    const round = variantProposalStore.snapshot().round;

    await request(a).get("/");

    const calls = previewOpenedCalls();
    expect(calls).toHaveLength(1);
    // `cliSession` is the deciding disjunct here (zero proposals staged). Assert
    // the CLI-relevant fields via toMatchObject rather than toEqual: `device`
    // persists across reset() on the process singleton, so `platform` depends on
    // whatever a prior test bound and isn't this test's subject.
    expect(calls[0]![1]).toMatchObject({
      round,
      element_count: 0,
      variant_count: 0,
      is_cli_session: true,
    });

    variantProposalStore.setCliSession(false, []); // don't leak session state to later tests
  });
});

describe("GET /preview/variants — per-round lens:preview_opened in a reused window", () => {
  // In an `argent lens` CLI session the preview window is opened ONCE up front and
  // reused: the UI swaps rounds client-side off the /variants poll (~1.2s) without
  // ever re-loading `/`, and `await_user_selection` is hidden so the window is
  // never re-foregrounded. `GET /` therefore fires exactly once for the whole
  // session, so the open leg is counted off the poll instead. These cases pin that
  // per-round emission and its cross-surface dedup with `GET /`.

  it("emits for each new round observed via the poll (the reused-window CLI path)", async () => {
    const a = app();
    // CLI session begins → window opens up front; `GET /` counts round 1's open.
    variantProposalStore.setCliSession(true, []);
    const round1 = variantProposalStore.snapshot().round;
    await request(a).get("/");
    expect(previewOpenedCalls()).toHaveLength(1);
    expect(previewOpenedCalls()[0]![1]).toMatchObject({ round: round1, is_cli_session: true });

    // The reused window keeps polling /variants for round 1 — same round, no
    // re-emit (the `GET /` above already claimed it via `lastOpenedRound`).
    await request(a).get("/variants");
    await request(a).get("/variants");
    expect(previewOpenedCalls()).toHaveLength(1);

    // Human submits round 1, then the agent proposes round 2. In a CLI session the
    // window is NOT re-loaded, so `/` never fires again — only the poll observes
    // round 2. Without the /variants emission this round's open would be lost and
    // the funnel would show more decisions than opens.
    variantProposalStore.proposeVariant({
      element: "Foo",
      variant: { name: "Bold", summary: "s" },
    });
    const foo = variantProposalStore.snapshot().proposals[0]!;
    variantProposalStore.submitSelection({
      selections: [{ elementId: foo.id, variantId: foo.variants[0]!.id }],
    });
    variantProposalStore.proposeVariant({
      element: "Bar",
      variant: { name: "Ghost", summary: "s" },
    });
    const round2 = variantProposalStore.snapshot().round;
    expect(round2).toBe(round1 + 1);

    await request(a).get("/variants");
    const calls = previewOpenedCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1]![1]).toMatchObject({
      round: round2,
      element_count: 1,
      variant_count: 1,
      is_cli_session: true,
    });

    variantProposalStore.setCliSession(false, []); // don't leak session state to later tests
  });

  it("counts the open from the poll alone when the page load didn't fire it", async () => {
    const a = app();
    // Proposals are live but the human's open reaches the router only as a
    // /variants poll (e.g. the reused window was already loaded before this round).
    variantProposalStore.proposeVariant({
      element: "Foo",
      variant: { name: "Bold", summary: "s" },
    });
    const round = variantProposalStore.snapshot().round;

    await request(a).get("/variants");

    const calls = previewOpenedCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toMatchObject({
      round,
      element_count: 1,
      variant_count: 1,
      is_cli_session: false,
    });
  });

  it("dedups across surfaces — a `GET /` then repeated /variants polls count once", async () => {
    const a = app();
    variantProposalStore.proposeVariant({
      element: "Foo",
      variant: { name: "Bold", summary: "s" },
    });

    await request(a).get("/"); // page load claims the round
    await request(a).get("/variants");
    await request(a).get("/variants");

    // The MCP path both loads `/` and polls /variants for the same round; the
    // shared `lastOpenedRound` guard must keep that to a single event.
    expect(previewOpenedCalls()).toHaveLength(1);
  });

  it("does NOT emit for a poll with nothing staged and no CLI session", async () => {
    const a = app();
    // A stray poll of an empty preview (no proposals, no CLI session) is not a
    // real "opened" signal, exactly as for a bare `GET /`.
    const res = await request(a).get("/variants");

    expect(res.status).toBe(200);
    expect(previewOpenedCalls()).toHaveLength(0);
  });
});

describe("POST /preview/variants/selection — inspector/offscreen usage flags", () => {
  it("threads the UI's inspectorUsed / offscreenRevealed booleans to lens:round_completed", async () => {
    const a = app();
    variantProposalStore.proposeVariant({
      element: "Foo",
      variant: { name: "Bold", summary: "s" },
    });
    const foo = variantProposalStore.snapshot().proposals[0]!;
    // roundCompleted is the store event index.ts relays to lens:round_completed;
    // capture it to prove the POST body's flags reach the aggregate (not `track`,
    // which the router only calls for lens:preview_opened).
    const stats: Array<{ inspector_used: boolean; offscreen_revealed: boolean }> = [];
    const onCompleted = (x: { inspector_used: boolean; offscreen_revealed: boolean }) =>
      stats.push(x);
    variantProposalStore.events.on("roundCompleted", onCompleted);

    const res = await request(a)
      .post("/variants/selection")
      .send({
        selections: [{ elementId: foo.id, variantId: foo.variants[0]!.id }],
        inspectorUsed: true,
        offscreenRevealed: true,
      });

    variantProposalStore.events.off("roundCompleted", onCompleted);
    expect(res.status).toBe(200);
    expect(stats).toHaveLength(1);
    expect(stats[0]!.inspector_used).toBe(true);
    expect(stats[0]!.offscreen_revealed).toBe(true);
  });

  it("coerces a missing/non-boolean flag to false (unauthenticated route)", async () => {
    const a = app();
    variantProposalStore.proposeVariant({
      element: "Foo",
      variant: { name: "Bold", summary: "s" },
    });
    const foo = variantProposalStore.snapshot().proposals[0]!;
    const stats: Array<{ inspector_used: boolean; offscreen_revealed: boolean }> = [];
    const onCompleted = (x: { inspector_used: boolean; offscreen_revealed: boolean }) =>
      stats.push(x);
    variantProposalStore.events.on("roundCompleted", onCompleted);

    // inspectorUsed sent as a non-boolean, offscreenRevealed omitted entirely.
    const res = await request(a)
      .post("/variants/selection")
      .send({
        selections: [{ elementId: foo.id, variantId: foo.variants[0]!.id }],
        inspectorUsed: "yes",
      });

    variantProposalStore.events.off("roundCompleted", onCompleted);
    expect(res.status).toBe(200);
    expect(stats).toHaveLength(1);
    expect(stats[0]!.inspector_used).toBe(false);
    expect(stats[0]!.offscreen_revealed).toBe(false);
  });
});
