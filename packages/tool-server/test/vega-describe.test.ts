import { describe, it, expect, vi, beforeEach } from "vitest";
import { FAILURE_CODES, FailureError } from "@argent/registry";

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
    "rethrows the VVD discovery failure %s instead of the relaunch hint",
    async (code) => {
      const discovery = new FailureError("VVD discovery failed.", {
        error_code: code,
        failure_stage: "vega_discover_console_port",
        failure_area: "tool_server",
        error_kind: "not_found",
      });
      fetchVegaPageSource.mockRejectedValue(discovery);
      await expect(describeVega("amazon-abc")).rejects.toBe(discovery);
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
