import {
  FAILURE_CODES,
  FailureError,
  TypedEventEmitter,
  type DeviceInfo,
  type ServiceBlueprint,
  type ServiceEvents,
  type ServiceInstance,
} from "@argent/registry";
import type { CDPClient } from "../utils/debugger/cdp-client";
import {
  createChromiumServer,
  discoverPrimaryPage,
  ensureCdpReachable,
  type ChromiumServer,
  type MediaReady,
  type ScreencastFrame,
  type ScreencastOpts,
  type ScreencastSession,
  type ScreenshotOpts,
} from "../chromium-server";
import { parseChromiumCdpPort, resolveDevice } from "../utils/device-info";

export const CHROMIUM_CDP_NAMESPACE = "ChromiumCdp";

type ChromiumFactoryOptions = Record<string, unknown> & { device: DeviceInfo };

/**
 * `ServiceRef` for a Chromium CDP session. Preferred over hand-building the URN:
 * it also carries the resolved `DeviceInfo` through the registry's `options`
 * channel, so the factory never has to reclassify the id.
 */
export function chromiumCdpRef(device: DeviceInfo): {
  urn: string;
  options: ChromiumFactoryOptions;
} {
  return {
    urn: `${CHROMIUM_CDP_NAMESPACE}:${device.id}`,
    options: { device },
  };
}

// `ChromiumServer` is the source of truth, but the blueprint keeps publishing
// the original `ChromiumCdpApi` shape too so tools can migrate one at a time.

export interface MouseEventArgs {
  type: "mousePressed" | "mouseReleased" | "mouseMoved";
  /** CSS pixels relative to the page viewport. */
  x: number;
  y: number;
  button?: "none" | "left" | "middle" | "right";
  clickCount?: number;
}

export interface KeyEventArgs {
  type: "keyDown" | "keyUp" | "rawKeyDown" | "char";
  /** Browser-style key value, e.g. "a", "Enter", "ArrowLeft". */
  key?: string;
  code?: string;
  text?: string;
  /** DOM keyCode (deprecated but still consumed by many apps). */
  windowsVirtualKeyCode?: number;
  modifiers?: number;
}

export interface ViewportSize {
  width: number;
  height: number;
  /** Renderer-reported `window.devicePixelRatio`. */
  devicePixelRatio: number;
}

export interface ChromiumAxNode {
  nodeId: string;
  role?: string;
  name?: string;
  value?: string;
  description?: string;
  ignored?: boolean;
  backendDOMNodeId?: number;
  childIds?: string[];
  properties?: Array<{ name: string; value: { value?: unknown; type: string } }>;
}

export interface ChromiumCdpApi {
  /** CDP port the Chromium app exposed. */
  port: number;
  /** Underlying CDP client connected to the primary page target. */
  cdp: CDPClient;
  /** WebSocket URL to the page target (for diagnostics). */
  pageWebSocketUrl: string;
  rootDomNodeId: number | null;
  /** Full abstraction layer; new callers should use this. */
  server: ChromiumServer;
  /** Re-read the viewport after a resize so normalized → CSS pixel math stays accurate. */
  refreshViewport(): Promise<ViewportSize>;
  /** Cached viewport from the most recent connect / refresh. */
  getViewport(): ViewportSize;
  dispatchMouseEvent(event: MouseEventArgs): Promise<void>;
  dispatchKeyEvent(event: KeyEventArgs): Promise<void>;
  /** Persists a PNG under tmpdir. `rotation`/`scale`/`downscaler` need `sharp` installed. */
  captureScreenshot(opts?: ScreenshotOpts): Promise<MediaReady>;
  getAxTree(): Promise<ChromiumAxNode[]>;
  navigate(url: string): Promise<void>;
  /** Evaluate JS in the renderer. With `returnByValue`, resolves to the value itself. */
  evaluate(expression: string, options?: { returnByValue?: boolean }): Promise<unknown>;
  /** One CDP screencast session is shared across all subscribers. */
  startScreencast(opts?: ScreencastOpts): Promise<ScreencastSession>;
  getLastFrame(): ScreencastFrame | null;
}

export { discoverPrimaryPage, ensureCdpReachable };

async function getDocumentNodeId(cdp: CDPClient): Promise<number | null> {
  try {
    const out = (await cdp.send("DOM.getDocument", { depth: 0 })) as {
      root?: { nodeId?: number; backendNodeId?: number };
    };
    return out.root?.nodeId ?? out.root?.backendNodeId ?? null;
  } catch {
    return null;
  }
}

