import { CDPClient } from "../utils/debugger/cdp-client";
import { browserWebSocketUrl, listPageTargets, type CdpTarget } from "./cdp-session";

export interface TabInfo {
  /** Stable per-session handle: `t1`, `t2`, … Never reused within a session. */
  tabId: string;
  /** Underlying CDP target id. */
  targetId: string;
  title: string;
  url: string;
  /** True for the tab the page-scoped tools (describe/tap/evaluate/…) act on. */
  active: boolean;
  /** Optional user-assigned label, usable interchangeably with `tabId`. */
  label?: string;
}

export interface TabsManager {
  /** Enumerate page targets (browser tabs / BrowserWindows) with stable ids. */
  list(): Promise<TabInfo[]>;
  /**
   * Make `ref` (a `tabId` or a label) the active tab. Re-points the shared page
   * CDP session so every other tool follows. No-op if already active.
   */
  select(ref: string): Promise<TabInfo[]>;
  /** Open a new tab/page (optionally at `url`, optionally labelled) and, by default, activate it. */
  open(opts?: { url?: string; label?: string; activate?: boolean }): Promise<TabInfo[]>;
  /** Close a tab (`ref` = tabId or label; defaults to the active tab). */
  close(ref?: string): Promise<TabInfo[]>;
  /** CDP target id of the currently active tab. */
  activeTargetId(): string;
}

interface TabsManagerDeps {
  /** The shared page-scoped CDP client the per-page tools use; `reconnect`ed on switch. */
  cdp: CDPClient;
  port: number;
  /** Target id the `cdp` client is connected to at construction (the initial active tab). */
  initialTargetId: string;
  /**
   * Called after the active tab changes (post-`reconnect`). Used by the server
   * to re-enable core domains and refresh the cached viewport for the new page.
   */
  onActivated: () => Promise<void>;
}

export function createTabsManager(deps: TabsManagerDeps): TabsManager {
  const { cdp, port } = deps;

  // Stable tabId ↔ CDP targetId mapping. tabIds are minted once and never
  // reused, so a script/agent can keep referring to `t2` even as other tabs
  // open and close (mirrors the `@eN` element-ref convention).
  const targetToTab = new Map<string, string>();
  const labelToTab = new Map<string, string>();
  const tabToLabel = new Map<string, string>();
  let ordinal = 0;
  let activeTargetId = deps.initialTargetId;

  function mintTabId(targetId: string): string {
    const existing = targetToTab.get(targetId);
    if (existing) return existing;
    const tabId = `t${++ordinal}`;
    targetToTab.set(targetId, tabId);
    return tabId;
  }

  /** Drop ids/labels whose target no longer exists so stale handles don't linger. */
  function prune(liveTargetIds: Set<string>): void {
    for (const [targetId, tabId] of [...targetToTab]) {
      if (!liveTargetIds.has(targetId)) {
        targetToTab.delete(targetId);
        const label = tabToLabel.get(tabId);
        if (label) {
          labelToTab.delete(label);
          tabToLabel.delete(tabId);
        }
      }
    }
  }

  function toInfo(target: CdpTarget): TabInfo {
    const tabId = mintTabId(target.id);
    const label = tabToLabel.get(tabId);
    return {
      tabId,
      targetId: target.id,
      title: target.title,
      url: target.url,
      active: target.id === activeTargetId,
      ...(label ? { label } : {}),
    };
  }

  async function listTargets(): Promise<CdpTarget[]> {
    const targets = await listPageTargets(port);
    prune(new Set(targets.map((t) => t.id)));
    return targets;
  }

  async function list(): Promise<TabInfo[]> {
    return (await listTargets()).map(toInfo);
  }

  function resolveTargetId(ref: string, targets: CdpTarget[]): string {
    // A label?
    const byLabel = labelToTab.get(ref);
    // A tabId (directly, or resolved from the label)?
    const wantTabId = byLabel ?? ref;
    for (const t of targets) {
      if (targetToTab.get(t.id) === wantTabId) return t.id;
    }
    // Or a raw CDP target id.
    if (targets.some((t) => t.id === ref)) return ref;
    throw new Error(
      `No tab matches "${ref}". Use \`chromium-tabs action=list\` to see current tabIds and labels.`
    );
  }

  async function activate(targetId: string, targets: CdpTarget[]): Promise<void> {
    if (targetId === activeTargetId) return;
    const target = targets.find((t) => t.id === targetId);
    if (!target?.webSocketDebuggerUrl) {
      throw new Error(
        `Tab target ${targetId} has no webSocketDebuggerUrl (it may have just closed).`
      );
    }
    await cdp.reconnect(target.webSocketDebuggerUrl);
    activeTargetId = targetId;
    await deps.onActivated();
  }

  async function select(ref: string): Promise<TabInfo[]> {
    const targets = await listTargets();
    await activate(resolveTargetId(ref, targets), targets);
    return targets.map(toInfo);
  }

  async function withBrowserClient<T>(fn: (browser: CDPClient) => Promise<T>): Promise<T> {
    // Target.createTarget / closeTarget are browser-level commands, so they need
    // the browser endpoint rather than a page session. Use a short-lived client.
    const browser = new CDPClient(await browserWebSocketUrl(port), { sendOrigin: false });
    await browser.connect();
    try {
      return await fn(browser);
    } finally {
      await browser.disconnect().catch(() => {});
    }
  }

  async function open(opts?: {
    url?: string;
    label?: string;
    activate?: boolean;
  }): Promise<TabInfo[]> {
    const url = opts?.url ?? "about:blank";
    const created = await withBrowserClient(async (browser) => {
      const out = (await browser.send("Target.createTarget", { url })) as { targetId?: string };
      if (!out.targetId) throw new Error("Target.createTarget returned no targetId.");
      return out.targetId;
    });
    const tabId = mintTabId(created);
    if (opts?.label) {
      labelToTab.set(opts.label, tabId);
      tabToLabel.set(tabId, opts.label);
    }
    if (opts?.activate !== false) {
      // The new target needs a moment to appear in /json/list with a WS URL.
      const targets = await listTargets();
      await activate(created, targets);
      return targets.map(toInfo);
    }
    return list();
  }

  async function close(ref?: string): Promise<TabInfo[]> {
    const targets = await listTargets();
    const targetId = ref ? resolveTargetId(ref, targets) : activeTargetId;
    await withBrowserClient((browser) => browser.send("Target.closeTarget", { targetId }));

    // Forget the closed tab's id/label.
    const tabId = targetToTab.get(targetId);
    targetToTab.delete(targetId);
    if (tabId) {
      const label = tabToLabel.get(tabId);
      if (label) {
        labelToTab.delete(label);
        tabToLabel.delete(tabId);
      }
    }

    // If we closed the active tab, fall back to another live page so the
    // page-scoped tools keep working.
    if (targetId === activeTargetId) {
      const remaining = (await listTargets()).filter((t) => t.id !== targetId);
      if (remaining.length > 0) {
        await activate(remaining[0]!.id, remaining);
      }
    }
    return list();
  }

  return {
    list,
    select,
    open,
    close,
    activeTargetId: () => activeTargetId,
  };
}
