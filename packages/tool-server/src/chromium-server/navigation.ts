import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { CDPClient } from "../utils/debugger/cdp-client";

interface NavigationHistory {
  currentIndex: number;
  entries: Array<{ id: number; url: string; title: string }>;
}

function parseUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

const inFlight = new WeakMap<CDPClient, Map<string, Promise<void>>>();

/**
 * Chromium answers a navigation that repeats one still in flight with
 * net::ERR_ABORTED and lets the first one load, so a repeat waits for the first.
 */
export function navigate(cdp: CDPClient, url: string): Promise<void> {
  const parsed = parseUrl(url);
  // Each javascript: URL runs its script, so a repeat is not a duplicate.
  if (parsed?.protocol === "javascript:") return navigateOnce(cdp, url, true);
  const key = parsed?.href ?? url;
  let pending = inFlight.get(cdp);
  if (!pending) inFlight.set(cdp, (pending = new Map()));
  const running = pending.get(key);
  if (running) return running;
  // This navigation cancels any other in flight, so a repeat of one must be sent again.
  pending.clear();
  const started: Promise<void> = navigateOnce(cdp, url, false).finally(() => {
    if (pending.get(key) === started) pending.delete(key);
  });
  pending.set(key, started);
  return started;
}

async function navigateOnce(cdp: CDPClient, url: string, isJavascript: boolean): Promise<void> {
  const { errorText, isDownload } = (await cdp.send("Page.navigate", { url })) as {
    errorText?: string;
    isDownload?: boolean;
  };
  // Chromium sets errorText even when the URL took effect: the server answered
  // with an HTTP error status, or a download started. A javascript: URL never
  // loads a page, so its errorText says nothing about whether the script ran.
  if (
    !errorText ||
    errorText === "net::ERR_HTTP_RESPONSE_CODE_FAILURE" ||
    (isDownload && errorText === "net::ERR_ABORTED") ||
    isJavascript
  )
    return;
  // The url is left out so credentials and tokens in it stay out of the logs.
  throw new FailureError(
    `Chromium could not navigate: ${errorText}.` +
      (errorText === "net::ERR_ABORTED"
        ? " Chromium aborts a URL it does not load in a page, such as tel:, mailto: or an" +
          " unknown scheme, a response with no content, and a navigation another one replaced."
        : ""),
    {
      error_code: FAILURE_CODES.CHROMIUM_NAVIGATE_FAILED,
      failure_stage: "chromium_navigate",
      failure_area: "tool_server",
      error_kind: "unknown",
    }
  );
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
