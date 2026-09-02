import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { CDPClient } from "../utils/debugger/cdp-client";
import type { ButtonType, KeyDirection, Point, Rotation, TouchType, ViewportSize } from "./types";

function clampPx(value: number, max: number): number {
  if (!Number.isFinite(value)) {
    throw new FailureError(`Chromium input: non-finite coordinate ${value}`, {
      error_code: FAILURE_CODES.CHROMIUM_INPUT_INVALID,
      failure_stage: "chromium_input_coordinate",
      failure_area: "tool_server",
      error_kind: "validation",
    });
  }
  return Math.max(0, Math.min(max, value));
}

function toCssPixels(point: Point, viewport: ViewportSize): { x: number; y: number } {
  return {
    x: clampPx(point.x * viewport.width, viewport.width),
    y: clampPx(point.y * viewport.height, viewport.height),
  };
}

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

/** Only `Back` has a Chromium equivalent: Alt+Left walks the navigation history. */
export async function sendButton(
  cdp: CDPClient,
  button: ButtonType,
  direction: KeyDirection
): Promise<void> {
  if (button === "Back") {
    // Split across Down/Up to honour the caller's two-phase button contract.
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
  // Plain Error: the only caller is the WS `button` handler, which flattens it
  // into `{ status: "error", message }`, and the registered `button` tool
  // excludes chromium — a classified code would never reach telemetry.
  throw new Error(
    `Chromium does not support the "${button}" hardware button. ` +
      `Use a keyboard shortcut via the keyboard tool, or invoke an app-level handler via the debugger.`
  );
}

/** One wheel event; `dx`/`dy` are CSS pixels, unlike the normalized `point`. */
export async function sendWheel(
  cdp: CDPClient,
  viewport: ViewportSize,
  point: Point,
  dx: number,
  dy: number
): Promise<void> {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
    throw new FailureError(`Chromium wheel: non-finite delta dx=${dx}, dy=${dy}`, {
      error_code: FAILURE_CODES.CHROMIUM_INPUT_INVALID,
      failure_stage: "chromium_input_wheel_delta",
      failure_area: "tool_server",
      error_kind: "validation",
    });
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
