import { afterEach, describe, expect, it, vi } from "vitest";
import type { SimulatorServerApi } from "../../src/blueprints/simulator-server";

/**
 * `sendCommand` as the two-finger tools see it: every touch is delivered, and
 * the Down of a foldable whose panel could not be resolved reports a warning.
 */
const sent: Array<{ type: string }> = [];
let downWarning: string | undefined;
vi.mock("../../src/utils/simulator-client", () => ({
  sendCommand: async (_api: unknown, cmd: { type: string }) => {
    sent.push(cmd);
    return cmd.type === "Down" && downWarning !== undefined ? { warning: downWarning } : {};
  },
}));

import { gesturePinchTool } from "../../src/tools/gesture-pinch";
import { gestureRotateTool } from "../../src/tools/gesture-rotate";

const SIM = "B6C52FD4-5408-402B-9369-EF7C66B98E6F";
const services = { simulatorServer: {} as SimulatorServerApi };
const WARNING = "The panel this foldable simulator renders to could not be resolved (…)";

afterEach(() => {
  sent.length = 0;
  downWarning = undefined;
});

describe("two-finger gestures carry the panel warning", () => {
  it("gesture-pinch reports the Down's warning, and nothing without one", async () => {
    downWarning = WARNING;
    const warned = await gesturePinchTool.execute!(services, {
      udid: SIM,
      centerX: 0.5,
      centerY: 0.5,
      startDistance: 0.2,
      endDistance: 0.4,
      durationMs: 100,
    });
    expect(warned.pinched).toBe(true);
    expect(warned.warning).toBe(WARNING);
    expect(sent[0]!.type).toBe("Down");

    downWarning = undefined;
    const plain = await gesturePinchTool.execute!(services, {
      udid: SIM,
      centerX: 0.5,
      centerY: 0.5,
      startDistance: 0.2,
      endDistance: 0.4,
      durationMs: 100,
    });
    expect(plain).toEqual({ pinched: true, timestampMs: expect.any(Number) });
    expect(plain).not.toHaveProperty("warning");
  });

  it("gesture-rotate reports the Down's warning, and nothing without one", async () => {
    downWarning = WARNING;
    const warned = await gestureRotateTool.execute!(services, {
      udid: SIM,
      centerX: 0.5,
      centerY: 0.5,
      radius: 0.2,
      startAngle: 0,
      endAngle: 90,
      durationMs: 100,
    });
    expect(warned.rotated).toBe(true);
    expect(warned.warning).toBe(WARNING);

    downWarning = undefined;
    const plain = await gestureRotateTool.execute!(services, {
      udid: SIM,
      centerX: 0.5,
      centerY: 0.5,
      radius: 0.2,
      startAngle: 0,
      endAngle: 90,
      durationMs: 100,
    });
    expect(plain).toEqual({ rotated: true, timestampMs: expect.any(Number) });
    expect(plain).not.toHaveProperty("warning");
  });
});
