import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  TypedEventEmitter,
  type DeviceInfo,
  type ServiceBlueprint,
  type ServiceEvents,
  type ServiceInstance,
} from "@argent/registry";
import { CDPClient } from "../utils/debugger/cdp-client";
import { parseElectronCdpPort } from "../utils/device-info";

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
  /** Re-read the page viewport so normalized → CSS pixel math stays accurate after window resizes. */
  refreshViewport(): Promise<ViewportSize>;
  /** Cached viewport from the most recent connect / refresh. */
  getViewport(): ViewportSize;
  dispatchMouseEvent(event: MouseEventArgs): Promise<void>;
  dispatchKeyEvent(event: KeyEventArgs): Promise<void>;
  /** Screenshot encoded as base64 PNG via CDP, persisted under tmpdir; returns file:// URL + absolute path. */
  captureScreenshot(): Promise<{ url: string; path: string }>;
  /** Returns the accessibility tree rooted at the document. */
  getAxTree(): Promise<ElectronAxNode[]>;
  /** Navigate the renderer to a URL. */
  navigate(url: string): Promise<void>;
  /** Evaluate JS in the renderer. Resolves to the serialized value when `returnByValue` is true. */
  evaluate(expression: string, options?: { returnByValue?: boolean }): Promise<unknown>;
}

interface CdpVersionInfo {
  Browser?: string;
  webSocketDebuggerUrl?: string;
}

interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`Electron CDP discovery: GET ${url} failed (HTTP ${res.status})`);
  }
  return (await res.json()) as T;
}

/**
 * Probe a CDP endpoint for the renderer page we should drive. Electron typically
 * exposes one "page" target per BrowserWindow and a few "service_worker" /
 * "shared_worker" targets we don't care about.
 */
export async function discoverPrimaryPage(port: number, signal?: AbortSignal): Promise<CdpTarget> {
  const targets = await fetchJson<CdpTarget[]>(`http://127.0.0.1:${port}/json/list`, signal);
  const pages = targets.filter((t) => t.type === "page" && !!t.webSocketDebuggerUrl);
  if (pages.length === 0) {
    throw new Error(
      `Electron CDP on port ${port} reported no page targets. Is the app started with --remote-debugging-port=${port}?`
    );
  }
  // Prefer the first non-devtools page; fall back to the first if everything looks like devtools.
  const primary = pages.find((p) => !p.url.startsWith("devtools://")) ?? pages[0]!;
  return primary;
}

export async function ensureCdpReachable(
  port: number,
  signal?: AbortSignal
): Promise<CdpVersionInfo> {
  return fetchJson<CdpVersionInfo>(`http://127.0.0.1:${port}/json/version`, signal);
}

async function readViewport(cdp: CDPClient): Promise<ViewportSize> {
  const out = (await cdp.send("Runtime.evaluate", {
    expression:
      "JSON.stringify({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 })",
    returnByValue: true,
  })) as { result?: { value?: string } };
  const raw = out.result?.value;
  if (typeof raw !== "string") {
    return { width: 800, height: 600, devicePixelRatio: 1 };
  }
  try {
    const parsed = JSON.parse(raw) as { w: number; h: number; dpr: number };
    return { width: parsed.w || 800, height: parsed.h || 600, devicePixelRatio: parsed.dpr || 1 };
  } catch {
    return { width: 800, height: 600, devicePixelRatio: 1 };
  }
}

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

function persistPngBase64(base64: string): { url: string; path: string } {
  const dir = path.join(os.tmpdir(), "argent-electron-screenshots");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `screenshot-${Date.now()}-${process.pid}.png`);
  fs.writeFileSync(filePath, Buffer.from(base64, "base64"));
  return { url: `file://${filePath}`, path: filePath };
}

