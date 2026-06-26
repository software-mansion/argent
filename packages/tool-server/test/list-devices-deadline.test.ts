import { describe, it, expect, vi, afterEach } from "vitest";
import { withDeadline, BRANCH_DEADLINE_MS } from "../src/tools/devices/list-devices";
import {
  VEGA_DISCOVERY_LIST_TIMEOUT_MS,
  VEGA_DISCOVERY_INFO_TIMEOUT_MS,
} from "../src/utils/vega-devices";

// Guards the timeout/backstop ordering: the backstop must sit ABOVE the slowest
// branch's own worst case, or it stops being a last-resort and starts truncating a
// branch that would have completed — dropping a real device from the list. The long
// pole is Vega's slow recovery path: a fast (non-timeout) `device list` failure
// followed by the `device info` recovery runs both discovery timeouts back-to-back.
// If a future edit bumps either Vega timeout past the backstop, this fails loudly.
describe("discovery timeout vs backstop invariant", () => {
  it("the Vega branch worst case stays comfortably under the branch deadline", () => {
    const vegaWorstCase = VEGA_DISCOVERY_LIST_TIMEOUT_MS + VEGA_DISCOVERY_INFO_TIMEOUT_MS;
    expect(vegaWorstCase).toBeLessThan(BRANCH_DEADLINE_MS);
    // Keep a real margin (not just "<"), so a slightly-slow-but-completing branch on a
    // loaded machine isn't cut off at the deadline.
    expect(BRANCH_DEADLINE_MS - vegaWorstCase).toBeGreaterThanOrEqual(3_000);
  });
});

// Unit cover for the hard backstop that keeps a single wedged discovery branch from
// stalling the `alwaysLoad` list-devices tool. The per-call subprocess timeouts are
// the first line of defence; this asserts the defence-in-depth race itself returns a
// partial result (the fallback) instead of hanging, and stays out of the way on the
// happy path.
describe("withDeadline backstop", () => {
  afterEach(() => vi.useRealTimers());

  it("returns the branch's value untouched when it resolves before the deadline", async () => {
    await expect(withDeadline(Promise.resolve(["a", "b"]), [], "vega")).resolves.toEqual([
      "a",
      "b",
    ]);
  });

  it("returns the fallback (and logs) when the branch exceeds the deadline", async () => {
    vi.useFakeTimers();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const never = new Promise<string[]>(() => {}); // a wedged branch that never settles
    const result = withDeadline(never, ["fallback"], "android");
    await vi.advanceTimersByTimeAsync(BRANCH_DEADLINE_MS);
    await expect(result).resolves.toEqual(["fallback"]);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("android discovery exceeded"));
    stderr.mockRestore();
  });
});
