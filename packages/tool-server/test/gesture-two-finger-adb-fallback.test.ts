import { describe, expect, it, vi, beforeEach } from "vitest";
import { getFailureSignal } from "@argent/registry";

vi.mock("../src/utils/simulator-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/simulator-client")>()),
  sendCommand: vi.fn(async () => ({})),
}));

import { gesturePinchTool } from "../src/tools/gesture-pinch";
import { gestureRotateTool } from "../src/tools/gesture-rotate";
import { gestureCustomTool } from "../src/tools/gesture-custom";
import { sendCommand } from "../src/utils/simulator-client";

const udid = "emulator-5570";
const fallenBack = { simulatorServer: { singleTouchOnly: true } } as never;
const grpc = { simulatorServer: {} } as never;

beforeEach(() => {
  vi.mocked(sendCommand).mockClear();
});

async function rejection(run: Promise<unknown>): Promise<Error> {
  return (await run.then(
    () => {
      throw new Error("expected a rejection");
    },
    (err: unknown) => err
  )) as Error;
}

describe("two-finger gestures on an emulator driven over the adb fallback", () => {
  it.each([
    [
      "gesture-pinch",
      () =>
        gesturePinchTool.execute(fallenBack, {
          udid,
          centerX: 0.5,
          centerY: 0.5,
          startDistance: 0.1,
          endDistance: 0.5,
          durationMs: 48,
        }),
    ],
    [
      "gesture-rotate",
      () =>
        gestureRotateTool.execute(fallenBack, {
          udid,
          centerX: 0.5,
          centerY: 0.5,
          radius: 0.1,
          startAngle: 0,
          endAngle: 90,
          durationMs: 48,
        }),
    ],
    [
      "gesture-custom",
      () =>
        gestureCustomTool.execute(fallenBack, {
          udid,
          events: [
            { type: "Down", x: 0.4, y: 0.5, x2: 0.6, y2: 0.5 },
            { type: "Up", x: 0.2, y: 0.5, x2: 0.8, y2: 0.5 },
          ],
        }),
    ],
  ])("%s is rejected before any touch is sent", async (_tool, run) => {
    const error = await rejection(run());

    expect(error.name).toBe("UnsupportedOperationError");
    expect(error.message).toContain("cannot lift two fingers");
    expect(getFailureSignal(error)?.error_code).toBe("TOOL_CAPABILITY_UNSUPPORTED_OPERATION");
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("still runs a single-finger gesture-custom train", async () => {
    await gestureCustomTool.execute(fallenBack, {
      udid,
      events: [
        { type: "Down", x: 0.5, y: 0.5, delayMs: 0 },
        { type: "Up", x: 0.5, y: 0.3, delayMs: 0 },
      ],
    });

    expect(sendCommand).toHaveBeenCalledTimes(2);
  });

  it("still pinches on the emulator controller", async () => {
    await gesturePinchTool.execute(grpc, {
      udid,
      centerX: 0.5,
      centerY: 0.5,
      startDistance: 0.1,
      endDistance: 0.5,
      durationMs: 48,
    });

    expect(sendCommand).toHaveBeenCalledTimes(4);
  });
});
