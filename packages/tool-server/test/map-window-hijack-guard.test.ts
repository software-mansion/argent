/**
 * Regression: a beginning `map-app` crawl must NEVER reload, repoint, or steal
 * a preview window that is already in use for Lens. `onMapSessionChanged`
 * (a private closure in `start()`) gates its `ensureOpen(mapPreviewUrl())` on
 * `shouldOpenMapWindowForCrawl(variantProposalStore.snapshot())` — this pins
 * that decision.
 *
 * A window is "in use for Lens" when EITHER:
 *   - a CLI Lens session owns it (`cliSession`, from `argent lens`), or
 *   - a non-CLI `await_user_selection` is parked, awaiting the human's submit
 *     (`agentWaiting`).
 * In both, the human is mid-decision with staged variant picks and typed
 * comments that live only in the page (never persisted), so redirecting the
 * window to the Map URL — a different URL, which the Electron main answers with
 * a full `loadURL` — would silently destroy that work. Only when no Lens window
 * is in use may a crawl open one on the Map tab.
 *
 * The unit table pins the predicate; the integration cases drive the REAL
 * `variantProposalStore` through its own CLI-session and await-park transitions
 * to prove the guard reads the store fields that those transitions actually
 * move (a wrong field, or a store that stopped setting `agentWaiting` on park,
 * would slip past a hand-built snapshot but not this).
 */
import { describe, it, expect, afterEach } from "vitest";
import { shouldOpenMapWindowForCrawl } from "../src/index";
import { variantProposalStore } from "../src/utils/variant-proposals";

afterEach(() => {
  // Settle any parked waiter and clear CLI/round state between cases.
  variantProposalStore.reset();
  variantProposalStore.setCliSession(false);
});

describe("shouldOpenMapWindowForCrawl — predicate table", () => {
  it("opens a window when nothing Lens-related is in use", () => {
    expect(shouldOpenMapWindowForCrawl({ cliSession: false, agentWaiting: false })).toBe(true);
  });

  it("leaves the window alone during a CLI Lens session", () => {
    expect(shouldOpenMapWindowForCrawl({ cliSession: true, agentWaiting: false })).toBe(false);
  });

  it("leaves the window alone while a variant await is parked", () => {
    expect(shouldOpenMapWindowForCrawl({ cliSession: false, agentWaiting: true })).toBe(false);
  });

  it("leaves the window alone when both hold at once", () => {
    expect(shouldOpenMapWindowForCrawl({ cliSession: true, agentWaiting: true })).toBe(false);
  });
});

describe("map-window hijack guard — against the real variant store", () => {
  it("a fresh store yields OPEN (no window in use)", () => {
    expect(shouldOpenMapWindowForCrawl(variantProposalStore.snapshot())).toBe(true);
  });

  it("a running `argent lens` session blocks the open, and ending it restores it", () => {
    variantProposalStore.setCliSession(true);
    expect(variantProposalStore.snapshot().cliSession).toBe(true);
    expect(shouldOpenMapWindowForCrawl(variantProposalStore.snapshot())).toBe(false);

    variantProposalStore.setCliSession(false);
    expect(shouldOpenMapWindowForCrawl(variantProposalStore.snapshot())).toBe(true);
  });

  it("a parked await_user_selection blocks the open, and settling it restores it", async () => {
    // Stage a proposal so the await has something to park on.
    variantProposalStore.proposeVariant({
      element: "Sign in button",
      variant: { name: "Bolder", summary: "Higher-contrast fill" },
    });

    // Park the await. The waiter is pushed synchronously in the promise
    // executor, so `agentWaiting` is true immediately after this call.
    const controller = new AbortController();
    const parked = variantProposalStore
      .awaitSelection({ signal: controller.signal, timeoutMs: 60_000 })
      .catch(() => {
        /* aborted below — the rejection is expected */
      });

    expect(variantProposalStore.snapshot().agentWaiting).toBe(true);
    expect(shouldOpenMapWindowForCrawl(variantProposalStore.snapshot())).toBe(false);

    // The human disconnecting (or submitting) settles the waiter — the window
    // is no longer mid-decision, so a later crawl may open one.
    controller.abort();
    await parked;

    expect(variantProposalStore.snapshot().agentWaiting).toBe(false);
    expect(shouldOpenMapWindowForCrawl(variantProposalStore.snapshot())).toBe(true);
  });
});
