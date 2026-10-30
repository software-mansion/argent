import { beforeEach, describe, expect, it, vi } from "vitest";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";

vi.mock("../src/utils/device-orientation", () => ({
  readAndroidSurfaceRotation: vi.fn(async (): Promise<0 | 1 | 2 | 3 | null> => 1),
}));
vi.mock("../src/utils/simulator-client", () => ({
  sendCommand: vi.fn(),
}));

import { readAndroidSurfaceRotation } from "../src/utils/device-orientation";
import { createTouchSender } from "../src/utils/gesture-utils";
import { resolveDevice } from "../src/utils/device-info";
import { sendCommand } from "../src/utils/simulator-client";
import { gestureTapTool } from "../src/tools/gesture-tap";
import { gestureSwipeTool } from "../src/tools/gesture-swipe";
import { gestureCustomTool } from "../src/tools/gesture-custom";
import { gesturePinchTool } from "../src/tools/gesture-pinch";
import { gestureRotateTool } from "../src/tools/gesture-rotate";

const udid = "127.0.0.1:15671";
const api = {} as never;
const services = { simulatorServer: api } as never;
const readRotation = vi.mocked(readAndroidSurfaceRotation);
const send = vi.mocked(sendCommand);

beforeEach(() => {
  send.mockReset().mockResolvedValue({});
  readRotation.mockReset().mockResolvedValue(1);
});

