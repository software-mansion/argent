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
  a.use(createPreviewRouter(registry));
  return a;
}

const previewOpenedCalls = () =>
  mockTrack.mock.calls.filter(([event]) => event === "lens:preview_opened");

beforeEach(() => {
  mockTrack.mockClear();
  // The store is a process singleton; clear any round state a prior test left so
  // each case starts from an empty, uncompleted round.
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
