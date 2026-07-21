import { describe, expect, it, vi, beforeEach } from "vitest";

// Keep the real module (blueprints import from it too) but neutralise the
// fire-and-forget WebSocket send so no real socket is opened during the test.
vi.mock("../src/utils/simulator-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/simulator-client")>()),
  sendCommand: vi.fn(),
}));

import { gestureRotateTool } from "../src/tools/gesture-rotate";
import { sendCommand } from "../src/utils/simulator-client";

const udid = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const services = { simulatorServer: {} } as never;

// The physical screen the normalized coordinates land on in these assertions.
const SCREEN_W = 1080;
const SCREEN_H = 2400;

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
  // Reset (not just clear) so the abort test's mockImplementation can't leak.
  vi.mocked(sendCommand).mockReset();
});

describe("gesture-rotate radiusX/radiusY", () => {
  it("orbits a physical circle with constant finger separation when both are set", async () => {
    // One physical radius, two normalizations: 0.4·1080 = 0.18·2400 = 432 px.
    await gestureRotateTool.execute(services, {
      udid,
      centerX: 0.5,
      centerY: 0.5,
      radiusX: 0.4,
      radiusY: 0.18,
      startAngle: 0,
      endAngle: 90,
      durationMs: 48, // 3 steps → 4 frames, keeps the test fast
    });

    const frames = touches();
    expect(frames).toHaveLength(4);
    expect(frames[0]!.type).toBe("Down");
    expect(frames[3]!.type).toBe("Up");

    for (const f of frames) {
      const px1 = f.x * SCREEN_W;
      const py1 = f.y * SCREEN_H;
      const px2 = f.second_x! * SCREEN_W;
      const py2 = f.second_y! * SCREEN_H;
      // Each finger stays 432 physical px from the center; separation 864.
      expect(Math.hypot(px1 - 0.5 * SCREEN_W, py1 - 0.5 * SCREEN_H)).toBeCloseTo(432, 9);
      expect(Math.hypot(px1 - px2, py1 - py2)).toBeCloseTo(864, 9);
    }
  });

  it("keeps the legacy radius-only behavior byte-identical", async () => {
    await gestureRotateTool.execute(services, {
      udid,
      centerX: 0.4,
      centerY: 0.6,
      radius: 0.15,
      startAngle: 0,
      endAngle: 90,
      durationMs: 48,
    });

    const frames = touches();
    expect(frames).toHaveLength(4);
    frames.forEach((f, i) => {
      // The pre-radiusX formula, replicated operation-for-operation so the
      // expected values are bit-identical, not merely close.
      const t = i / 3;
      const angleDeg = 0 + (90 - 0) * t;
      const angleRad = (angleDeg * Math.PI) / 180;
      expect(f.x).toBe(0.4 + 0.15 * Math.cos(angleRad));
      expect(f.y).toBe(0.6 + 0.15 * Math.sin(angleRad));
      expect(f.second_x!).toBe(0.4 - 0.15 * Math.cos(angleRad));
      expect(f.second_y!).toBe(0.6 - 0.15 * Math.sin(angleRad));
    });
  });
});

describe("gesture-rotate inputSchema", () => {
  it("advertises the radius requirement the zod refinements lose in JSON Schema conversion", () => {
    const schema = gestureRotateTool.inputSchema!;
    expect(schema.type).toBe("object");
    expect(schema.anyOf).toEqual([{ required: ["radius"] }, { required: ["radiusX", "radiusY"] }]);
    const required = schema.required as string[];
    expect(required).toEqual(
      expect.arrayContaining(["udid", "centerX", "centerY", "startAngle", "endAngle"])
    );
    // The radius trio stays optional at the top level; only the anyOf constrains it.
    expect(required).not.toContain("radius");
    expect(required).not.toContain("radiusX");
    expect(required).not.toContain("radiusY");
    expect(schema).not.toHaveProperty("$schema");
  });

  it("still enforces the radius rule at runtime via the zod schema", () => {
    const base = { udid, centerX: 0.5, centerY: 0.5, startAngle: 0, endAngle: 90 };
    expect(gestureRotateTool.zodSchema!.safeParse(base).success).toBe(false);
    expect(gestureRotateTool.zodSchema!.safeParse({ ...base, radius: 0.15 }).success).toBe(true);
    expect(
      gestureRotateTool.zodSchema!.safeParse({ ...base, radiusX: 0.4, radiusY: 0.18 }).success
    ).toBe(true);
  });
});

// The ctx-less path (execute called with no third argument, as in direct unit
// invocations) is covered by every test in the describe above.
describe("gesture-rotate abort", () => {
  it("lifts the fingers where they are and rejects when aborted mid-gesture", async () => {
    const controller = new AbortController();
    // Abort synchronously from inside the send mock after the 3rd dispatched
    // event — deterministic, no real-time races.
    let sent = 0;
    vi.mocked(sendCommand).mockImplementation(() => {
      if (++sent === 3) controller.abort();
    });

    await expect(
      gestureRotateTool.execute(
        services,
        {
          udid,
          centerX: 0.5,
          centerY: 0.5,
          radius: 0.15,
          startAngle: 0,
          endAngle: 90,
          durationMs: 480, // 30 steps → 31 frames if run to completion
        },
        { signal: controller.signal } as never
      )
    ).rejects.toThrow(/gesture-rotate aborted/);

    const frames = touches();
    // Down + 2 Moves before the abort lands, then only the terminal Up.
    expect(frames.map((f) => f.type)).toEqual(["Down", "Move", "Move", "Up"]);
    // The lift happens at the last dispatched finger positions, not the arc end.
    const last = frames[3]!;
    const prev = frames[2]!;
    expect(last.x).toBe(prev.x);
    expect(last.y).toBe(prev.y);
    expect(last.second_x).toBe(prev.second_x);
    expect(last.second_y).toBe(prev.second_y);
  });
});
