import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/utils/simulator-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/simulator-client")>()),
  sendCommand: vi.fn(),
}));

import { gesturePinchTool } from "../src/tools/gesture-pinch";
import { gestureRotateTool } from "../src/tools/gesture-rotate";
import { sendCommand } from "../src/utils/simulator-client";

const udid = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const services = { simulatorServer: {} } as never;

beforeEach(() => {
  vi.mocked(sendCommand).mockReset();
});

describe("gesture-pinch — off-screen fingers", () => {
  it("rejects the reported case instead of dispatching it", async () => {
    // centerY 0.35 with startDistance 0.75 at 90° puts a finger at y = -0.025.
    // Dispatched, Android reads it as a status-bar pull and opens the
    // notification shade while the tool reports success.
    await expect(
      gesturePinchTool.execute(services, {
        udid,
        centerX: 0.5,
        centerY: 0.35,
        startDistance: 0.75,
        endDistance: 0.2,
        angle: 90,
      })
    ).rejects.toThrow(/finger y = -0\.025/);
  });

  it("sends nothing at all when it rejects", async () => {
    // The check has to run before the first Down: rejecting mid-gesture would
    // leave a synthetic finger held on the glass with no matching Up.
    await gesturePinchTool
      .execute(services, {
        udid,
        centerX: 0.5,
        centerY: 0.35,
        startDistance: 0.75,
        endDistance: 0.2,
        angle: 90,
      })
      .catch(() => {});

    expect(vi.mocked(sendCommand)).not.toHaveBeenCalled();
  });

  it("names the edge and points at the documented remedy", async () => {
    const err = await gesturePinchTool
      .execute(services, {
        udid,
        centerX: 0.5,
        centerY: 0.35,
        startDistance: 0.75,
        endDistance: 0.2,
        angle: 90,
      })
      .catch((e: Error) => e);

    expect(String(err)).toContain("top edge");
    expect(String(err)).toContain("endCenterX/endCenterY");
  });

  it("accepts a gesture whose finger lands exactly on the edge", async () => {
    // A full-width pinch legitimately touches 0 and 1; rejecting that would
    // forbid the widest valid gesture.
    await expect(
      gesturePinchTool.execute(services, {
        udid,
        centerX: 0.5,
        centerY: 0.375,
        startDistance: 0.75,
        endDistance: 0.2,
        angle: 90,
      })
    ).resolves.toMatchObject({ pinched: true });
  });

  it("still rejects when only a later frame leaves the screen", async () => {
    // Fingers start well inside and spread past the left/right edges as the
    // gesture runs, so an inspection of the first frame alone would miss it.
    await expect(
      gesturePinchTool.execute(services, {
        udid,
        centerX: 0.5,
        centerY: 0.5,
        startDistance: 0.2,
        endDistance: 1.4,
        angle: 0,
      })
    ).rejects.toThrow(/off-screen/);
  });
});

describe("gesture-rotate — off-screen fingers", () => {
  it("rejects an orbit that leaves the screen", async () => {
    await expect(
      gestureRotateTool.execute(services, {
        udid,
        centerX: 0.5,
        centerY: 0.3,
        radius: 0.45,
        startAngle: 270,
        endAngle: 300,
      })
    ).rejects.toThrow(/finger y = -0\.15/);
  });

  it("sends nothing at all when it rejects", async () => {
    await gestureRotateTool
      .execute(services, {
        udid,
        centerX: 0.5,
        centerY: 0.3,
        radius: 0.45,
        startAngle: 270,
        endAngle: 300,
      })
      .catch(() => {});

    expect(vi.mocked(sendCommand)).not.toHaveBeenCalled();
  });

  it("accepts a short arc that stays on-screen even though the full circle would not", async () => {
    // The same center and radius as the rejected case above: only the swept
    // portion matters, so checking the whole orbit would refuse a valid gesture.
    await expect(
      gestureRotateTool.execute(services, {
        udid,
        centerX: 0.5,
        centerY: 0.3,
        radius: 0.45,
        startAngle: 0,
        endAngle: 20,
      })
    ).resolves.toMatchObject({ rotated: true });
  });

  it("rejects an arc whose endpoints are on-screen but whose midpoint is not", async () => {
    // 0° and 180° both put the fingers on the centre line, so an endpoint-only
    // check passes while the frame near 90° reaches a full radius past the top.
    await expect(
      gestureRotateTool.execute(services, {
        udid,
        centerX: 0.5,
        centerY: 0.2,
        radius: 0.25,
        startAngle: 0,
        endAngle: 180,
      })
    ).rejects.toThrow(/off-screen/);
  });
});
