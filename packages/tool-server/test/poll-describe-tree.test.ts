import { describe, expect, it, vi } from "vitest";
import { pollDescribeTree } from "../src/utils/poll-describe-tree";

describe("pollDescribeTree", () => {
  const failingRead = () => vi.fn(() => Promise.reject(new Error("no page target")));

  it("retries a failed read until the timeout by default", async () => {
    const fetchTree = failingRead();

    const poll = await pollDescribeTree({
      fetchTree,
      timeoutMs: 60,
      pollIntervalMs: 10,
      onSample: () => ({ done: false }),
    });

    expect(fetchTree.mock.calls.length).toBeGreaterThan(1);
    expect(poll.lastError).toBe("no page target");
  });

  it("ends on the first failed read with stopOnError", async () => {
    const fetchTree = failingRead();

    const poll = await pollDescribeTree({
      fetchTree,
      timeoutMs: 2000,
      pollIntervalMs: 10,
      stopOnError: true,
      onSample: () => ({ done: false }),
    });

    expect(fetchTree).toHaveBeenCalledTimes(1);
    expect(poll).toMatchObject({ result: undefined, aborted: false, polls: 1 });
    expect(poll.lastError).toBe("no page target");
    expect(poll.elapsedMs).toBeLessThan(2000);
  });
});
