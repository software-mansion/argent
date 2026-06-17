import { TypedEventEmitter } from "@argent/registry";
import type { CDPClient } from "../utils/debugger/cdp-client";
import { connectCdp, enableCoreDomains } from "./cdp-session";
import { ClipboardSyncState, setClipboardText } from "./clipboard";
import { FpsTracker } from "./fps";
import { sendButton, sendKey, sendRotate, sendTouch, sendWheel, sendCharInsert } from "./input";
import { goBack, goForward, navigate, reload } from "./navigation";
import { ScreencastManager } from "./screencast";
import { captureScreenshot, copyScreenshotToClipboard } from "./screenshot";
import { createTabsManager } from "./tabs";
import { createNetworkManager } from "./network";
import type {
  ButtonType,
  ChromiumServer,
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

export { sendCharInsert } from "./input";

export interface CreateChromiumServerOpts {
  /** Argent device id, used for screenshot filename prefix + diagnostics. */
  deviceId: string;
  /** CDP port the Chromium process exposed via --remote-debugging-port. */
  port: number;
}

/**
 * Compose the per-device ChromiumServer. Connects CDP, primes core domains,
 * reads the initial viewport, and wires every subsystem (input, screenshot,
 * screencast, fps, clipboard, navigation, events) onto one CDP session.
 *
 * The returned `dispose()` tears down screencast first, then disconnects CDP —
 * leaving an active screencast running would emit phantom frame events after
 * the consumer dropped its ref.
 */
export async function createChromiumServer(
  opts: CreateChromiumServerOpts
): Promise<ChromiumServer> {
  const { cdp, wsUrl, target } = await connectCdp(opts.port);
  await enableCoreDomains(cdp);

  let viewport: ViewportSize = await readViewport(cdp);
  const events = new TypedEventEmitter<ServerEvents>();
  const fps = new FpsTracker(events);
  const screencast = new ScreencastManager(cdp, events, fps);
  const clipboardSync = new ClipboardSyncState();

  cdp.events.on("disconnected", (err) => {
    events.emit("terminated", err ?? new Error(`Chromium CDP on port ${opts.port} disconnected`));
  });

  // Network recording + request routing (Network/Fetch domains). Created before
  // `tabs` so a tab switch can re-attach it to the new page.
  const network = createNetworkManager({ cdp });

  // Multi-tab: the manager re-points `cdp` in place when the active tab
  // changes, so every page-scoped subsystem below (which captured `cdp`)
  // automatically follows. After a switch we re-prime the page's core domains,
  // refresh the cached viewport, and re-attach network recording/routes to the
  // new document.
  const tabs = createTabsManager({
    cdp,
    port: opts.port,
    initialTargetId: target.id,
    onActivated: async () => {
      await enableCoreDomains(cdp);
      viewport = await readViewport(cdp);
      await network.reattach();
    },
  });

  // Start passive request recording on the active page (capped ring buffer).
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
      // No native bridge today; record intent so a future Chromium-side helper
      // can wire it up. We still resolve so callers don't have to special-case
      // the not-yet-implemented path.
      clipboardSync.set(enabled);
    },
    setClipboardText: (text: string) => setClipboardText(cdp, text),
    startScreencast: (opts2?: ScreencastOpts): Promise<ScreencastSession> =>
      screencast.start(opts2),
    getLastFrame: (): ScreencastFrame | null => screencast.getLastFrame(),
    navigate: async (url: string) => {
      await navigate(cdp, url);
      // Refresh the cached viewport — a route swap can change layout dimensions
      // (responsive UIs, full-screen modal pages).
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

// Re-exported for use from the blueprint when we need a low-level CDP handle.
export { ensureCdpReachable, discoverPrimaryPage } from "./cdp-session";
export type { TabInfo, TabsManager } from "./tabs";
export type { NetworkManager, NetworkRequestRecord } from "./network";
export type { Cookie, SetCookieParams, DeleteCookieParams, StorageType } from "./storage";

// Re-exported so the http-api / blueprint can call them directly without
// pulling them out of a ChromiumServer instance.
export { setClipboardText } from "./clipboard";

// Internal re-export so tests can stub these without going through the full factory.
export type { CDPClient };
export { sendCharInsert as __sendCharInsert };
