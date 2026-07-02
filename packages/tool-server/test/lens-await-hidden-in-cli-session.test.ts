/**
 * `await_user_selection` is the single blocking call for the MCP-driven Lens
 * flow. In an `argent lens` CLI session the user's picks are relayed into the
 * agent's terminal as a message instead, so the agent must never block on it —
 * and rather than telling the agent "don't call it", we hide the tool outright
 * via its `hideWhen` predicate. This pins that wiring: the predicate tracks the
 * store's CLI-session flag, and `propose_variant` (always present) is never
 * hidden.
 */
import { describe, it, expect, afterEach } from "vitest";
import { awaitUserSelectionTool } from "../src/tools/variants/await-user-selection";
import { variantProposalStore } from "../src/utils/variant-proposals";

afterEach(() => variantProposalStore.setCliSession(false));

describe("await_user_selection hideWhen — CLI Lens session", () => {
  it("is exposed when no CLI session owns the window", () => {
    variantProposalStore.setCliSession(false);
    expect(awaitUserSelectionTool.hideWhen?.()).toBe(false);
  });

  it("is hidden while a CLI Lens session is active", () => {
    variantProposalStore.setCliSession(true);
    expect(awaitUserSelectionTool.hideWhen?.()).toBe(true);
  });

  it("re-exposes once the CLI session ends", () => {
    variantProposalStore.setCliSession(true);
    variantProposalStore.setCliSession(false);
    expect(awaitUserSelectionTool.hideWhen?.()).toBe(false);
  });
});
