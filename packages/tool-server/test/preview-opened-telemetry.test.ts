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

describe("POST /preview/opened — lens:preview_opened telemetry", () => {
  // `lens:preview_opened` is emitted only from an explicit client trigger — the
  // UI posts `/opened` when it renders a round in a VISIBLE window. The server
  // reads counts/platform from its own snapshot (the body's `round` is a trigger
  // only), and dedups per round. These cases pin the server side of that signal;
  // the visibility gate itself is client-side (see index.html reportPreviewOpened).

  it("emits once when the client reports a live proposal round", async () => {
    const a = app();
    variantProposalStore.proposeVariant({
      element: "Foo",
      variant: { name: "Bold", summary: "s" },
    });
    const round = variantProposalStore.snapshot().round;

    const res = await request(a).post("/opened").send({ round });

    expect(res.status).toBe(200);
    const calls = previewOpenedCalls();
    expect(calls).toHaveLength(1);
    const payload = calls[0]![1] as Record<string, unknown>;
    // No udid bound here, but the store `device` is a process singleton NOT cleared
    // by reset(), so `platform` can carry over from an earlier test under
    // --sequence.shuffle. Assert the controlled fields, pin the exact key set, and
    // check platform is a safe enum or undefined — never leaked content.
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

    await request(a).post("/opened").send({ round });

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

  it("dedups within the same round (repeated triggers count once)", async () => {
    const a = app();
    variantProposalStore.proposeVariant({
      element: "Foo",
      variant: { name: "Bold", summary: "s" },
    });
    const round = variantProposalStore.snapshot().round;

    await request(a).post("/opened").send({ round });
    await request(a).post("/opened").send({ round }); // e.g. a second tab, same round

    expect(previewOpenedCalls()).toHaveLength(1);
  });

  it("re-emits on a NEW round (dedup is per-round, not once-ever)", async () => {
    const a = app();
    variantProposalStore.proposeVariant({
      element: "Foo",
      variant: { name: "Bold", summary: "s" },
    });
    const roundN = variantProposalStore.snapshot().round;
    await request(a).post("/opened").send({ round: roundN });
    expect(previewOpenedCalls()).toHaveLength(1);

    // Finalize round N; the next propose auto-rolls into a fresh round N+1.
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

    // The client rendering the NEW round reports it — a second event. A regression
    // to a fire-once guard would wrongly suppress this and leave the count at 1.
    await request(a).post("/opened").send({ round: roundNext });
    const calls = previewOpenedCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1]![1]).toMatchObject({
      round: roundNext,
      element_count: 1,
      variant_count: 1,
      is_cli_session: false,
    });
  });

  it("does NOT emit when nothing is staged and no CLI session (a stray trigger)", async () => {
    const a = app();
    const res = await request(a).post("/opened").send({ round: 1 });

    expect(res.status).toBe(200);
    expect(previewOpenedCalls()).toHaveLength(0);
  });

  it("emits for a CLI up-front open with zero proposals, OMITTING the (stale) platform", async () => {
    const a = app();
    // Bind a device via an earlier round, then roll it away: `device` survives
    // reset() on the store singleton, so it is still set with zero proposals.
    variantProposalStore.proposeVariant({
      element: "Foo",
      udid: "chromium-cdp-9222",
      variant: { name: "Bold", summary: "s" },
    });
    variantProposalStore.reset();
    // An `argent lens` session opens the window up front — zero proposals staged.
    variantProposalStore.setCliSession(true, []);
    const round = variantProposalStore.snapshot().round;
    expect(variantProposalStore.snapshot().device).toBe("chromium-cdp-9222"); // still bound

    await request(a).post("/opened").send({ round });

    const calls = previewOpenedCalls();
    expect(calls).toHaveLength(1);
    // element_count 0 (CLI up-front) AND platform OMITTED: a zero-count open must
    // not inherit a prior flow's device platform (the store's `device` survives
    // reset()). This pins the "platform tied to proposals presence" fix.
    expect(calls[0]![1]).toEqual({
      round,
      element_count: 0,
      variant_count: 0,
      is_cli_session: true,
    });

    variantProposalStore.setCliSession(false, []); // don't leak session state
  });
});

describe("GET /preview/ and /preview/variants — no longer emit preview_opened", () => {
  // The page load and the poll are NOT proof a human is looking (a reused CLI
  // window loads `/` once for a whole session; a browser tab keeps polling
  // /variants while backgrounded). Emission moved to the visibility-gated client
  // trigger, so these surfaces must stay silent — a regression guard.

  it("GET / does not emit even with a live round", async () => {
    const a = app();
    variantProposalStore.proposeVariant({
      element: "Foo",
      variant: { name: "Bold", summary: "s" },
    });
    const res = await request(a).get("/");
    expect(res.status).toBe(200);
    expect(previewOpenedCalls()).toHaveLength(0);
  });

  it("GET /variants does not emit even with a live round", async () => {
    const a = app();
    variantProposalStore.proposeVariant({
      element: "Foo",
      variant: { name: "Bold", summary: "s" },
    });
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

  it("forwards the round token so a stale cross-round submit is rejected (no phantom completion)", async () => {
    const a = app();
    // Round N: propose + submit (matching token) → completes round N. (The store
    // is a process singleton; round numbers accumulate across tests, so capture
    // them dynamically rather than assuming 1/2.)
    variantProposalStore.proposeVariant({ element: "Foo", variant: { name: "A", summary: "s" } });
    const foo = variantProposalStore.snapshot().proposals[0]!;
    const roundN = variantProposalStore.snapshot().round;
    await request(a)
      .post("/variants/selection")
      .send({ round: roundN, selections: [{ elementId: foo.id, variantId: foo.variants[0]!.id }] });

    // Agent proposes again → auto-roll to round N+1.
    variantProposalStore.proposeVariant({ element: "Bar", variant: { name: "B", summary: "s" } });
    expect(variantProposalStore.snapshot().round).toBe(roundN + 1);

    const completed: number[] = [];
    const onCompleted = (x: { round: number }) => completed.push(x.round);
    variantProposalStore.events.on("roundCompleted", onCompleted);

    // A stale click from the round-N tab: round token N, current round is N+1. The
    // route must forward the token so the store rejects it (regression guard —
    // the route previously dropped `round`, letting the phantom through).
    const res = await request(a)
      .post("/variants/selection")
      .send({ round: roundN, selections: [{ elementId: foo.id, variantId: foo.variants[0]!.id }] });

    variantProposalStore.events.off("roundCompleted", onCompleted);
    expect(res.status).toBe(200);
    expect(res.body.stale).toBe(true);
    expect(res.body.resolved).toBe(0);
    expect(completed).toEqual([]); // no phantom lens:round_completed for round 2
    expect(variantProposalStore.snapshot().completed).toBe(false);
  });
});