describe("physical Android touch coordinates", () => {
  // The Pixel 9a has a natural 1080x2424 display. These are the pixel
  // coordinates the screen-sharing agent's AdjustedDisplayCoordinates applies,
  // independently of the normalized transform in Argent.
  it.each([0, 1, 2, 3] as const)(
    "lands both fingers at their screen points at rotation %i",
    async (rotation) => {
      readRotation.mockResolvedValue(rotation);
      const touch = await createTouchSender(api, resolveDevice(udid));
      await touch("Down", 0.13, 0.79, 0.89, 0.21);
      const cmd = send.mock.calls[0]![1];
      const width = rotation % 2 === 0 ? 1080 : 2424;
      const height = rotation % 2 === 0 ? 2424 : 1080;
      const land = (x: number, y: number): [number, number] => {
        const naturalX = x * 1080;
        const naturalY = y * 2424;
        switch (rotation) {
          case 1:
            return [naturalY, 1080 - naturalX];
          case 2:
            return [1080 - naturalX, 2424 - naturalY];
          case 3:
            return [2424 - naturalY, naturalX];
          default:
            return [naturalX, naturalY];
        }
      };
      const first = land(cmd.x as number, cmd.y as number);
      const second = land(cmd.second_x as number, cmd.second_y as number);
      expect(first[0]).toBeCloseTo(0.13 * width);
      expect(first[1]).toBeCloseTo(0.79 * height);
      expect(second[0]).toBeCloseTo(0.89 * width);
      expect(second[1]).toBeCloseTo(0.21 * height);
    }
  );

  it("corrects the recorded Pixel landscape Default apps tap", async () => {
    await gestureTapTool.execute(services, { udid, x: 0.5315, y: 0.881 });
    const cmd = send.mock.calls[0]![1];
    expect(cmd.x).toBeCloseTo(0.119);
    expect(cmd.y).toBe(0.5315);
    expect(send.mock.calls[1]![1]).toMatchObject({ type: "Up", x: cmd.x, y: cmd.y });
    expect(readRotation).toHaveBeenCalledOnce();
  });

  it("reads the actual orientation again for the next gesture", async () => {
    readRotation.mockResolvedValueOnce(1).mockResolvedValueOnce(3);
    await gestureTapTool.execute(services, { udid, x: 0.094, y: 0.073 });
    await gestureTapTool.execute(services, { udid, x: 0.094, y: 0.073 });
    expect(send.mock.calls[0]![1]).toMatchObject({ x: 0.927, y: 0.094 });
    expect(send.mock.calls[2]![1].x).toBeCloseTo(0.073);
    expect(send.mock.calls[2]![1].y).toBeCloseTo(0.906);
    expect(readRotation).toHaveBeenCalledTimes(2);
  });

  it("keeps one orientation through an entire swipe, including the final Move and Up", async () => {
    send.mockImplementationOnce(async () => {
      readRotation.mockResolvedValue(3);
      return {};
    });
    await gestureSwipeTool.execute(services, {
      udid,
      fromX: 0.1,
      fromY: 0.8,
      toX: 0.9,
      toY: 0.2,
      durationMs: 32,
    });
    const commands = send.mock.calls.map(([, cmd]) => cmd);
    expect(commands.map((cmd) => cmd.type)).toEqual(["Down", "Move", "Move", "Up"]);
    expect(commands[0]!.x).toBeCloseTo(0.2);
    expect(commands[0]!.y).toBeCloseTo(0.1);
    for (const cmd of commands.slice(-2)) {
      expect(cmd.x).toBeCloseTo(0.8);
      expect(cmd.y).toBeCloseTo(0.9);
    }
    expect(readRotation).toHaveBeenCalledOnce();
  });

  it("converts both fingers in custom gestures", async () => {
    await gestureCustomTool.execute(services, {
      udid,
      events: [
        { type: "Down", x: 0.1, y: 0.8, x2: 0.9, y2: 0.2, delayMs: 0 },
        { type: "Up", x: 0.1, y: 0.8, x2: 0.9, y2: 0.2, delayMs: 0 },
      ],
    });
    for (const [, cmd] of send.mock.calls) {
      expect(cmd.x).toBeCloseTo(0.2);
      expect(cmd.y).toBeCloseTo(0.1);
      expect(cmd.second_x).toBeCloseTo(0.8);
      expect(cmd.second_y).toBeCloseTo(0.9);
    }
  });

  it("converts a pinch's two-finger path", async () => {
    await gesturePinchTool.execute(services, {
      udid,
      centerX: 0.3,
      centerY: 0.8,
      startDistance: 0.2,
      endDistance: 0.4,
      durationMs: 32,
    });
    const commands = send.mock.calls.map(([, cmd]) => cmd);
    expect(commands[0]!.y).toBeCloseTo(0.2);
    expect(commands[0]!.second_y).toBeCloseTo(0.4);
    expect(commands.at(-1)!.y).toBeCloseTo(0.1);
    expect(commands.at(-1)!.second_y).toBeCloseTo(0.5);
    for (const cmd of commands) {
      expect(cmd.x).toBeCloseTo(0.2);
      expect(cmd.second_x).toBeCloseTo(0.2);
    }
  });

  it("converts a two-finger rotation gesture", async () => {
    await gestureRotateTool.execute(services, {
      udid,
      centerX: 0.3,
      centerY: 0.6,
      radius: 0.1,
      startAngle: 0,
      endAngle: 90,
      durationMs: 32,
    });
    const first = send.mock.calls[0]![1];
    const last = send.mock.calls.at(-1)![1];
    expect(first.x).toBeCloseTo(0.4);
    expect(first.y).toBeCloseTo(0.4);
    expect(first.second_x).toBeCloseTo(0.4);
    expect(first.second_y).toBeCloseTo(0.2);
    expect(last.x).toBeCloseTo(0.3);
    expect(last.y).toBeCloseTo(0.3);
    expect(last.second_x).toBeCloseTo(0.5);
    expect(last.second_y).toBeCloseTo(0.3);
  });

  it("preserves a backend rejection instead of reporting a successful tap", async () => {
    send.mockRejectedValue(new Error("device rejected touch"));
    await expect(gestureTapTool.execute(services, { udid, x: 0.1, y: 0.8 })).rejects.toThrow(
      "device rejected touch"
    );
    expect(send).toHaveBeenCalledOnce();
  });

  it("preserves backend warnings through the shared sender", async () => {
    send.mockResolvedValue({ warning: "cover panel fallback" });
    await expect(gestureTapTool.execute(services, { udid, x: 0.1, y: 0.8 })).resolves.toMatchObject(
      {
        warning: "cover panel fallback",
      }
    );
  });

  it("refuses to guess when the physical device rotation cannot be read", async () => {
    readRotation.mockResolvedValue(null);
    const signal = await gestureTapTool.execute(services, { udid, x: 0.1, y: 0.8 }).then(
      () => null,
      (error: unknown) => getFailureSignal(error)
    );
    expect(signal).toMatchObject({ error_code: FAILURE_CODES.ANDROID_TOUCH_ROTATION_UNAVAILABLE });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    "emulator-5554",
    "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
    "remote:AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
  ])("keeps the existing backend coordinates for %s", async (id) => {
    const touch = await createTouchSender(api, resolveDevice(id));
    await touch("Down", 0.13, 0.79, 0.89, 0.21);
    expect(readRotation).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(api, {
      cmd: "touch",
      type: "Down",
      x: 0.13,
      y: 0.79,
      second_x: 0.89,
      second_y: 0.21,
    });
  });
});
