import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DeviceInfo } from "@argent/registry";
import type { DescribeTreeData, UiOrientation } from "../../src/tools/describe/contract";

vi.mock("../../src/tools/flows/flow-tree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/tools/flows/flow-tree")>()),
  fetchFlowTree: vi.fn(async (): Promise<DescribeTreeData> => ({
    tree: {
      role: "AXWindow",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        {
          role: "AXButton",
          label: "Go",
          frame: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
          children: [],
        },
      ],
    },
    source: "native-devtools",
  })),
}));

import { createFlowTestHarness } from "./harness";
import { uprightLegacyPoints } from "../../src/tools/flows/flow-legacy-points";
import type { FlowStep } from "../../src/tools/flows/flow-utils";
import {
  __resetUiOrientationForTests,
  inNativeCoordinates,
  setUiOrientationSourceProvider,
} from "../../src/utils/ios-ui-orientation";
import { nativePointToUi } from "../../src/utils/ui-orientation";

const SIM: DeviceInfo = {
  id: "405655A7-F5FD-4101-9168-148F0F0953D1",
  platform: "ios",
  kind: "simulator",
};

let orientation: UiOrientation | Error = "landscapeRight";

beforeEach(() => {
  __resetUiOrientationForTests();
  orientation = "landscapeRight";
  setUiOrientationSourceProvider(async () => ({
    orientation: async () => {
      if (orientation instanceof Error) throw orientation;
      return { interfaceOrientation: orientation };
    },
  }));
});

afterEach(() => {
  setUiOrientationSourceProvider(undefined);
});

describe("uprightLegacyPoints", () => {
  it("turns a tap's native point into the UI's", async () => {
    const { step } = await uprightLegacyPoints(SIM, { kind: "tap", x: 0.9, y: 0.2 });
    // landscapeRight: native (x, y) is UI (y, 1 - x), free of float noise.
    expect(step).toEqual({ kind: "tap", x: 0.2, y: 0.1 });
  });

  it("turns a swipe's points and its delta, and leaves its selectors and direction", async () => {
    orientation = "landscapeLeft";
    const swipe: FlowStep = {
      kind: "swipe",
      from: { selector: { text: "Go" } },
      to: { x: 0.25, y: 0.75 },
      by: { y: 0.3 },
      direction: "up",
    };
    const { step } = await uprightLegacyPoints(SIM, swipe);
    // landscapeLeft: native (x, y) is UI (1 - y, x), so native +y is UI -x.
    expect(step).toEqual({
      kind: "swipe",
      from: { selector: { text: "Go" } },
      to: { x: 0.25, y: 0.25 },
      by: { x: -0.3 },
      direction: "up",
    });
  });

  it("keeps both axes of a delta that names both, through a half turn", async () => {
    orientation = "portraitUpsideDown";
    const { step } = await uprightLegacyPoints(SIM, { kind: "swipe", by: { x: 0.1, y: -0.2 } });
    expect(step).toEqual({ kind: "swipe", by: { x: -0.1, y: 0.2 } });
  });

  it("leaves a portrait UI, another platform and a selector tap alone", async () => {
    const tap: FlowStep = { kind: "tap", x: 0.9, y: 0.2 };
    orientation = "portrait";
    expect((await uprightLegacyPoints(SIM, tap)).step).toBe(tap);
    orientation = "landscapeRight";
    const android = { id: "emulator-5554", platform: "android", kind: "emulator" } as DeviceInfo;
    expect((await uprightLegacyPoints(android, tap)).step).toBe(tap);
    const byText: FlowStep = { kind: "tap", selector: { text: "Go" } };
    expect((await uprightLegacyPoints(SIM, byText)).step).toBe(byText);
  });

  it("sends the points as recorded, with a note, when the orientation cannot be read", async () => {
    orientation = new Error("down");
    const tap: FlowStep = { kind: "tap", x: 0.9, y: 0.2 };
    const out = await uprightLegacyPoints(SIM, tap);
    expect(out.step).toBe(tap);
    expect(out.warning).toContain("could not be read");
  });
});

describe("running a version 1 e2e test on a landscape iOS simulator", () => {
  const h = createFlowTestHarness({ tempDirectoryPrefix: "flow-legacy-points-" });

  async function writeYaml(name: string, yaml: string): Promise<void> {
    const dir = path.join(h.root(), ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${name}.yaml`), yaml, "utf8");
  }

  const STEPS = `steps:
  - tap: { x: 0.9, y: 0.2 }
  - tool: gesture-swipe
    args: { fromX: 0.5, fromY: 0.8, toX: 0.5, toY: 0.2 }
`;

  it.each([
    ["without a version", "", true],
    ["at version 1", "version: 1\n", true],
    ["at version 2", "version: 2\n", false],
  ])("a file %s", async (_name, header, legacy) => {
    await writeYaml("t", header + STEPS);
    const seen: Array<{ tool: string; native: boolean; args: Record<string, unknown> }> = [];
    const result = await h.runWithCalls("t", SIM.id, (call) => {
      seen.push({ tool: call.tool, native: inNativeCoordinates(), args: call.args });
    });
    expect(result.steps.map((s) => s.status)).toEqual(["pass", "pass"]);
    const tap = seen.find((c) => c.tool === "gesture-tap")!;
    const swipe = seen.find((c) => c.tool === "gesture-swipe")!;
    const upright = legacy
      ? nativePointToUi({ x: 0.9, y: 0.2 }, "landscapeRight")
      : { x: 0.9, y: 0.2 };
    expect(tap.args.x).toBeCloseTo(upright.x);
    expect(tap.args.y).toBeCloseTo(upright.y);
    // The touches of both tools are turned by sendCommand unless they run native.
    expect(tap.native).toBe(false);
    expect(swipe.native).toBe(legacy);
    expect(swipe.args).toMatchObject({ fromX: 0.5, fromY: 0.8, toX: 0.5, toY: 0.2 });
  });
});
