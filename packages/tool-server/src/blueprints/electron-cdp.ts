import {
  TypedEventEmitter,
  type DeviceInfo,
  type ServiceBlueprint,
  type ServiceEvents,
  type ServiceInstance,
} from "@argent/registry";
import type { CDPClient } from "../utils/debugger/cdp-client";
import {
  createElectronServer,
  discoverPrimaryPage,
  ensureCdpReachable,
  type ElectronServer,
  type MediaReady,
  type ScreencastFrame,
  type ScreencastOpts,
  type ScreencastSession,
  type ScreenshotOpts,
} from "../electron-server";
import { parseElectronCdpPort, resolveDevice } from "../utils/device-info";

export const ELECTRON_CDP_NAMESPACE = "ElectronCdp";

type ElectronFactoryOptions = Record<string, unknown> & { device: DeviceInfo };

/**
 * Build the `ServiceRef` for an Electron CDP session keyed by an already-resolved
 * `DeviceInfo`. Tool `services()` callbacks call this rather than hand-building
 * the URN string so the blueprint factory always receives the device through
 * the registry's `options` channel and never has to reclassify.
 */
export function electronCdpRef(device: DeviceInfo): {
  urn: string;
  options: ElectronFactoryOptions;
} {
  return {
    urn: `${ELECTRON_CDP_NAMESPACE}:${device.id}`,
    options: { device },
  };
}

// ── Legacy compatibility surface ─────────────────────────────────────────────
// The first cut of Electron support exposed a thin `ElectronCdpApi` directly
// off the blueprint. Existing tools (gesture-tap, screenshot, describe,
// keyboard, run-sequence, etc.) still consume that shape. The full ElectronServer
// is now the source of truth, and these legacy types are kept so the blueprint
// can publish *both* the new abstraction (`server`) and the original ergonomic
// methods without forcing a callsite-by-callsite migration.

export interface MouseEventArgs {
  type: "mousePressed" | "mouseReleased" | "mouseMoved";
  /** CSS pixels relative to the page viewport. */
  x: number;
  y: number;
  button?: "none" | "left" | "middle" | "right";
  /** Required for press/release. */
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
  /** Device pixel ratio reported by the renderer. */
  devicePixelRatio: number;
}

