import { TypedEventEmitter } from "@argent/registry";
import { connectCdp, primePageSession } from "./cdp-session";
import { ClipboardSyncState, setClipboardText } from "./clipboard";
import { FpsTracker } from "./fps";
import { sendButton, sendKey, sendRotate, sendTouch, sendWheel } from "./input";
import { goBack, goForward, navigate, reload } from "./navigation";
import { ScreencastManager } from "./screencast";
import { captureScreenshot, copyScreenshotToClipboard } from "./screenshot";
import { createTabsManager } from "./tabs";
import { createNetworkManager } from "./network";
import type {
  ButtonType,
  ChromiumServer,
  KeyDirection,
  Point,
  Rotation,
  ScreencastFrame,
  ScreencastOpts,
  ScreencastSession,
  ScreenshotOpts,
  ServerEvents,
  TouchType,
  ViewportSize,
} from "./types";
import { readViewport } from "./viewport";

export type {
  ButtonType,
  DownscalerType,
  ChromiumServer,
  FpsReport,
  KeyDirection,
  MediaReady,
  Point,
  Rotation,
  ScreencastFrame,
  ScreencastOpts,
  ScreencastSession,
  ScreenshotOpts,
  ServerEvents,
  TouchType,
  ViewportSize,
} from "./types";

interface CreateChromiumServerOpts {
  /** Argent device id; screenshot filename prefix. */
  deviceId: string;
  /** CDP port from the Chromium process's --remote-debugging-port. */
  port: number;
}

/** Compose the per-device ChromiumServer; every subsystem shares one CDP session. */
export async function createChromiumServer(
  opts: CreateChromiumServerOpts
): Promise<ChromiumServer> {
  const { cdp, wsUrl, target } = await connectCdp(opts.port);
  await primePageSession(cdp);

  let viewport: ViewportSize = await readViewport(cdp);
  const events = new TypedEventEmitter<ServerEvents>();
  const fps = new FpsTracker(events);
  const screencast = new ScreencastManager(cdp, events, fps);
  const clipboardSync = new ClipboardSyncState();

  cdp.events.on("disconnected", (err) => {
    events.emit("terminated", err ?? new Error(`Chromium CDP on port ${opts.port} disconnected`));
  });

  // Declared before `tabs` so a tab switch can re-attach it to the new page.
  const network = createNetworkManager({ cdp });

  // The manager re-points `cdp` in place on a tab switch, so every subsystem
  // that captured `cdp` follows the new page automatically.
  const tabs = createTabsManager({
    cdp,
    port: opts.port,
    initialTargetId: target.id,
    onActivated: async () => {
      await primePageSession(cdp);
      viewport = await readViewport(cdp);
      await network.reattach();
    },
  });

  // Also the initial attach: starts recording on the active page.
  await network.reattach();

  const server: ChromiumServer = {
    port: opts.port,
    cdp,
    pageWebSocketUrl: wsUrl,
    network,
    getViewport: () => viewport,
    refreshViewport: async () => {
      viewport = await readViewport(cdp);
      return viewport;
    },
    captureScreenshot: (opts2?: ScreenshotOpts) =>
      captureScreenshot({ cdp, deviceId: opts.deviceId }, opts2),
    copyScreenshotToClipboard: (opts2?: { rotation?: Rotation }) =>
      copyScreenshotToClipboard({ cdp, deviceId: opts.deviceId }, opts2),
    sendTouch: (touchType: TouchType, point: Point, secondPoint?: Point | null) =>
      sendTouch(cdp, viewport, touchType, point, secondPoint),
    sendKey: (direction, key) => sendKey(cdp, direction, key),
    sendButton: (button: ButtonType, direction: KeyDirection) => sendButton(cdp, button, direction),
    sendRotate: (direction: Rotation) => sendRotate(cdp, viewport, direction),
    sendWheel: (point: Point, dx: number, dy: number) => sendWheel(cdp, viewport, point, dx, dy),
    setClipboardSync: async (enabled: boolean) => {
      // No native bridge yet, and nothing records the flag either — `set` is
      // empty, by the reasoning in `ClipboardSyncState`'s own docstring. What
      // this buys is that the call resolves, so the WS `clipboardSync` route
      // needs no not-yet-implemented branch.
      clipboardSync.set(enabled);
    },
    setClipboardText: (text: string) => setClipboardText(cdp, text),
    startScreencast: (opts2?: ScreencastOpts): Promise<ScreencastSession> =>
      screencast.start(opts2),
    getLastFrame: (): ScreencastFrame | null => screencast.getLastFrame(),
    navigate: async (url: string) => {
      await navigate(cdp, url);
      // A route swap can change layout dimensions.
      try {
        viewport = await readViewport(cdp);
      } catch {
        /* viewport read can race a still-loading page; leave the cached one */
      }
    },
    reload: () => reload(cdp),
    goBack: async () => {
      await goBack(cdp);
    },
    goForward: async () => {
      await goForward(cdp);
    },
    setFpsReporting: (enabled: boolean) => fps.setEnabled(enabled),
    tabs,
    evaluate: async (
      expression: string,
      options?: { returnByValue?: boolean }
    ): Promise<unknown> => {
      if (options?.returnByValue) {
        const out = (await cdp.send(
          "Runtime.evaluate",
          { expression, returnByValue: true },
          10_000
        )) as { result?: { value?: unknown } };
        return out.result?.value;
      }
      return cdp.evaluate(expression, { timeout: 10_000 });
    },
    events,
    dispose: async () => {
      try {
        await screencast.forceStop();
      } catch {
        /* ignore */
      }
      fps.dispose();
      network.dispose();
      try {
        await cdp.disconnect();
      } catch {
        /* ignore */
      }
    },
  };
  return server;
}

// Consumed by the chromium-cdp blueprint.
export { ensureCdpReachable, discoverPrimaryPage } from "./cdp-session";
export type { TabInfo, TabsManager } from "./tabs";
export type { NetworkManager, NetworkRequestRecord } from "./network";

export { setClipboardText } from "./clipboard";