export const chromiumCdpBlueprint: ServiceBlueprint<ChromiumCdpApi, DeviceInfo> = {
  namespace: CHROMIUM_CDP_NAMESPACE,
  getURN(device: DeviceInfo) {
    return `${CHROMIUM_CDP_NAMESPACE}:${device.id}`;
  },
  async factory(_deps, payload, options) {
    // Two routes in: a tool's `services()` callback passes chromiumCdpRef(device),
    // so options.device is set; or another blueprint declares `ChromiumCdp:<id>`
    // as a dep, which the registry resolves by URN alone (no options channel — see
    // Registry._resolve), leaving only the device id in the payload.
    const opts = options as unknown as ChromiumFactoryOptions | undefined;
    const deviceFromOpts = opts?.device;
    const payloadStr = typeof payload === "string" ? payload : (payload as DeviceInfo)?.id;
    if (deviceFromOpts && payloadStr && deviceFromOpts.id !== payloadStr) {
      // Every registry path derives options.device and the URN payload from the
      // same device.id, or passes no options at all — so a mismatch can only come
      // from a hand-written factory() call. Programmer error, hence no error_code.
      throw new Error(
        `${CHROMIUM_CDP_NAMESPACE}.factory: options.device.id "${deviceFromOpts.id}" disagrees with URN payload "${payloadStr}".`
      );
    }
    const device = deviceFromOpts ?? (payloadStr ? resolveDevice(payloadStr) : null);
    if (!device) {
      // Also unreachable via the registry: resolveDevice never returns null and a
      // registry URN always carries the device id in its payload.
      throw new Error(
        `${CHROMIUM_CDP_NAMESPACE}.factory could not determine the device — pass it via chromiumCdpRef(device).options or via the URN payload.`
      );
    }
    const port = parseChromiumCdpPort(device.id);
    if (port == null) {
      throw new FailureError(
        `${CHROMIUM_CDP_NAMESPACE}.factory got a malformed device id "${device.id}". ` +
          `Expected "chromium-cdp-<port>".`,
        {
          error_code: FAILURE_CODES.CHROMIUM_DEVICE_ID_INVALID,
          failure_stage: "chromium_factory_device_id",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }

    const server = await createChromiumServer({ deviceId: device.id, port });
    const rootDomNodeId = await getDocumentNodeId(server.cdp);

    const events = new TypedEventEmitter<ServiceEvents>();
    server.events.on("terminated", (err) => {
      events.emit("terminated", err ?? new Error(`Chromium CDP on port ${port} disconnected`));
    });

    const api: ChromiumCdpApi = {
      port,
      cdp: server.cdp,
      pageWebSocketUrl: server.pageWebSocketUrl,
      rootDomNodeId,
      server,
      getViewport: () => server.getViewport(),
      refreshViewport: () => server.refreshViewport(),
      dispatchMouseEvent: async (event: MouseEventArgs) => {
        if (!Number.isFinite(event.x) || !Number.isFinite(event.y)) {
          throw new FailureError(
            `Chromium CDP: dispatchMouseEvent received non-finite coords x=${event.x}, y=${event.y}.`,
            {
              error_code: FAILURE_CODES.CHROMIUM_INPUT_INVALID,
              failure_stage: "chromium_dispatch_mouse_coords",
              failure_area: "tool_server",
              error_kind: "validation",
            }
          );
        }
        const button = event.button ?? (event.type === "mouseMoved" ? "none" : "left");
        const buttons = button === "none" ? 0 : 1;
        const payload: Record<string, unknown> = {
          type: event.type,
          x: event.x,
          y: event.y,
          button,
          buttons,
        };
        if (event.type !== "mouseMoved") {
          payload.clickCount = event.clickCount ?? 1;
        }
        await server.cdp.send("Input.dispatchMouseEvent", payload);
      },
      dispatchKeyEvent: async (event: KeyEventArgs) => {
        const payload: Record<string, unknown> = { type: event.type };
        if (event.key !== undefined) payload.key = event.key;
        if (event.code !== undefined) payload.code = event.code;
        if (event.text !== undefined) payload.text = event.text;
        if (event.windowsVirtualKeyCode !== undefined) {
          payload.windowsVirtualKeyCode = event.windowsVirtualKeyCode;
        }
        if (event.modifiers !== undefined) payload.modifiers = event.modifiers;
        await server.cdp.send("Input.dispatchKeyEvent", payload);
      },
      captureScreenshot: (opts2?: ScreenshotOpts) => server.captureScreenshot(opts2),
      getAxTree: async () => {
        const out = (await server.cdp.send("Accessibility.getFullAXTree", {})) as {
          nodes?: ChromiumAxNode[];
        };
        return out.nodes ?? [];
      },
      navigate: (url: string) => server.navigate(url),
      evaluate: (expression: string, opts2?: { returnByValue?: boolean }) =>
        server.evaluate(expression, opts2),
      startScreencast: (opts2?: ScreencastOpts) => server.startScreencast(opts2),
      getLastFrame: () => server.getLastFrame(),
    };

    const instance: ServiceInstance<ChromiumCdpApi> = {
      api,
      dispose: async () => {
        await server.dispose();
      },
      events,
    };
    return instance;
  },
};
