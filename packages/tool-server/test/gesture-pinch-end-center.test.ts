import { describe, expect, it, vi, beforeEach } from "vitest";

// Keep the real module (blueprints import from it too) but neutralise the
// fire-and-forget WebSocket send so no real socket is opened during the test.
vi.mock("../src/utils/simulator-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/simulator-client")>()),
  sendCommand: vi.fn(),
}));

import { gesturePinchTool } from "../src/tools/gesture-pinch";
import { sendCommand } from "../src/utils/simulator-client";

const udid = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const services = { simulatorServer: {} } as never;

interface TouchCmd {
  cmd: string;
  type: "Down" | "Move" | "Up";
  x: number;
  y: number;
  second_x: number | null;
  second_y: number | null;
}

function touches(): TouchCmd[] {
  return vi.mocked(sendCommand).mock.calls.map(([, cmd]) => cmd as unknown as TouchCmd);
}

beforeEach(() => {
  vi.mocked(sendCommand).mockClear();
});

describe("gesture-pinch endCenterX/endCenterY", () => {
  it("interpolates the centroid alongside the separation when endCenterX is set", async () => {
    await gesturePinchTool.execute(services, {
      udid,
      centerX: 0.4,
      centerY: 0.6,
      startDistance: 0.1,
      endDistance: 0.3,
      endCenterX: 0.6,
      durationMs: 48, // 3 steps → 4 frames, keeps the test fast
    });

    const frames = touches();
    expect(frames).toHaveLength(4);
    expect(frames[0]!.type).toBe("Down");
    expect(frames[3]!.type).toBe("Up");

    frames.forEach((f, i) => {
      const t = i / 3;
      const mid = (f.x + f.second_x!) / 2;
      expect(mid).toBeCloseTo(0.4 + 0.2 * t, 9); // centroid drifts linearly
      expect(f.second_x! - f.x).toBeCloseTo(0.1 + 0.2 * t, 9); // separation too
      expect(f.y).toBeCloseTo(0.6, 9); // endCenterY omitted → fixed vertical
      expect(f.second_y!).toBeCloseTo(0.6, 9);
    });
  });

  it("interpolates the vertical centroid for a 90° pinch with endCenterY", async () => {
    await gesturePinchTool.execute(services, {
      udid,
      centerX: 0.5,
      centerY: 0.8,
      startDistance: 0.1,
      endDistance: 0.4,
      angle: 90,
      endCenterY: 0.5,
      durationMs: 48,
    });

    const frames = touches();
    frames.forEach((f, i) => {
      const t = i / 3;
      const mid = (f.y + f.second_y!) / 2;
      expect(mid).toBeCloseTo(0.8 - 0.3 * t, 9);
      expect(f.x).toBeCloseTo(0.5, 9);
      expect(f.second_x!).toBeCloseTo(0.5, 9);
    });
  });

  it("keeps today's fixed-center behavior when endCenterX/endCenterY are omitted", async () => {
    await gesturePinchTool.execute(services, {
      udid,
      centerX: 0.4,
      centerY: 0.6,
      startDistance: 0.1,
      endDistance: 0.3,
      durationMs: 48,
    });

    for (const f of touches()) {
      expect((f.x + f.second_x!) / 2).toBeCloseTo(0.4, 9);
      expect(f.y).toBeCloseTo(0.6, 9);
    }
  });
});
