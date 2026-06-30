import { describe, it, expect, vi, afterEach } from "vitest";
import { withDeadline, BRANCH_DEADLINE_MS } from "../src/tools/devices/list-devices";
import {
  VEGA_DISCOVERY_LIST_TIMEOUT_MS,
  VEGA_DISCOVERY_INFO_TIMEOUT_MS,
} from "../src/utils/vega-devices";
import { VVD_PS_PROBE_TIMEOUT_MS } from "../src/utils/vega-process";
import { ADB_DEVICES_TIMEOUT_MS, ENRICH_TIMEOUT_MS } from "../src/utils/adb";

// Guards the timeout/backstop ordering: the backstop must sit ABOVE every branch's
// FULL per-call worst case, or it stops being a last-resort and starts truncating a
// branch that would have completed — dropping a real device from the list. Each
// branch worst case is summed from the SAME exported timeout constants the code
// uses, so a future edit that bumps any of them past the backstop fails here loudly.
//
// The earlier version of this test counted only the two Vega *device* timeouts
// (list + info) and silently omitted the two serial `ps` probes the recovery path
// also runs — which made the asserted margin fictional. These sums now include them.
const MIN_MARGIN_MS = 3_000;

describe("discovery timeout vs backstop invariant", () => {
  it("the Vega branch's full worst case stays comfortably under the branch deadline", () => {
    // The recovery path runs, serially: the `device list` timeout, the recovery-gate
    // `ps` probe, the `-d emulator-<port>` selector `ps` probe (inside runVegaDevice),
    // and the `device info` timeout. (A *timed-out* list skips recovery, so this is the
    // non-timeout-failure / empty-list ceiling — the true long pole.)
    const vegaWorstCase =
      VEGA_DISCOVERY_LIST_TIMEOUT_MS + 2 * VVD_PS_PROBE_TIMEOUT_MS + VEGA_DISCOVERY_INFO_TIMEOUT_MS;
    expect(vegaWorstCase).toBeLessThan(BRANCH_DEADLINE_MS);
    // A real margin (not just "<"), so a slightly-slow-but-completing branch on a
    // loaded machine isn't cut off at the deadline.
    expect(BRANCH_DEADLINE_MS - vegaWorstCase).toBeGreaterThanOrEqual(MIN_MARGIN_MS);
  });

  it("the Android branch's full worst case stays comfortably under the branch deadline", () => {
    // One bounded `adb devices` call, then concurrent getprop enrichment (all devices
    // and all per-device props run in parallel, so it caps at one ENRICH_TIMEOUT_MS).
    const androidWorstCase = ADB_DEVICES_TIMEOUT_MS + ENRICH_TIMEOUT_MS;
    expect(androidWorstCase).toBeLessThan(BRANCH_DEADLINE_MS);
    expect(BRANCH_DEADLINE_MS - androidWorstCase).toBeGreaterThanOrEqual(MIN_MARGIN_MS);
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
