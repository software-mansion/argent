import { FAILURE_CODES, FailureError } from "@argent/registry";
import { CDPClient } from "../utils/debugger/cdp-client";
import { browserWebSocketUrl, listPageTargets, type CdpTarget } from "./cdp-session";

export interface TabInfo {
  /** Stable per-session handle (`t1`, `t2`, …); never reused. */
  tabId: string;
  /** Underlying CDP target id. */
  targetId: string;
  title: string;
  url: string;
  /** True for the tab the page-scoped tools act on. */
  active: boolean;
  /** Optional user-assigned label, usable interchangeably with `tabId`. */
  label?: string;
}

export interface TabsManager {
  /** Enumerate page targets (browser tabs / BrowserWindows) with stable ids. */
  list(): Promise<TabInfo[]>;
  /**
   * Make `ref` (a `tabId` or a label) active, re-pointing the shared page CDP
   * session so every other tool follows.
   */
  select(ref: string): Promise<TabInfo[]>;
  /** Open a new tab/page and, unless `activate` is false, make it active. */
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
   * Called after the active tab changes (post-`reconnect`) so the server can
   * re-prime everything bound to the old page.
   */
  onActivated: () => Promise<void>;
}

export function createTabsManager(deps: TabsManagerDeps): TabsManager {
  const { cdp, port } = deps;

  // tabIds are minted once and never reused, so a caller can keep referring to
  // `t2` as other tabs open and close.
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
    const byLabel = labelToTab.get(ref);
    const wantTabId = byLabel ?? ref;
    for (const t of targets) {
      if (targetToTab.get(t.id) === wantTabId) return t.id;
    }
    // Or a raw CDP target id.
    if (targets.some((t) => t.id === ref)) return ref;
    throw new FailureError(
      `No tab matches "${ref}". Use \`chromium-tabs action=list\` to see current tabIds and labels.`,
      {
        error_code: FAILURE_CODES.CHROMIUM_TAB_NOT_FOUND,
        failure_stage: "chromium_tab_resolve",
        failure_area: "tool_server",
        error_kind: "not_found",
      }
    );
  }

  async function activate(targetId: string, targets: CdpTarget[]): Promise<void> {
    if (targetId === activeTargetId) return;
    const target = targets.find((t) => t.id === targetId);
    if (!target?.webSocketDebuggerUrl) {
      throw new FailureError(
        `Tab target ${targetId} has no webSocketDebuggerUrl (it may have just closed).`,
        {
          error_code: FAILURE_CODES.CHROMIUM_TAB_NOT_FOUND,
          failure_stage: "chromium_tab_activate",
          failure_area: "tool_server",
          error_kind: "not_found",
        }
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
    // the browser endpoint rather than a page session.
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
      let out: { targetId?: string };
      try {
        out = (await browser.send("Target.createTarget", { url })) as { targetId?: string };
      } catch (err) {
        // Electron embeds a renderer but no browser shell, so it rejects this
        // with a bare "Not supported". The underlying error is kept so a
        // different cause (dropped connection, refused url) stays legible.
        throw new FailureError(
          `Could not open a tab: ${err instanceof Error ? err.message : String(err)}. ` +
            `An Electron app has no browser-level target creation, so a tab cannot be made from ` +
            `outside it — have the app open one (e.g. \`window.open()\` through ` +
            `\`debugger-evaluate\`) and it will show up in \`chromium-tabs list\`. ` +
            `The list, select and close actions are unaffected.`,
          {
            error_code: FAILURE_CODES.CHROMIUM_TAB_OPEN_FAILED,
            failure_stage: "chromium_tab_open",
            failure_area: "tool_server",
            error_kind: "unknown",
          }
        );
      }
      if (!out.targetId)
        throw new FailureError("Target.createTarget returned no targetId.", {
          error_code: FAILURE_CODES.CHROMIUM_TAB_OPEN_FAILED,
          failure_stage: "chromium_tab_open",
          failure_area: "tool_server",
          // A malformed CDP response, not a transport failure:
          // `network`/`invalid_response` is reserved for the HTTP /json layer.
          error_kind: "unknown",
        });
      return out.targetId;
    });
    const tabId = mintTabId(created);
    if (opts?.label) {
      labelToTab.set(opts.label, tabId);
      tabToLabel.set(tabId, opts.label);
    }
    if (opts?.activate !== false) {
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

    const tabId = targetToTab.get(targetId);
    targetToTab.delete(targetId);
    if (tabId) {
      const label = tabToLabel.get(tabId);
      if (label) {
        labelToTab.delete(label);
        tabToLabel.delete(tabId);
      }
    }

    // Falling back to another live page keeps the page-scoped tools working.
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
