import { describe, expect, it } from "vitest";
import { withKeyedLock } from "../src/utils/keyed-lock";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Yield the event loop until `cond` holds (bounded, then assert it). */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 1_000 && !cond(); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(cond()).toBe(true);
}

describe("withKeyedLock", () => {
  it("serializes same-key holders: the second runs only after the first settles", async () => {
    const locks = new Map<string, Promise<unknown>>();
    const gate = deferred();
    const order: string[] = [];

    const first = withKeyedLock(locks, "key", async () => {
      order.push("first-start");
      await gate.promise;
      order.push("first-end");
      return "a";
    });
    // The first call provably holds the key's lock mid-flight before the
    // second even starts, so the second MUST queue, not race.
    await until(() => order.includes("first-start"));
    const second = withKeyedLock(locks, "key", async () => {
      order.push("second-start");
      return "b";
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(["first-start"]);

    gate.resolve();
    expect(await Promise.all([first, second])).toEqual(["a", "b"]);
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });

  it("does not queue a different key behind an in-flight holder", async () => {
    const locks = new Map<string, Promise<unknown>>();
    const slowGate = deferred();
    let slowSettled = false;
    const slow = withKeyedLock(locks, "slow", async () => {
      await slowGate.promise;
    });
    void slow.then(() => (slowSettled = true));

    const fast = await withKeyedLock(locks, "fast", async () => "fast-done");
    expect(fast).toBe("fast-done");
    expect(slowSettled).toBe(false); // the other key never waited on this one

    slowGate.resolve();
    await slow;
  });

  it("a failed holder rejects its own caller but never wedges the chain", async () => {
    const locks = new Map<string, Promise<unknown>>();
    await expect(
      withKeyedLock(locks, "key", async () => {
        throw new Error("holder failed");
      })
    ).rejects.toThrow("holder failed");

    // The chain stays usable after the failure, and the map drops the entry
    // once the last holder settles.
    await expect(withKeyedLock(locks, "key", async () => "ok")).resolves.toBe("ok");
    await until(() => locks.size === 0);
  });
});
