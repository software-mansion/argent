import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Drive runRelaySession by feeding a scripted SSE event list through a mocked
// lensEvents generator, and stub the one-shot /outcome baseline fetch. The
// inject/registerDeath seams are supplied by the caller, so we can assert
// exactly what gets relayed to the agent terminal.
const scripted: { events: Array<{ event: string; data: string }> } = { events: [] };
vi.mock("../src/lens-stream.js", () => ({
  lensEvents: async function* () {
    for (const ev of scripted.events) yield ev;
  },
}));

import { runRelaySession } from "../src/lens.js";

function stubBaselineOutcome(outcome: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ outcome }) }))
  );
}

function outcomeEvent(completedAt: number): { event: string; data: string } {
  return {
    event: "outcome",
    data: JSON.stringify({
      status: "completed",
      round: completedAt,
      selections: [],
      unselected: [],
      annotations: [],
      completedAt,
    }),
  };
}

const SESSION_END = { event: "session-end", data: "{}" };

beforeEach(() => {
  scripted.events = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runRelaySession", () => {
  it("relays each new outcome once, dedups by completedAt, and stops on session-end", async () => {
    stubBaselineOutcome(null); // no prior round at startup → baseline completedAt = 0
    scripted.events = [
      outcomeEvent(100),
      outcomeEvent(100), // same completedAt → must NOT relay again
      outcomeEvent(200), // newer → relays
      SESSION_END,
    ];
    const injected: string[] = [];
    await runRelaySession(
      "http://x",
      (t) => (injected.push(t), true),
      () => {},
      true
    );

    expect(injected).toHaveLength(2);
    expect(injected[0]).toContain("round 100");
    expect(injected[1]).toContain("round 200");
  });

  it("never relays an outcome at or before the startup baseline (no stale replay on launch)", async () => {
    stubBaselineOutcome({ status: "completed", completedAt: 500 }); // a round already submitted before we started
    scripted.events = [
      outcomeEvent(500), // equal to baseline → skip (this is the replay-on-connect frame)
      outcomeEvent(400), // older → skip
      SESSION_END,
    ];
    const injected: string[] = [];
    await runRelaySession(
      "http://x",
      (t) => (injected.push(t), true),
      () => {},
      true
    );

    expect(injected).toEqual([]);
  });

  it("stops relaying once the agent has exited (registerDeath)", async () => {
    stubBaselineOutcome(null);
    // Death fires during the startup baseline fetch (registerDeath is invoked
    // synchronously before the first await), so the scripted outcome is never
    // relayed and the loop exits without reconnecting.
    scripted.events = [outcomeEvent(100), SESSION_END];
    const injected: string[] = [];
    let die = () => {};
    const p = runRelaySession(
      "http://x",
      (t) => (injected.push(t), true),
      (onDeath) => {
        die = onDeath;
      },
      true
    );
    die();
    await p;

    expect(injected).toEqual([]);
  });
});
