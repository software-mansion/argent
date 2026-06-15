import { describe, it, expect, vi } from "vitest";
import {
  sendButton,
  sendKey,
  sendRotate,
  sendTouch,
  sendWheel,
} from "../src/chromium-server/input";
import type { CDPClient } from "../src/utils/debugger/cdp-client";

function stubCdp() {
  const send = vi.fn().mockResolvedValue({});
  return { send } as unknown as CDPClient;
}

const viewport = { width: 800, height: 600, devicePixelRatio: 1 };

describe("chromium-server/input", () => {
  describe("sendTouch", () => {
    it("converts a normalized Down to mousePressed at CSS pixels", async () => {
      const cdp = stubCdp();
      await sendTouch(cdp, viewport, "Down", { x: 0.5, y: 0.25 });
      const send = (cdp as unknown as { send: ReturnType<typeof vi.fn> }).send;
      expect(send).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: 400,
        y: 150,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
    });

    it("converts an Up to mouseReleased", async () => {
      const cdp = stubCdp();
      await sendTouch(cdp, viewport, "Up", { x: 0, y: 1 });
      const send = (cdp as unknown as { send: ReturnType<typeof vi.fn> }).send;
      const call = send.mock.calls[0]!;
      expect(call[0]).toBe("Input.dispatchMouseEvent");
      expect((call[1] as Record<string, unknown>).type).toBe("mouseReleased");
      expect((call[1] as Record<string, unknown>).x).toBe(0);
      expect((call[1] as Record<string, unknown>).y).toBe(600);
    });

    it("Move uses mouseMoved with button none / buttons 0", async () => {
      const cdp = stubCdp();
      await sendTouch(cdp, viewport, "Move", { x: 0.5, y: 0.5 });
      const send = (cdp as unknown as { send: ReturnType<typeof vi.fn> }).send;
      const payload = send.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(payload.type).toBe("mouseMoved");
      expect(payload.button).toBe("none");
      expect(payload.buttons).toBe(0);
      // mouseMoved must NOT carry clickCount — CDP ignores it but the
      // sim-server-style payload should remain minimal.
      expect("clickCount" in payload).toBe(false);
    });

    it("multi-touch uses Input.dispatchTouchEvent", async () => {
      const cdp = stubCdp();
      await sendTouch(cdp, viewport, "Down", { x: 0.2, y: 0.3 }, { x: 0.7, y: 0.8 });
      const send = (cdp as unknown as { send: ReturnType<typeof vi.fn> }).send;
      const call = send.mock.calls[0]!;
      expect(call[0]).toBe("Input.dispatchTouchEvent");
      const payload = call[1] as { type: string; touchPoints: Array<{ x: number; y: number }> };
      expect(payload.type).toBe("touchStart");
      expect(payload.touchPoints).toHaveLength(2);
      expect(payload.touchPoints[0]?.x).toBe(160);
      expect(payload.touchPoints[1]?.x).toBe(560);
    });

    it("throws for non-finite coordinates", async () => {
      const cdp = stubCdp();
      await expect(sendTouch(cdp, viewport, "Down", { x: Number.NaN, y: 0.5 })).rejects.toThrow(
        /non-finite/i
      );
    });

    it("clamps out-of-range normalized coords", async () => {
      const cdp = stubCdp();
      await sendTouch(cdp, viewport, "Down", { x: 5, y: -1 });
      const send = (cdp as unknown as { send: ReturnType<typeof vi.fn> }).send;
      const payload = send.mock.calls[0]?.[1] as { x: number; y: number };
      expect(payload.x).toBe(viewport.width);
      expect(payload.y).toBe(0);
    });
  });

  describe("sendWheel", () => {
    it("forwards dx/dy as mouseWheel deltas", async () => {
      const cdp = stubCdp();
      await sendWheel(cdp, viewport, { x: 0.5, y: 0.5 }, 10, -25);
      const send = (cdp as unknown as { send: ReturnType<typeof vi.fn> }).send;
      const payload = send.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(payload.type).toBe("mouseWheel");
      expect(payload.deltaX).toBe(10);
      expect(payload.deltaY).toBe(-25);
    });

    it("rejects non-finite deltas", async () => {
      const cdp = stubCdp();
      await expect(sendWheel(cdp, viewport, { x: 0, y: 0 }, Infinity, 0)).rejects.toThrow(
        /non-finite/i
      );
    });

    it("noops a zero-delta wheel without sending", async () => {
      const cdp = stubCdp();
      await sendWheel(cdp, viewport, { x: 0.5, y: 0.5 }, 0, 0);
      const send = (cdp as unknown as { send: ReturnType<typeof vi.fn> }).send;
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe("sendKey", () => {
    it("threads key/code/text/vk into Input.dispatchKeyEvent", async () => {
      const cdp = stubCdp();
      await sendKey(cdp, "Down", { key: "a", codeName: "KeyA", text: "a", code: 65 });
      const send = (cdp as unknown as { send: ReturnType<typeof vi.fn> }).send;
      expect(send).toHaveBeenCalledWith("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "a",
        code: "KeyA",
        text: "a",
        windowsVirtualKeyCode: 65,
      });
    });
  });

  describe("sendButton", () => {
    it("Back maps to Alt+ArrowLeft", async () => {
      const cdp = stubCdp();
      await sendButton(cdp, "Back", "Down");
      const send = (cdp as unknown as { send: ReturnType<typeof vi.fn> }).send;
      expect(send.mock.calls.length).toBe(2);
      expect((send.mock.calls[0]?.[1] as Record<string, unknown>).key).toBe("Alt");
      expect((send.mock.calls[1]?.[1] as Record<string, unknown>).key).toBe("ArrowLeft");
    });

    it("Home throws — no browser equivalent", async () => {
      const cdp = stubCdp();
      await expect(sendButton(cdp, "Home", "Down")).rejects.toThrow(/does not support/);
    });

    it("Power / Volume / AppSwitch all throw", async () => {
      const cdp = stubCdp();
      for (const btn of ["Power", "VolumeUp", "VolumeDown", "AppSwitch", "ActionButton"] as const) {
        await expect(sendButton(cdp, btn, "Down")).rejects.toThrow(/does not support/);
      }
    });
  });

  describe("sendRotate", () => {
    it("sets device-metrics override with the expected angle", async () => {
      const cdp = stubCdp();
      await sendRotate(cdp, viewport, "LandscapeRight");
      const send = (cdp as unknown as { send: ReturnType<typeof vi.fn> }).send;
      const payload = send.mock.calls[0]?.[1] as {
        screenOrientation: { angle: number; type: string };
      };
      expect(payload.screenOrientation.angle).toBe(90);
      expect(payload.screenOrientation.type).toBe("landscapePrimary");
    });
  });
});