export const electronCdpBlueprint: ServiceBlueprint<ElectronCdpApi, DeviceInfo> = {
  namespace: ELECTRON_CDP_NAMESPACE,
  getURN(device: DeviceInfo) {
    return `${ELECTRON_CDP_NAMESPACE}:${device.id}`;
  },
  async factory(_deps, _payload, options) {
    const opts = options as unknown as ElectronFactoryOptions | undefined;
    if (!opts?.device) {
      throw new Error(
        `${ELECTRON_CDP_NAMESPACE}.factory requires a resolved DeviceInfo via options.device. ` +
          `Use electronCdpRef(device) when registering the service ref.`
      );
    }
    const port = parseElectronCdpPort(opts.device.id);
    if (port == null) {
      throw new Error(
        `${ELECTRON_CDP_NAMESPACE}.factory got a malformed device id "${opts.device.id}". ` +
          `Expected "electron-cdp-<port>".`
      );
    }

    await ensureCdpReachable(port);
    const target = await discoverPrimaryPage(port);
    const wsUrl = target.webSocketDebuggerUrl!;

    // Chromium's devtools-target rejects WS upgrades that carry an Origin
    // header — it expects IDE clients, not browser pages. Suppress it.
    const cdp = new CDPClient(wsUrl, { sendOrigin: false });
    await cdp.connect();

    // Best-effort domain enables. Failing to enable Page is non-fatal because
    // Input.* events don't actually require it — but Page makes Page.navigate
    // / Page.captureScreenshot return better errors when the renderer is mid-
    // navigation, so we try.
    try {
      await cdp.send("Page.enable");
    } catch {
      /* ignore */
    }
    try {
      await cdp.send("DOM.enable");
    } catch {
      /* ignore */
    }
    try {
      await cdp.send("Accessibility.enable");
    } catch {
      /* ignore */
    }

    let viewport = await readViewport(cdp);
    const rootDomNodeId = await getDocumentNodeId(cdp);

    const events = new TypedEventEmitter<ServiceEvents>();
    cdp.events.on("disconnected", (err) => {
      events.emit("terminated", err ?? new Error(`Electron CDP on port ${port} disconnected`));
    });

    const api: ElectronCdpApi = {
      port,
      cdp,
      pageWebSocketUrl: wsUrl,
      rootDomNodeId,
      getViewport: () => viewport,
      refreshViewport: async () => {
        viewport = await readViewport(cdp);
        return viewport;
      },
      dispatchMouseEvent: async (event) => {
        const payload: Record<string, unknown> = {
          type: event.type,
          x: event.x,
          y: event.y,
          button: event.button ?? (event.type === "mouseMoved" ? "none" : "left"),
          buttons: event.type === "mouseMoved" ? 0 : 1,
        };
        if (event.type !== "mouseMoved") {
          payload.clickCount = event.clickCount ?? 1;
        }
        await cdp.send("Input.dispatchMouseEvent", payload);
      },
      dispatchKeyEvent: async (event) => {
        const payload: Record<string, unknown> = { type: event.type };
        if (event.key !== undefined) payload.key = event.key;
        if (event.code !== undefined) payload.code = event.code;
        if (event.text !== undefined) payload.text = event.text;
        if (event.windowsVirtualKeyCode !== undefined) {
          payload.windowsVirtualKeyCode = event.windowsVirtualKeyCode;
        }
        if (event.modifiers !== undefined) payload.modifiers = event.modifiers;
        await cdp.send("Input.dispatchKeyEvent", payload);
      },
      captureScreenshot: async () => {
        const out = (await cdp.send("Page.captureScreenshot", { format: "png" })) as {
          data?: string;
        };
        if (!out.data) {
          throw new Error("Electron CDP: Page.captureScreenshot returned no data.");
        }
        return persistPngBase64(out.data);
      },
      getAxTree: async () => {
        const out = (await cdp.send("Accessibility.getFullAXTree", {})) as {
          nodes?: ElectronAxNode[];
        };
        return out.nodes ?? [];
      },
      navigate: async (url) => {
        await cdp.send("Page.navigate", { url });
      },
      evaluate: async (expression, opts2) => {
        return cdp.evaluate(expression, { timeout: 10_000 });
      },
    };

    const instance: ServiceInstance<ElectronCdpApi> = {
      api,
      dispose: async () => {
        try {
          await cdp.disconnect();
        } catch {
          /* ignore */
        }
      },
      events,
    };
    return instance;
  },
};
