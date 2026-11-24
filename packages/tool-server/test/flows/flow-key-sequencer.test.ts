/**
 * `keyResolutions` — the in-flight map every recording tool's key resolution
 * passes through.
 *
 * Resolution is `realpath`, which runs on libuv's threadpool and completes in
 * an order unrelated to the order it was requested in. Every recording tool
 * resolves its key BEFORE joining its flow file's lock queue, so without the
 * sequencer which of two calls acquires the lock first is decided by threadpool
 * scheduling rather than by which was issued first — and a restart can land
 * behind the append it is supposed to discard.
 *
 * Nothing imported it, so the property had no test at all. Here `realpath` is
 * mocked to complete in decreasing time, which inverts the issue order
 * deterministically: without the sequencer the second caller wins.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as realFs from "node:fs/promises";

/**
 * How long each `realpath` call takes, by call index — strictly decreasing, so
 * a later request always finishes before an earlier one.
 */
const DELAYS = [40, 30, 20, 10, 8, 6, 4, 2];
let realpathCalls = 0;

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: (p: string) => {
      const delay = DELAYS[Math.min(realpathCalls++, DELAYS.length - 1)]!;
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          actual.realpath(p).then(resolve, reject);
        }, delay);
      });
    },
  };
});

import { withFlowFileLock, __resetRecordingsForTesting } from "../../src/tools/flows/flow-utils";

let root: string;

beforeEach(async () => {
  __resetRecordingsForTesting();
  realpathCalls = 0;
  root = await realFs.mkdtemp(path.join(os.tmpdir(), "flow-key-seq-"));
  await realFs.mkdir(path.join(root, ".argent", "flows"), { recursive: true });
  await realFs.writeFile(path.join(root, ".argent", "flows", "alpha.yaml"), "steps: []\n", "utf8");
});

afterEach(async () => {
  await realFs.rm(root, { recursive: true, force: true });
});

describe("the flow-key resolution sequencer", () => {
  it("keeps the lock queue in the order the calls were issued", async () => {
    const order: string[] = [];
    const enter = (label: string) =>
      withFlowFileLock(root, "alpha", async () => {
        order.push(label);
      });

    // Issued first, resolves SLOWEST if it resolves on its own.
    const first = enter("first");
    const second = enter("second");
    const third = enter("third");
    await Promise.all([first, second, third]);

    expect(order).toEqual(["first", "second", "third"]);
  });

  it("shares one resolution between callers spelling the path the same way", async () => {
    const before = realpathCalls;
    await Promise.all([
      withFlowFileLock(root, "alpha", async () => {}),
      withFlowFileLock(root, "alpha", async () => {}),
      withFlowFileLock(root, "alpha", async () => {}),
    ]);
    // One resolution — a dir + a file realpath — not three.
    expect(realpathCalls - before).toBe(2);
  });

  it("drops the entry once it settles, so a repointed link is seen next time", async () => {
    // Not a cache: a second round must resolve again rather than reuse the
    // first round's answer.
    await withFlowFileLock(root, "alpha", async () => {});
    const after = realpathCalls;
    await withFlowFileLock(root, "alpha", async () => {});
    expect(realpathCalls).toBeGreaterThan(after);
  });

  it("resolves two DIFFERENT flows separately rather than sharing one answer", async () => {
    // Keyed by the SPELLED path, so two flows never collapse onto one
    // resolution — which would hand one file's key to the other's lock.
    await realFs.writeFile(path.join(root, ".argent", "flows", "beta.yaml"), "steps: []\n", "utf8");
    const before = realpathCalls;
    await Promise.all([
      withFlowFileLock(root, "alpha", async () => {}),
      withFlowFileLock(root, "beta", async () => {}),
    ]);
    expect(realpathCalls - before).toBe(4);
  });
});
