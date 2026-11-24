import { describe, expect, it, vi } from "vitest";
import { ServiceInitializationError } from "@argent/registry";
import { pollDescribeTree } from "../src/utils/poll-describe-tree";
import { XcodeFirstLaunchPendingError } from "../src/utils/dependency-errors";
import type { DescribeTreeData } from "../src/tools/describe/contract";

const TIMEOUT_MS = 5_000;

function poll(fetchTree: () => Promise<DescribeTreeData>, timeoutMs = TIMEOUT_MS) {
  return pollDescribeTree({
    fetchTree,
    timeoutMs,
    pollIntervalMs: 5,
    onSample: () => ({ done: false }),
  });
}

describe("pollDescribeTree with Xcode's component install pending", () => {
  it("rejects at once with the refusal", async () => {
    const refusal = new XcodeFirstLaunchPendingError("simctl");
    const fetchTree = vi.fn(() => Promise.reject(refusal));

    await expect(poll(fetchTree)).rejects.toBe(refusal);
    expect(fetchTree).toHaveBeenCalledOnce();
  });

  // How it arrives when the service factory refuses: the registry wraps it.
  it("rejects at once with a service failure caused by the refusal", async () => {
    const refusal = new XcodeFirstLaunchPendingError("simctl");
    const wrapped = new ServiceInitializationError("AXService:x", refusal.message, {
      cause: refusal,
    });
    const fetchTree = vi.fn(() => Promise.reject(wrapped));

    await expect(poll(fetchTree)).rejects.toBe(wrapped);
    expect(fetchTree).toHaveBeenCalledOnce();
  });

  // How a physical iPhone's wait gets it: starting the runner needs `devicectl`.
  it("rejects at once when starting the iPhone runner is refused", async () => {
    const refusal = new XcodeFirstLaunchPendingError("devicectl");
    const wrapped = new ServiceInitializationError("IosDeviceRunner:x", refusal.message, {
      cause: refusal,
    });
    const fetchTree = vi.fn(() => Promise.reject(wrapped));

    await expect(poll(fetchTree)).rejects.toBe(wrapped);
    expect(fetchTree).toHaveBeenCalledOnce();
  });

  it("keeps polling after an ordinary error", async () => {
    const fetchTree = vi.fn(() => Promise.reject(new Error("ax-service query timed out")));

    const result = await poll(fetchTree, 100);

    expect(fetchTree.mock.calls.length).toBeGreaterThan(1);
    expect(result.lastAttempt).toBe("error");
    expect(result.lastError).toMatch(/ax-service query timed out/);
  });
});
