import { describe, expect, it } from "vitest";
import type { DeviceInfo, Registry } from "@argent/registry";
import type { IosDeviceRunnerApi } from "../src/blueprints/ios-device-runner";
import type { RunnerSnapshotNode } from "../src/utils/ios-device/runner-commands";
import { setCurrentIosDeviceApp } from "../src/utils/ios-device/app-session";
import { describeIosDevice } from "../src/tools/describe/platforms/ios-device";
import { formatDescribeTree } from "../src/tools/describe/format-tree";

// T37: the Swift runner's interactive allowlist ships types the role map used
// to skip. An unmapped type keeps its raw XCTest name (not in CONTENT_ROLES),
// so the nested renderer's content gate dropped it whenever it carried no
// label/value/identifier: icon-only Cells, compact date pickers, and valueless
// toggles were invisible in hardware describe output, and no device tree ever
// showed [scrollable]. These fixtures run the real describeIosDevice →
// formatDescribeTree pipeline and pin the repaired behavior.

const DEVICE_UDID = "00008120-001A38E90C08201E";
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

type SnapshotQuality = { state: string; backend?: string; reason?: string; reasonCode?: string };

async function describeSnapshot(nodes: RunnerSnapshotNode[], quality: SnapshotQuality | null) {
  const api: IosDeviceRunnerApi = {
    udid: DEVICE_UDID,
    run: async () => ({ nodes, quality }),
  };
  const registry = { resolveService: async () => api } as unknown as Registry;
  return describeIosDevice(registry, IOS_DEVICE);
}

async function renderSnapshot(nodes: RunnerSnapshotNode[]): Promise<string> {
  const data = await describeSnapshot(nodes, null);
  return formatDescribeTree(data.tree, { source: data.source });
}

function elementLines(out: string): string[] {
  return out.split("\n").filter((l) => /^\s{2,}\S/.test(l));
}

describe("describeIosDevice adapter: runner type mapping", () => {
  setCurrentIosDeviceApp(DEVICE_UDID, APP);

  it("renders an unlabeled, valueless node of each newly mapped type", async () => {
    const buttonish = ["CheckBox", "MenuItem", "Cell"];
    const adjustable = ["Toggle", "DatePicker", "Picker", "PickerWheel"];
    const fixtures = [...buttonish, ...adjustable].map((type, i) =>
      node({
        index: i + 1,
        depth: 1,
        parentIndex: 0,
        type,
        rect: { x: 16, y: 80 + 64 * i, width: 358, height: 48 },
      })
    );
    // Negative control: a bare Other leaf must still fall to the content gate;
    // the new mappings widen the allowlist, not the gate itself.
    const decorative = node({ index: fixtures.length + 1, depth: 1, parentIndex: 0 });

    const out = await renderSnapshot([appRoot(), ...fixtures, decorative]);

    const lines = elementLines(out);
    expect(lines).toHaveLength(fixtures.length);
    expect(lines.filter((l) => l.includes("AXButton"))).toHaveLength(buttonish.length);
    expect(lines.filter((l) => l.includes("AXAdjustable"))).toHaveLength(adjustable.length);
    for (const type of [...buttonish, ...adjustable]) {
      expect(out).not.toContain(type);
    }
  });

  it("emits unlabeled childless scroll containers with the [scrollable] flag", async () => {
    const containers = ["ScrollView", "Table", "CollectionView", "WebView"].map((type, i) =>
      node({
        index: i + 1,
        depth: 1,
        parentIndex: 0,
        type,
        rect: { x: 0, y: 100 + 180 * i, width: 390, height: 160 },
      })
    );

    const out = await renderSnapshot([appRoot(), ...containers]);

    const lines = elementLines(out);
    expect(lines).toHaveLength(containers.length);
    for (const { type } of containers) {
      const line = lines.find((l) => l.includes(type));
      // Raw name kept (no fake content role); scrollable is what keeps the
      // unlabeled, childless container in the output at all.
      expect(line, `${type} should emit`).toBeDefined();
      expect(line).toContain("[scrollable]");
    }
  });

  it("keeps SegmentedControl unmapped; its Button children carry the interaction", async () => {
    const out = await renderSnapshot([
      appRoot(),
      node({
        index: 1,
        depth: 1,
        parentIndex: 0,
        type: "SegmentedControl",
        label: "Units",
        rect: { x: 16, y: 120, width: 358, height: 32 },
      }),
      node({
        index: 2,
        depth: 2,
        parentIndex: 1,
        type: "Button",
        label: "Metric",
        rect: { x: 16, y: 120, width: 179, height: 32 },
      }),
      node({
        index: 3,
        depth: 2,
        parentIndex: 1,
        type: "Button",
        label: "Imperial",
        rect: { x: 195, y: 120, width: 179, height: 32 },
      }),
    ]);

    const lines = out.split("\n");
    const segmented = lines.find((l) => l.includes('"Units"'))!;
    const metric = lines.find((l) => l.includes('"Metric"'))!;
    expect(segmented).toContain("SegmentedControl");
    expect(metric).toContain("AXButton");
    expect(lines.find((l) => l.includes('"Imperial"'))).toContain("AXButton");
  });
});

describe("describeIosDevice adapter: degraded snapshot hints", () => {
  setCurrentIosDeviceApp(DEVICE_UDID, APP);

  const button = () =>
    node({
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: "Button",
      label: "Continue",
      rect: { x: 16, y: 700, width: 358, height: 48 },
    });

  it("explains the node cap and suggests fewer nodes instead of a retry", async () => {
    const data = await describeSnapshot([appRoot(), button()], {
      state: "degraded",
      backend: "xctest",
      reason: "node budget reached; deeper content was dropped",
      reasonCode: "node_cap",
    });

    expect(data.hint).toMatch(/^Snapshot quality: degraded \(backend xctest, reason node_cap\)\./);
    // A capped tree is deterministic: the same screen yields the same
    // truncation, so the hint must not send the agent into a retry loop.
    expect(data.hint).toContain("node budget");
    expect(data.hint).toContain("same capped tree");
    expect(data.hint).toContain("keyboard");
    expect(data.hint).toContain("await-ui-element");
    expect(data.hint).not.toContain("retry after the UI settles");
    // The tree itself is still adapted; only the hint changes.
    expect(data.tree.children).toHaveLength(1);
  });

  it("keeps the retry wording for every other degraded reason", async () => {
    const data = await describeSnapshot([appRoot(), button()], {
      state: "degraded",
      backend: "ax-fallback",
      reasonCode: "SNAPSHOT_TIMEOUT",
    });

    expect(data.hint).toMatch(
      /^Snapshot quality: degraded \(backend ax-fallback, reason SNAPSHOT_TIMEOUT\)\./
    );
    expect(data.hint).toContain("retry after the UI settles");
    expect(data.hint).not.toContain("node budget");
  });

  it("emits no quality hint for a healthy snapshot", async () => {
    const data = await describeSnapshot([appRoot(), button()], {
      state: "healthy",
      backend: "xctest",
    });

    expect(data.hint).toBeUndefined();
  });
});
