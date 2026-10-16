import type { CDPClient } from "../utils/debugger/cdp-client";

interface NavigationHistory {
  currentIndex: number;
  entries: Array<{ id: number; url: string; title: string }>;
}

export async function navigate(cdp: CDPClient, url: string): Promise<void> {
  const { errorText } = (await cdp.send("Page.navigate", { url })) as { errorText?: string };
  // An HTTP error status still got a response, so it is not a failed navigation.
  if (errorText && errorText !== "net::ERR_HTTP_RESPONSE_CODE_FAILURE")
    throw new Error(`Chromium could not navigate to ${url}: ${errorText}`);
}

export async function reload(cdp: CDPClient, ignoreCache = false): Promise<void> {
  await cdp.send("Page.reload", { ignoreCache });
}

async function getHistory(cdp: CDPClient): Promise<NavigationHistory> {
  return (await cdp.send("Page.getNavigationHistory", {})) as NavigationHistory;
}

/** Returns false at the oldest entry — no-op like `history.back()`, not a throw. */
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
