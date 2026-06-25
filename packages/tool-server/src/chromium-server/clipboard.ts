import type { CDPClient } from "../utils/debugger/cdp-client";

/**
 * Set the renderer's clipboard text. CDP doesn't expose the OS clipboard
 * directly — sim-server has access via NSPasteboard on iOS, but for Chromium
 * we have to go through the renderer's `navigator.clipboard.writeText`.
 *
 * That API requires the document to have user-activation focus (Chromium's
 * security model), so we first force-focus the page via Page.bringToFront and
 * fall back to a document.execCommand("copy") trick if writeText is blocked.
 */
export async function setClipboardText(cdp: CDPClient, text: string): Promise<void> {
  try {
    await cdp.send("Page.bringToFront");
  } catch {
    /* not always available; non-fatal */
  }

  // Encode the text as a JS string literal so embedded quotes/newlines round-
  // trip safely through Runtime.evaluate. JSON.stringify is the safest
  // serializer here — it covers backslashes, quotes, control chars, unicode.
  const literal = JSON.stringify(text);
  const script = `(async () => {
    const text = ${literal};
    try {
      await navigator.clipboard.writeText(text);
      return { ok: true };
    } catch (err) {
      // Fallback: hidden textarea + document.execCommand("copy"). Works in
      // contexts where the Clipboard API is gated on user activation.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "absolute";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return { ok, error: ok ? null : (err && err.message) || String(err) };
    }
  })()`;
  const out = (await cdp.send(
    "Runtime.evaluate",
    {
      expression: script,
      awaitPromise: true,
      returnByValue: true,
    },
    10_000
  )) as { result?: { value?: { ok?: boolean; error?: string } }; exceptionDetails?: unknown };
  const result = out.result?.value;
  if (!result?.ok) {
    throw new Error(
      `Chromium clipboard set failed: ${result?.error ?? "renderer rejected the write"}`
    );
  }
}

/**
 * Sim-server has bidirectional clipboard sync (OS ↔ device). On Chromium the
 * direction that matters is "set the renderer's clipboard from a tool call",
 * which `setClipboardText` covers. A true sync would require the Chromium app
 * to opt in via main-process IPC — outside what CDP can offer. This is a
 * no-op stub that records the desired state so future native-side coordination
 * has a place to hook in.
 */
export class ClipboardSyncState {
  private enabled = false;
  set(enabled: boolean): void {
    this.enabled = enabled;
  }
  isEnabled(): boolean {
    return this.enabled;
  }
}
