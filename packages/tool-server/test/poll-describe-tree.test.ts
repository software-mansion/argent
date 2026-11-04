import { describe, expect, it, vi } from "vitest";
import { pollDescribeTree } from "../src/utils/poll-describe-tree";
import { XcodeFirstLaunchPendingError } from "../src/utils/dependency-errors";
import type { DescribeTreeData } from "../src/tools/describe/contract";

const TIMEOUT_MS = 5_000;

function poll(fetchTree: () => Promise<DescribeTreeData>) {
  return pollDescribeTree({
    fetchTree,
    timeoutMs: TIMEOUT_MS,
    pollIntervalMs: 5,
    onSample: () => ({ done: false }),
  });
}

describe("pollDescribeTree with Xcode's component install pending", () => {
  it("rejects with the refusal itself when it is the cause of the fetch error, at once", async () => {
    const refusal = new XcodeFirstLaunchPendingError(["simctl"]);
    const started = Date.now();

    const error = await poll(() =>
      Promise.reject(new Error("describe failed", { cause: refusal }))
    ).catch((e: unknown) => e);

    expect(error).toBe(refusal);
    expect(Date.now() - started).toBeLessThan(TIMEOUT_MS / 2);
  });

  it("rejects with the refusal when the fetch rejects with it directly", async () => {
    const refusal = new XcodeFirstLaunchPendingError(["simctl"]);
    const started = Date.now();

    const error = await poll(() => Promise.reject(refusal)).catch((e: unknown) => e);

    expect(error).toBe(refusal);
    expect(Date.now() - started).toBeLessThan(TIMEOUT_MS / 2);
  });

  it("finds the refusal further down the cause chain", async () => {
    const refusal = new XcodeFirstLaunchPendingError(["simctl"]);

    const error = await poll(() =>
      Promise.reject(new Error("outer", { cause: new Error("inner", { cause: refusal }) }))
    ).catch((e: unknown) => e);

    expect(error).toBe(refusal);
  });

  it("keeps polling after an ordinary error", async () => {
    const fetchTree = vi
      .fn<() => Promise<DescribeTreeData>>()
      .mockRejectedValue(new Error("ax-service query timed out"));

    const result = await pollDescribeTree({
      fetchTree,
      timeoutMs: 100,
      pollIntervalMs: 5,
      onSample: () => ({ done: false }),
    });

    expect(fetchTree.mock.calls.length).toBeGreaterThan(1);
    expect(result.lastAttempt).toBe("error");
    expect(result.lastError).toMatch(/ax-service query timed out/);
  });
});
