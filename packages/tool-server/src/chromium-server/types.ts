/**
 * Shared types for the Chromium server abstraction layer. Mirrors sim-server's
 * domain model so callers stay platform-agnostic; the adapters translate them
 * into CDP wire payloads.
 */

import type { TypedEventEmitter } from "@argent/registry";
import type { CDPClient } from "../utils/debugger/cdp-client";
import type { TabsManager } from "./tabs";
import type { NetworkManager } from "./network";

export type TouchType = "Down" | "Up" | "Move";
export type KeyDirection = "Down" | "Up";

export type ButtonType =
  | "Home"
  | "Back"
  | "Power"
  | "VolumeUp"
  | "VolumeDown"
  | "AppSwitch"
  | "ActionButton";

export type Rotation = "Portrait" | "PortraitUpsideDown" | "LandscapeLeft" | "LandscapeRight";

/** Normalized point: `x`/`y` in 0.0–1.0 of the viewport. Adapters convert to pixels. */
export interface Point {
  x: number;
  y: number;
}

/** Mirrors sim-server's wire enum. `lanczos3` is the highest-quality option,
 * `nearest` the cheapest; all are a no-op without the optional `sharp` dep
 * (see screenshot.ts). */
export type DownscalerType = "lanczos3" | "box" | "bilinear" | "nearest";

export interface ScreenshotOpts {
  /** Applied after capture. */
  rotation?: Rotation;
  /** Scale factor in (0, 1]; downscales the PNG before it is written to disk. */
  scale?: number;
  /** Algorithm used when `scale < 1`. */
  downscaler?: DownscalerType;
  /** Filename suffix; defaults to a timestamp. */
  id?: string;
}

export interface MediaReady {
  /** file:// form of `path`. */
  url: string;
  /** Absolute path on the tool-server host. */
  path: string;
  /**
   * Geometry the caller asked for that this capture could not apply — see
   * `dropReason` for why. The image is still returned; the tool turns this
   * into a note so the omission is visible to the caller rather than only on
   * stderr.
   */
  droppedFeatures?: ("rotation" | "scale")[];
  /**
   * Why `droppedFeatures` were dropped. `sharp-missing`: no transform ran at
   * all and installing `sharp` fixes it. `png-header-unreadable`: `sharp` IS
   * installed and a requested rotation still ran, but the resize could not be
   * sized from the capture's PNG header, so only the scale was lost.
   */
  dropReason?: "sharp-missing" | "png-header-unreadable";
}

export interface ViewportSize {
  width: number;
  height: number;
  /** Renderer-reported `window.devicePixelRatio`. */
  devicePixelRatio: number;
}

export interface ScreencastOpts {
  /** Defaults to "jpeg"; PNG frames are far larger over the WebSocket. */
  format?: "jpeg" | "png";
  /** JPEG quality, 0–100. Ignored for PNG. */
  quality?: number;
  /** Max frame width; CDP scales the image proportionally. */
  maxWidth?: number;
  maxHeight?: number;
  /** One frame per N rendered frames; default 1. */
  everyNthFrame?: number;
}

export interface ScreencastFrame {
  /** Echoed back in `Page.screencastFrameAck`. */
  sessionId: number;
  /** Base64-encoded image bytes. */
  data: string;
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
  /** Drops this caller's refcount; CDP emission stops with the last one. Safe to call twice. */
  stop(): Promise<void>;
}

export interface FpsReport {
  /** Frames received in the last window. */
  fps: number;
  windowMs: number;
}

export type ServerEvents = {
  /** Fan-out so the MJPEG relay, the WS bridge and internal listeners share one
   * CDP screencast session. */
  frame: (frame: ScreencastFrame) => void;
  /** Emitted while FPS reporting is enabled. */
  fpsReport: (report: FpsReport) => void;
  /** Emitted on CDP disconnect; consumers should drop their refs. */
  terminated: (error?: Error) => void;
};

/**
 * Public Chromium-server contract. The blueprint resolves an instance per
 * device id; tools and HTTP routers consume it.
 */
export interface ChromiumServer {
  /** CDP port, parsed out of the `chromium-cdp-<port>` device id. */
  readonly port: number;
  /** Connected to the primary page target. */
  readonly cdp: CDPClient;
  readonly pageWebSocketUrl: string;
  /** Cached; does not hit the renderer. */
  getViewport(): ViewportSize;
  /** Re-read from the renderer, e.g. after a window resize. */
  refreshViewport(): Promise<ViewportSize>;
  /** Capture, optionally rotate / downscale, persist a PNG. */
  captureScreenshot(opts?: ScreenshotOpts): Promise<MediaReady>;
  /** Fresh capture, written through the renderer's Clipboard API. */
  copyScreenshotToClipboard(opts?: { rotation?: Rotation }): Promise<void>;
  /** Points are normalized 0–1; `secondPoint` makes it multi-touch. */
  sendTouch(touchType: TouchType, point: Point, secondPoint?: Point | null): Promise<void>;
  sendKey(
    direction: KeyDirection,
    key: { code?: number; key?: string; text?: string; codeName?: string }
  ): Promise<void>;
  /** Only `Back` has a Chromium equivalent; every other button throws. */
  sendButton(button: ButtonType, direction: KeyDirection): Promise<void>;
  /** Via Emulation.setDeviceMetricsOverride. */
  sendRotate(direction: Rotation): Promise<void>;
  /** `dx`/`dy` are CSS pixels, unlike the normalized `point`. */
  sendWheel(point: Point, dx: number, dy: number): Promise<void>;
  /** Records the intent only; no native bridge exists yet. */
  setClipboardSync(enabled: boolean): Promise<void>;
  /** Writes through the renderer's Clipboard API. */
  setClipboardText(text: string): Promise<void>;
  /** Frames arrive on the `frame` event; callers share one refcounted CDP session. */
  startScreencast(opts?: ScreencastOpts): Promise<ScreencastSession>;
  getLastFrame(): ScreencastFrame | null;
  navigate(url: string): Promise<void>;
  reload(): Promise<void>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  /** Toggles periodic `fpsReport` emissions. */
  setFpsReporting(enabled: boolean): void;
  /** In the renderer's main world. */
  evaluate(expression: string, options?: { returnByValue?: boolean }): Promise<unknown>;
  /** The active tab is the one `cdp` (and every page-scoped tool) is connected
   * to; switching re-points `cdp` in place. */
  readonly tabs: TabsManager;
  /** Passive CDP request recording for the active page, capped ring buffer. */
  readonly network: NetworkManager;
  readonly events: TypedEventEmitter<ServerEvents>;
  /** Stops the screencast and disconnects CDP. */
  dispose(): Promise<void>;
}
