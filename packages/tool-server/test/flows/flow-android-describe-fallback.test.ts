import { describe, expect, it, vi } from "vitest";
import type { DescribeTreeData } from "../../src/tools/describe/contract";
import { adaptFullAndroidHierarchyToDescribeResult } from "../../src/tools/flows/flow-android-tree";
import type { FlowStep } from "../../src/tools/flows/flow-utils";
import { findAll } from "../../src/utils/ui-tree-match";
import { createFlowTestHarness } from "./harness";

// Each read adapts the dump as the Android fetch does, describe fallback included.
let xml = "";
vi.mock("../../src/tools/flows/flow-tree", () => ({
  fetchFlowTree: vi.fn(
    async (): Promise<DescribeTreeData> => ({
      tree: adaptFullAndroidHierarchyToDescribeResult(xml, SCREEN_W, SCREEN_H),
      source: "android-devtools",
    })
  ),
}));

const SCREEN_W = 1080;
const SCREEN_H = 1920;
const { runWithCalls, writeFlow } = createFlowTestHarness({
  tempDirectoryPrefix: "flow-android-fallback-",
});

async function runSteps(dump: string, steps: FlowStep[]) {
  xml = dump;
  await writeFlow("flow", { executionPrerequisite: "", steps });
  const result = await runWithCalls("flow", "emulator-5554");
  const taps = result.calls
    .filter((c) => c.tool === "gesture-tap")
    .map((c) => c.args as { x: number; y: number });
  return Object.assign(result, { taps });
}

// A Settings row: the row is the tap target, but only its title and summary
// carry text. `describe` labels the row with their joined text.
const SETTINGS_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.android.settings" bounds="[0,0][1080,1920]">
    <node index="0" class="android.widget.LinearLayout" package="com.android.settings" clickable="true" bounds="[0,400][1080,600]">
      <node index="0" class="android.widget.ImageView" resource-id="android:id/icon" package="com.android.settings" bounds="[40,460][120,540]" />
      <node index="1" class="android.widget.RelativeLayout" package="com.android.settings" bounds="[160,430][1040,570]">
        <node index="0" class="android.widget.TextView" text="Network &amp; internet" resource-id="android:id/title" package="com.android.settings" bounds="[160,440][700,500]" />
        <node index="1" class="android.widget.TextView" text="Mobile, Wi-Fi, hotspot" resource-id="android:id/summary" package="com.android.settings" bounds="[160,510][800,560]" />
      </node>
    </node>
  </node>
</hierarchy>`;

// A Delete button and a "Project Beta" title inside a screen-wide touchable.
// `describe` labels the touchable with both texts.
const CARDS_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.view.ViewGroup" clickable="true" package="com.acme.app" bounds="[0,0][1080,1920]">
      <node index="0" class="android.widget.Button" text="Delete" clickable="true" package="com.acme.app" bounds="[80,380][400,460]" />
      <node index="1" class="android.widget.TextView" text="Project Beta" package="com.acme.app" bounds="[80,640][600,700]" />
    </node>
  </node>
</hierarchy>`;

describe("Android describe fallback in a flow run", () => {
  it("taps the row for a role and text copied from describe, and the title for plain text", async () => {
    // The flow tree has no row: it keeps the title and summary views as they are.
    const tree = adaptFullAndroidHierarchyToDescribeResult(SETTINGS_XML, SCREEN_W, SCREEN_H);
    expect(findAll(tree, { role: "LinearLayout" })).toEqual([]);

    const result = await runSteps(SETTINGS_XML, [
      { kind: "tap", selector: { role: "LinearLayout", text: "Network & internet" } },
      { kind: "tap", selector: { text: "Network & internet" } },
      { kind: "assert", condition: "visible", selector: { role: "LinearLayout", text: "Network" } },
    ]);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "tap:pass",
      "tap:pass",
      "assert:pass",
    ]);
    expect(result.taps).toHaveLength(2);
    // The row's centre ([0,400][1080,600])...
    expect(result.taps[0]!.x).toBeCloseTo(540 / SCREEN_W, 6);
    expect(result.taps[0]!.y).toBeCloseTo(500 / SCREEN_H, 6);
    // ...and the title's ([160,440][700,500]): the flow tree answers first.
    expect(result.taps[1]!.x).toBeCloseTo(430 / SCREEN_W, 6);
    expect(result.taps[1]!.y).toBeCloseTo(470 / SCREEN_H, 6);
    // A miss waits out the tap's own timeout; let it fail the step, not the test clock.
  }, 15_000);

  it("never answers a scoped selector from the fallback", async () => {
    // In the fallback, the screen-wide touchable matches "Project Beta" and
    // holds the Delete button. The scope must name a real element instead.
    const scoped = { text: "Delete", within: { text: "Project Beta" } };
    const result = await runSteps(CARDS_XML, [
      { kind: "assert", condition: "visible", selector: { text: "Delete" } },
      { kind: "assert", condition: "hidden", selector: scoped },
      { kind: "tap", selector: scoped },
    ]);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "assert:pass",
      "assert:pass",
      "tap:fail",
    ]);
    expect(result.taps).toEqual([]);
    // The tap fails only after its own timeout.
  }, 15_000);
});
