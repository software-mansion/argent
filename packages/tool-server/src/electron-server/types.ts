/**
 * Shared types for the Electron server abstraction layer. Mirrors the
 * sim-server's domain model (Touch / Button / Rotate / Wheel) so callers can be
 * written against a single conceptual surface regardless of platform — the
 * adapter layer translates them into CDP wire payloads.
 */

import type { TypedEventEmitter } from "@argent/registry";
import type { CDPClient } from "../utils/debugger/cdp-client";

export type TouchType = "Down" | "Up" | "Move";
export type KeyDirection = "Down" | "Up";

/** Sim-server's hardware buttons. iOS/Android map to OS-level events; on
 * Electron most are inert — only ones that correspond to keyboard chords (Home,
 * Back via browser-history, AppSwitch ≈ Cmd-Tab) are best-effort implemented.
 */
export type ButtonType =
  | "Home"
  | "Back"
  | "Power"
  | "VolumeUp"
  | "VolumeDown"
  | "AppSwitch"
  | "ActionButton";

export type Rotation = "Portrait" | "PortraitUpsideDown" | "LandscapeLeft" | "LandscapeRight";

/** Sim-server-style normalized point: `x` and `y` in 0.0–1.0, fractions of the
 * device screen / page viewport. Pixel conversion happens inside each adapter. */
export interface Point {
  x: number;
  y: number;
}

/** Downscaler choice. Mirrors sim-server's wire enum so callers don't need to
 * relearn names. `lanczos3` is the highest-quality option, `nearest` the
 * cheapest. All variants degrade to a no-op if the optional `sharp` dep isn't
 * installed (see screenshot.ts). */
export type DownscalerType = "lanczos3" | "box" | "bilinear" | "nearest";

export interface ScreenshotOpts {
  /** Optional rotation applied AFTER capture (CSS pixels). */
  rotation?: Rotation;
  /** Scale factor in (0, 1]. <1 downscales the PNG before writing to disk. */
  scale?: number;
  /** Algorithm used when `scale < 1`. Ignored otherwise. */
  downscaler?: DownscalerType;
  /** Output filename stem (without extension). When omitted, a timestamp is used. */
  id?: string;
}

export interface MediaReady {
  /** file:// URL that resolves to `path`. Tools surface this to agents. */
  url: string;
  /** Absolute path on the tool-server host. */
  path: string;
}

export interface ViewportSize {
  width: number;
  height: number;
  /** Renderer-reported DPR; used to convert CDP screencast frame px → viewport px. */
  devicePixelRatio: number;
}

export interface ScreencastOpts {
  /** "jpeg" is what every consumer expects; PNG is supported by CDP but
   * inflates frame size 5–10× and saturates the WebSocket. */
  format?: "jpeg" | "png";
  /** JPEG quality, 0–100. Ignored for PNG. */
  quality?: number;
  /** Optional max frame width; CDP scales the image proportionally. */
  maxWidth?: number;
  /** Optional max frame height. */
  maxHeight?: number;
  /** Send one frame per N rendered frames. Default 1. */
  everyNthFrame?: number;
}

export interface ScreencastFrame {
  /** Sequential frame id, used for the screencast ack. */
  sessionId: number;
  /** Base64-encoded image bytes. */
  data: string;
  /** Metadata reported by CDP — viewport offset, scale, timestamp. */
  metadata: {
    offsetTop: number;
    pageScaleFactor: number;
    deviceWidth: number;
    deviceHeight: number;
    scrollOffsetX: number;
    scrollOffsetY: number;
    timestamp?: number;
  };
}

export interface ScreencastSession {
  /** Disposes the screencast — stops CDP screencast emission and removes listeners. */
  stop(): Promise<void>;
}

export interface FpsReport {
  /** Frames received in the last interval. */
  fps: number;
  /** Window size in ms. */
  windowMs: number;
}

export type ServerEvents = {
  /** Each emitted screencast frame is forwarded here so multiple consumers
   * (MJPEG endpoint + internal listeners) share one CDP screencast session. */
  frame: (frame: ScreencastFrame) => void;
  /** Periodic FPS report when reporting is enabled. */
  fpsReport: (report: FpsReport) => void;
  /** Terminated by CDP disconnect; consumers should drop their refs. */
  terminated: (error?: Error) => void;
};

/**
 * Public Electron-server contract. The blueprint resolves an instance per
 * device id; tools and HTTP routers consume it.
 */
export interface ElectronServer {
  /** CDP port the Electron process is exposing (extracted from device.id). */
  readonly port: number;
  /** Underlying CDP client connected to the primary page target. */
  readonly cdp: CDPClient;
  /** ws:// URL to the page target — handy for diagnostics. */
  readonly pageWebSocketUrl: string;
  /** Cached viewport from the most recent connect / refresh. */
  getViewport(): ViewportSize;
  /** Re-read viewport from the renderer. Call after window resize / nav. */
  refreshViewport(): Promise<ViewportSize>;
  /** Capture + (optionally) rotate + downscale + persist a PNG. */
  captureScreenshot(opts?: ScreenshotOpts): Promise<MediaReady>;
  /** Copy the most recent or freshly-captured frame to the OS clipboard as an image. */
  copyScreenshotToClipboard(opts?: { rotation?: Rotation }): Promise<void>;
  /** Touch event. `point` is normalized 0–1. `secondPoint` is for multi-touch. */
  sendTouch(touchType: TouchType, point: Point, secondPoint?: Point | null): Promise<void>;
  /** Press / release a single key (USB HID code or browser-style key). */
  sendKey(
    direction: KeyDirection,
    key: { code?: number; key?: string; text?: string; codeName?: string }
  ): Promise<void>;
  /** Hardware button. Best-effort on Electron; throws "not supported" for
   * buttons with no browser equivalent. */
  sendButton(button: ButtonType, direction: KeyDirection): Promise<void>;
  /** Rotate the viewport. Uses Emulation.setDeviceMetricsOverride. */
  sendRotate(direction: Rotation): Promise<void>;
  /** Wheel scroll at a point. dx/dy are CSS pixels. */
  sendWheel(point: Point, dx: number, dy: number): Promise<void>;
  /** Subscribe to OS clipboard → page bridge. No-op stub for now. */
  setClipboardSync(enabled: boolean): Promise<void>;
  /** Programmatically set the renderer's clipboard text via DOM APIs. */
  setClipboardText(text: string): Promise<void>;
  /** Start a CDP screencast. Frames are forwarded to `events.on("frame", ...)`
   * and to any consumer subscribed via `onFrame`. Multiple callers share one
   * CDP session via internal refcounting. */
  startScreencast(opts?: ScreencastOpts): Promise<ScreencastSession>;
  /** Returns the most recently received screencast frame, if any. */
  getLastFrame(): ScreencastFrame | null;
  /** Navigate the renderer. */
  navigate(url: string): Promise<void>;
  reload(): Promise<void>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  /** Enable / disable periodic `fpsReport` emissions on `events`. */
  setFpsReporting(enabled: boolean): void;
  /** Evaluate JS in the renderer's main world. */
  evaluate(expression: string, options?: { returnByValue?: boolean }): Promise<unknown>;
  /** Event bus mirroring sim-server's broadcast channel. */
  readonly events: TypedEventEmitter<ServerEvents>;
  /** Tear down — closes CDP, stops screencast, removes listeners. */
  dispose(): Promise<void>;
}