export interface ElectronAxNode {
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

export interface ElectronCdpApi {
  /** CDP port the Electron app exposed. */
  port: number;
  /** Underlying CDP client connected to the primary page target. */
  cdp: CDPClient;
  /** WebSocket URL to the page target (for diagnostics). */
  pageWebSocketUrl: string;
  /** Backend node id of the document (used as the root for AX queries). */
  rootDomNodeId: number | null;
  /** The full sim-server-equivalent abstraction layer. New callers should use this. */
  server: ElectronServer;
  /** Re-read the page viewport so normalized → CSS pixel math stays accurate after window resizes. */
  refreshViewport(): Promise<ViewportSize>;
  /** Cached viewport from the most recent connect / refresh. */
  getViewport(): ViewportSize;
  dispatchMouseEvent(event: MouseEventArgs): Promise<void>;
  dispatchKeyEvent(event: KeyEventArgs): Promise<void>;
  /** Screenshot via CDP, persisted under tmpdir; returns file:// URL + absolute path.
   * Supports the sim-server-style options (rotation, scale, downscaler) when sharp is installed. */
  captureScreenshot(opts?: ScreenshotOpts): Promise<MediaReady>;
  /** Returns the accessibility tree rooted at the document. */
  getAxTree(): Promise<ElectronAxNode[]>;
  /** Navigate the renderer to a URL. */
  navigate(url: string): Promise<void>;
  /** Evaluate JS in the renderer. Resolves to the serialized value when `returnByValue` is true. */
  evaluate(expression: string, options?: { returnByValue?: boolean }): Promise<unknown>;
  /** Start a screencast (one CDP session shared across all subscribers). */
  startScreencast(opts?: ScreencastOpts): Promise<ScreencastSession>;
  /** Last received screencast frame, or null. */
  getLastFrame(): ScreencastFrame | null;
}

// Re-exports for discovery callers that previously imported these straight from
// the blueprint module.
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

export const electronCdpBlueprint: ServiceBlueprint<ElectronCdpApi, DeviceInfo> = {
  namespace: ELECTRON_CDP_NAMESPACE,
  getURN(device: DeviceInfo) {
    return `${ELECTRON_CDP_NAMESPACE}:${device.id}`;
  },
  async factory(_deps, payload, options) {
    // Two routes into this factory:
    //   1) A tool's `services()` callback uses electronCdpRef(device) and we
    //      get options.device for free.
    //   2) Another blueprint declares `ElectronCdp:<id>` as a transitive dep
    //      (registry resolves deps via URN strings only, no options channel
    //      — see Registry._resolve). In that case we synthesize DeviceInfo
    //      from the URN payload, which IS the device id.
    // Both paths must agree on the device id; if a caller passed an explicit
    // options.device whose id doesn't match the URN, that's a wiring bug
    // worth surfacing loudly.
    const opts = options as unknown as ElectronFactoryOptions | undefined;
    const deviceFromOpts = opts?.device;
    const payloadStr = typeof payload === "string" ? payload : (payload as DeviceInfo)?.id;
    if (deviceFromOpts && payloadStr && deviceFromOpts.id !== payloadStr) {
      throw new Error(
        `${ELECTRON_CDP_NAMESPACE}.factory: options.device.id "${deviceFromOpts.id}" disagrees with URN payload "${payloadStr}".`
      );
    }
    const device = deviceFromOpts ?? (payloadStr ? resolveDevice(payloadStr) : null);
    if (!device) {
      throw new Error(
        `${ELECTRON_CDP_NAMESPACE}.factory could not determine the device — pass it via electronCdpRef(device).options or via the URN payload.`
      );
    }
    const port = parseElectronCdpPort(device.id);
    if (port == null) {
      throw new Error(
        `${ELECTRON_CDP_NAMESPACE}.factory got a malformed device id "${device.id}". ` +
          `Expected "electron-cdp-<port>".`
      );
    }

    const server = await createElectronServer({ deviceId: device.id, port });
    const rootDomNodeId = await getDocumentNodeId(server.cdp);

    const events = new TypedEventEmitter<ServiceEvents>();
    server.events.on("terminated", (err) => {
      events.emit("terminated", err ?? new Error(`Electron CDP on port ${port} disconnected`));
    });

    // Legacy adapter — translates the original `dispatchMouseEvent` and
    // `dispatchKeyEvent` calls into the new server's wire formats. Keeping
    // these one-liners means we don't have to rewrite every tool right now;
    // they can migrate to `api.server.send*` at their own pace.
    const api: ElectronCdpApi = {
      port,
      cdp: server.cdp,
      pageWebSocketUrl: server.pageWebSocketUrl,
      rootDomNodeId,
      server,
      getViewport: () => server.getViewport(),
      refreshViewport: () => server.refreshViewport(),
      dispatchMouseEvent: async (event: MouseEventArgs) => {
        if (!Number.isFinite(event.x) || !Number.isFinite(event.y)) {
          throw new Error(
            `Electron CDP: dispatchMouseEvent received non-finite coords x=${event.x}, y=${event.y}.`
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
          nodes?: ElectronAxNode[];
        };
        return out.nodes ?? [];
      },
      navigate: (url: string) => server.navigate(url),
      evaluate: (expression: string, opts2?: { returnByValue?: boolean }) =>
        server.evaluate(expression, opts2),
      startScreencast: (opts2?: ScreencastOpts) => server.startScreencast(opts2),
      getLastFrame: () => server.getLastFrame(),
    };

    const instance: ServiceInstance<ElectronCdpApi> = {
      api,
      dispose: async () => {
        await server.dispose();
      },
      events,
    };
    return instance;
  },
};
