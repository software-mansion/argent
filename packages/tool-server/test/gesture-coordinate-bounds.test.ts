import { describe, expect, it, vi } from "vitest";
import { Registry } from "@argent/registry";
import { gestureTapTool } from "../src/tools/gesture-tap";
import { gestureSwipeTool } from "../src/tools/gesture-swipe";
import { gestureScrollTool } from "../src/tools/gesture-scroll";
import { gestureDragTool } from "../src/tools/gesture-drag";
import { createRunSequenceTool } from "../src/tools/run-sequence";

const gestures = [
  {
    tool: gestureTapTool,
    udid: "emulator-5554",
    args: { x: 0.5, y: 0.5 },
    coordinates: ["x", "y"],
  },
  {
    tool: gestureSwipeTool,
    udid: "emulator-5554",
    args: { fromX: 0.5, fromY: 0.8, toX: 0.5, toY: 0.2 },
    coordinates: ["fromX", "fromY", "toX", "toY"],
  },
  {
    tool: gestureScrollTool,
    udid: "chromium-cdp-19222",
    args: { x: 0.5, y: 0.5, deltaY: 0.5 },
    coordinates: ["x", "y"],
  },
  {
    tool: gestureDragTool,
    udid: "chromium-cdp-19222",
    args: { fromX: 0.2, fromY: 0.5, toX: 0.8, toY: 0.5 },
    coordinates: ["fromX", "fromY", "toX", "toY"],
  },
];

function registryRig() {
  const registry = new Registry();
  registry.registerTool(gestureTapTool);
  registry.registerTool(gestureSwipeTool);
  registry.registerTool(gestureScrollTool);
  registry.registerTool(gestureDragTool);
  // A regression must fail without starting any real device backend.
  const resolveService = vi
    .spyOn(registry, "resolveService")
    .mockRejectedValue(new Error("Unexpected service resolution"));
  return { registry, resolveService };
}

for (const { tool, udid, args, coordinates } of gestures) {
  describe(`${tool.id} coordinate bounds`, () => {
    for (const coordinate of coordinates) {
      it.each([-0.1, 1.1, 540])(`rejects ${coordinate} = %s and names the coordinate`, (value) => {
        const parsed = tool.zodSchema!.safeParse({ udid, ...args, [coordinate]: value });

        expect(parsed.success).toBe(false);
        expect(parsed.error!.issues[0].path).toEqual([coordinate]);
      });

      it.each([0, 1])(`accepts ${coordinate} = %s`, (value) => {
        expect(tool.zodSchema!.safeParse({ udid, ...args, [coordinate]: value }).success).toBe(
          true
        );
      });

      it(`advertises inclusive 0–1 bounds for ${coordinate}`, () => {
        const { registry } = registryRig();
        const properties = registry.getTool(tool.id)!.inputSchema!.properties as Record<
          string,
          unknown
        >;
        expect(properties[coordinate]).toMatchObject({ minimum: 0, maximum: 1 });
      });

      it(`rejects an invalid ${coordinate} before resolving services`, async () => {
        const { registry, resolveService } = registryRig();

        await expect(
          registry.invokeTool(tool.id, { udid, ...args, [coordinate]: -0.1 })
        ).rejects.toThrow(new RegExp(`Invalid params.*${coordinate}`));
        expect(resolveService).not.toHaveBeenCalled();
      });
    }

    it("stops run-sequence at an invalid coordinate before resolving services", async () => {
      const { registry, resolveService } = registryRig();
      const sequence = createRunSequenceTool(registry);
      const coordinate = coordinates[0];

      const result = await sequence.execute(
        {},
        {
          udid,
          steps: [
            { tool: tool.id, args: { ...args, [coordinate]: 5 }, delayMs: 0 },
            { tool: "gesture-tap", args: { x: 0.5, y: 0.5 }, delayMs: 0 },
          ],
        }
      );

      expect(result).toMatchObject({ completed: 0, total: 2 });
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0]).toMatchObject({
        tool: tool.id,
        error: expect.stringContaining(coordinate),
      });
      expect(resolveService).not.toHaveBeenCalled();
    });
  });
}

describe("gesture-scroll deltas", () => {
  it.each([-10, -0.5, 0.5, 10])("accepts signed, multi-window deltas of %s", (delta) => {
    for (const coordinate of ["deltaX", "deltaY"]) {
      expect(
        gestureScrollTool.zodSchema!.safeParse({
          udid: "chromium-cdp-19222",
          x: 0.5,
          y: 0.5,
          [coordinate]: delta,
        }).success
      ).toBe(true);
    }
  });
});
