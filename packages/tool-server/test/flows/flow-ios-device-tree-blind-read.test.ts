import { describe, expect, it, vi } from "vitest";
import type { DeviceInfo, Registry } from "@argent/registry";
import type { IosDeviceRunnerApi } from "../../src/blueprints/ios-device-runner";
import type { RunnerSnapshotNode } from "../../src/utils/ios-device/runner-commands";
import { setCurrentIosDeviceApp } from "../../src/utils/ios-device/app-session";
import { describeIosDevice } from "../../src/tools/describe/platforms/ios-device";
import { queryIosDeviceFlowTree } from "../../src/tools/flows/flow-ios-tree";

// The physical-device half of the no-windows contract (see
// flow-ios-tree-no-windows.test.ts for the simulator half): on a childless
// runner snapshot (zero nodes, or still root-only after the settle-and-retry)
// describeIosDevice returns a childless Application root plus a hint: the
// right shape for describe/await, which surface the hint. The flow tree
// source must THROW on that shape instead: settleTree reads only `.tree`, so
// two blind reads fingerprint identical and "settle", and the step then fails
// with a misleading offscreen hint while the runner's own hint is dropped.

const DEVICE_UDID = "00008110-000978540290401E";
const APP = "com.example.app";

const IOS_DEVICE = {
  id: DEVICE_UDID,
  platform: "ios",
  kind: "device",
} as unknown as DeviceInfo;

function node(
  partial: Partial<RunnerSnapshotNode> & { index: number; depth: number }
): RunnerSnapshotNode {
  return {
    type: "Other",
    label: null,
    identifier: null,
    value: null,
    rect: { x: 0, y: 0, width: 390, height: 844 },
    enabled: true,
    focused: null,
    selected: null,
    parentIndex: null,
    ...partial,
  };
}

function appRoot(): RunnerSnapshotNode {
  return node({ index: 0, depth: 0, type: "Application" });
}

function continueButton(): RunnerSnapshotNode {
  return node({
    index: 1,
    depth: 1,
    parentIndex: 0,
    type: "Button",
    label: "Continue",
    rect: { x: 16, y: 760, width: 358, height: 52 },
  });
}

function registryFor(api: IosDeviceRunnerApi): Registry {
  return { resolveService: async () => api } as unknown as Registry;
}

const BLIND_READ_HINT =
  "The runner returned an empty or root-only accessibility tree. The app may still " +
  "be launching, or this screen exposes no accessibility elements.";

describe("queryIosDeviceFlowTree: blind (childless runner tree) reads", () => {
  setCurrentIosDeviceApp(DEVICE_UDID, APP);

  it("throws with the runner's own hint when the snapshot has zero nodes", async () => {
    const run = vi.fn(async () => ({ nodes: [], quality: null }));
    const registry = registryFor({ udid: DEVICE_UDID, run });

    // Fake timers ride out describeIosDevice's 1.5s settle-and-retry; the
    // rejection handler is attached before advancing so it is never unhandled.
    vi.useFakeTimers();
    try {
      const outcome = queryIosDeviceFlowTree(registry, IOS_DEVICE).then(
        () => null,
        (err: unknown) => err
      );
      await vi.advanceTimersByTimeAsync(2_000);
      const err = await outcome;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain(BLIND_READ_HINT);
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // The 1-node twin: a snapshot still root-only after the settle-and-retry
  // adapts to the same childless shape and must carry the same hint; without
  // it, all three blind-read guards downstream are bypassed together (a
  // `hidden` wait resolves success against an unreadable screen, and the flow
  // sources settle on a tree nobody saw).
  it("hints and throws when the snapshot stays root-only after the retry", async () => {
    const run = vi.fn(async () => ({ nodes: [appRoot()], quality: null }));
    const registry = registryFor({ udid: DEVICE_UDID, run });

    vi.useFakeTimers();
    try {
      const pending = describeIosDevice(registry, IOS_DEVICE);
      await vi.advanceTimersByTimeAsync(2_000);
      const data = await pending;
      expect(data.tree.role).toBe("Application");
      expect(data.tree.children).toHaveLength(0);
      expect(data.hint).toBe(BLIND_READ_HINT);
      expect(run).toHaveBeenCalledTimes(2);

      const flowRun = vi.fn(async () => ({ nodes: [appRoot()], quality: null }));
      const outcome = queryIosDeviceFlowTree(
        registryFor({ udid: DEVICE_UDID, run: flowRun }),
        IOS_DEVICE
      ).then(
        () => null,
        (err: unknown) => err
      );
      await vi.advanceTimersByTimeAsync(2_000);
      const err = await outcome;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain(BLIND_READ_HINT);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not throw for a degraded-quality hint on a non-empty tree", async () => {
    const run = vi.fn(async () => ({
      nodes: [appRoot(), continueButton()],
      quality: { state: "degraded", backend: "ax-fallback", reasonCode: "SNAPSHOT_TIMEOUT" },
    }));
    const registry = registryFor({ udid: DEVICE_UDID, run });

    const data = await queryIosDeviceFlowTree(registry, IOS_DEVICE);

    expect(data.source).toBe("xcuitest-runner");
    expect(data.hint).toMatch(/Snapshot quality: degraded/);
    // The adapted tree is the FLATTENED counterpart of the describe tree, so
    // leaves arrive in the shape every other platform's flow adapter emits
    // (see flow-ios-device-tree.test.ts).
    expect(data.tree.children).toHaveLength(1);
    expect(data.tree.children[0]).toMatchObject({
      role: "AXButton",
      label: "Continue",
      children: [],
    });
  });
});
