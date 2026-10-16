import { describe, it, expect, vi, beforeEach } from "vitest";
import { FAILURE_CODES, FailureError, getFailureSignal } from "@argent/registry";

// describeVega fetches the page source from the on-device toolkit; mock that so
// we can drive its failure handling deterministically.
const fetchVegaPageSource = vi.fn();
vi.mock("../src/utils/vega-inspect", () => ({
  fetchVegaPageSource: (...a: unknown[]) => fetchVegaPageSource(...a),
}));

import { describeVega } from "../src/tools/describe/platforms/vega";
import { MultipleVegaDevicesError } from "../src/utils/vega-vvd";

beforeEach(() => {
  fetchVegaPageSource.mockReset();
});

describe("describeVega failure handling", () => {
  it("rethrows the multi-VVD ambiguity error instead of burying it in the relaunch hint", async () => {
    fetchVegaPageSource.mockRejectedValue(new MultipleVegaDevicesError([5554, 5556]));
    await expect(describeVega("amazon-abc")).rejects.toBeInstanceOf(MultipleVegaDevicesError);
  });

  it.each([FAILURE_CODES.VEGA_DEVICE_NOT_FOUND, FAILURE_CODES.VEGA_DEVICE_NOT_REGISTERED])(
    "rethrows %s instead of burying it in the relaunch hint",
    async (error_code) => {
      fetchVegaPageSource.mockRejectedValue(
        new FailureError("vvd", {
          error_code,
          failure_stage: "vega_discover_console_port",
          failure_area: "tool_server",
          error_kind: "not_found",
        })
      );
      const err = await describeVega("amazon-abc").catch((e: unknown) => e);
      expect(getFailureSignal(err)?.error_code).toBe(error_code);
    }
  );

  it("returns an empty tree + relaunch hint when the toolkit is unreachable", async () => {
    fetchVegaPageSource.mockRejectedValue(new Error("ECONNREFUSED"));
    const out = await describeVega("amazon-abc");
    expect(out.source).toBe("vega-automation");
    expect(out.tree.children).toEqual([]);
    expect(out.hint).toMatch(/relaunch the foreground app/i);
  });
});
