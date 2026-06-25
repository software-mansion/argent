import type { CDPClient } from "../utils/debugger/cdp-client";
import type { ButtonType, KeyDirection, Point, Rotation, TouchType, ViewportSize } from "./types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function clampPx(value: number, max: number): number {
  if (!Number.isFinite(value)) {
    throw new Error(`Chromium input: non-finite coordinate ${value}`);
  }
  return Math.max(0, Math.min(max, value));
}

function toCssPixels(point: Point, viewport: ViewportSize): { x: number; y: number } {
  return {
    x: clampPx(point.x * viewport.width, viewport.width),
    y: clampPx(point.y * viewport.height, viewport.height),
  };
}

/**
 * Forward a sim-server-style touch into a CDP mouse event. Single-touch is
 * trivial; multi-touch (secondPoint) maps to `Input.dispatchTouchEvent` which
 * Chromium supports for emulated mobile.
 */
export async function sendTouch(
  cdp: CDPClient,
  viewport: ViewportSize,
  touchType: TouchType,
  point: Point,
  secondPoint?: Point | null
): Promise<void> {
  const primary = toCssPixels(point, viewport);

  if (secondPoint) {
    const secondary = toCssPixels(secondPoint, viewport);
    const touchPoints = [
      { x: primary.x, y: primary.y, id: 1 },
      { x: secondary.x, y: secondary.y, id: 2 },
    ];
    const type =
      touchType === "Down" ? "touchStart" : touchType === "Up" ? "touchEnd" : "touchMove";
    await cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd" ? [] : touchPoints,
    });
    return;
  }

  const cdpType =
    touchType === "Down" ? "mousePressed" : touchType === "Up" ? "mouseReleased" : "mouseMoved";
  const button = cdpType === "mouseMoved" ? "none" : "left";
  const buttons = button === "none" ? 0 : 1;
  const payload: Record<string, unknown> = {
    type: cdpType,
    x: primary.x,
    y: primary.y,
    button,
    buttons,
  };
  if (cdpType !== "mouseMoved") {
    payload.clickCount = 1;
  }
  await cdp.send("Input.dispatchMouseEvent", payload);
}

/**
 * Forward a key event. The contract is union-style: callers can pass a
 * USB HID code (matches the sim-server protocol) OR a browser-style descriptor
 * (`key`, `text`, `codeName`). Most callers in the tool-server use the
 * browser-style fields because translating HID → DOM keycodes is lossy.
 */
export async function sendKey(
  cdp: CDPClient,
  direction: KeyDirection,
  desc: { code?: number; key?: string; text?: string; codeName?: string }
): Promise<void> {
  const type = direction === "Down" ? "keyDown" : "keyUp";
  const payload: Record<string, unknown> = { type };
  if (desc.key !== undefined) payload.key = desc.key;
  if (desc.codeName !== undefined) payload.code = desc.codeName;
  if (desc.text !== undefined) payload.text = desc.text;
  if (desc.code !== undefined) payload.windowsVirtualKeyCode = desc.code;
  await cdp.send("Input.dispatchKeyEvent", payload);
}

/**
 * Send a CDP key event AND, when typing a printable character with `Down`,
 * also dispatch a `char` event so the renderer actually receives the
 * codepoint in focused inputs. Sim-server callers expect typing to "just
 * work"; the bare keyDown alone doesn't insert text in modern Chromium.
 */
export async function sendCharInsert(cdp: CDPClient, text: string): Promise<void> {
  await cdp.send("Input.dispatchKeyEvent", { type: "char", text });
}

/**
 * Best-effort hardware-button translation. Only `Back` has a sane
 * desktop-renderer equivalent (Alt+Left to walk navigation history). The
 * others throw; callers that rely on them on Chromium should switch to a
 * dedicated tool.
 */
export async function sendButton(
  cdp: CDPClient,
  button: ButtonType,
  direction: KeyDirection
): Promise<void> {
  if (button === "Back") {
    // Single keystroke composite: Alt+Left. We only send the modified key on
    // Down and the release on Up to match sim-server's two-phase contract.
    if (direction === "Down") {
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Alt",
        code: "AltLeft",
        windowsVirtualKeyCode: 18,
        modifiers: 1,
      });
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "ArrowLeft",
        code: "ArrowLeft",
        windowsVirtualKeyCode: 37,
        modifiers: 1,
      });
    } else {
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "ArrowLeft",
        code: "ArrowLeft",
        windowsVirtualKeyCode: 37,
        modifiers: 1,
      });
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Alt",
        code: "AltLeft",
        windowsVirtualKeyCode: 18,
      });
    }
    return;
  }
  throw new Error(
    `Chromium does not support the "${button}" hardware button. ` +
      `Use a keyboard shortcut via the keyboard tool, or invoke an app-level handler via the debugger.`
  );
}

/**
 * Wheel scroll at a point. CDP's mouseWheel event accepts deltaX / deltaY in
 * CSS pixels. We forward as a single event — sim-server's multi-step ramp is
 * only useful for native gesture simulation, which Chromium doesn't expose.
 */
export async function sendWheel(
  cdp: CDPClient,
  viewport: ViewportSize,
  point: Point,
  dx: number,
  dy: number
): Promise<void> {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
    throw new Error(`Chromium wheel: non-finite delta dx=${dx}, dy=${dy}`);
  }
  if (dx === 0 && dy === 0) return;
  const pixel = toCssPixels(point, viewport);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: pixel.x,
    y: pixel.y,
    button: "none",
    buttons: 0,
    deltaX: dx,
    deltaY: dy,
  });
}

/**
 * Rotate the viewport via Emulation.setDeviceMetricsOverride. Chromium only
 * supports rotation values of 0 / 90 / 180 / 270, applied as a CSS transform
 * around the page centre. We persist the current rotation so it can be
 * read back via getRotation().
 */
const ROTATION_DEGREES: Record<Rotation, 0 | 90 | 180 | 270> = {
  Portrait: 0,
  LandscapeLeft: 270,
  LandscapeRight: 90,
  PortraitUpsideDown: 180,
};

export async function sendRotate(
  cdp: CDPClient,
  viewport: ViewportSize,
  direction: Rotation
): Promise<void> {
  const angle = ROTATION_DEGREES[direction];
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.devicePixelRatio,
    mobile: false,
    screenOrientation: {
      type:
        direction === "Portrait"
          ? "portraitPrimary"
          : direction === "PortraitUpsideDown"
            ? "portraitSecondary"
            : direction === "LandscapeLeft"
              ? "landscapeSecondary"
              : "landscapePrimary",
      angle,
    },
  });
}

// Re-exported for tests + downstream callers that want to convert without
// duplicating the math.
export const __test = { toCssPixels, clampPx, sleep };
