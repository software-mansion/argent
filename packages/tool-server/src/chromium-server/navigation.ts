import type { CDPClient } from "../utils/debugger/cdp-client";

interface NavigationHistory {
  currentIndex: number;
  entries: Array<{ id: number; url: string; title: string }>;
}

export async function navigate(cdp: CDPClient, url: string): Promise<void> {
  // Page.navigate accepts about:blank, file://, data:, http(s):, etc.
  // No URL whitelist here — the caller is the tool-server, which already
  // validated the URL against the tool's zod schema.
  await cdp.send("Page.navigate", { url });
}

export async function reload(cdp: CDPClient, ignoreCache = false): Promise<void> {
  await cdp.send("Page.reload", { ignoreCache });
}

async function getHistory(cdp: CDPClient): Promise<NavigationHistory> {
  return (await cdp.send("Page.getNavigationHistory", {})) as NavigationHistory;
}

/**
 * Walk one step back in the renderer's navigation history. Returns false
 * when already at the oldest entry — matches browser `history.back()` no-op
 * semantics instead of throwing.
 */
export async function goBack(cdp: CDPClient): Promise<boolean> {
  const history = await getHistory(cdp);
  if (history.currentIndex <= 0) return false;
  const target = history.entries[history.currentIndex - 1];
  if (!target) return false;
  await cdp.send("Page.navigateToHistoryEntry", { entryId: target.id });
  return true;
}

export async function goForward(cdp: CDPClient): Promise<boolean> {
  const history = await getHistory(cdp);
  if (history.currentIndex >= history.entries.length - 1) return false;
  const target = history.entries[history.currentIndex + 1];
  if (!target) return false;
  await cdp.send("Page.navigateToHistoryEntry", { entryId: target.id });
  return true;
}
