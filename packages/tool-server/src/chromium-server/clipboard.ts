import type { CDPClient } from "../utils/debugger/cdp-client";

/**
 * Set the renderer's clipboard text. CDP has no clipboard domain, so the write
 * goes through the page's `navigator.clipboard.writeText`, which needs a
 * focused document — hence the Page.bringToFront, and the execCommand
 * fallback for when the write is rejected anyway.
 */
export async function setClipboardText(cdp: CDPClient, text: string): Promise<void> {
  try {
    await cdp.send("Page.bringToFront");
  } catch {
    /* not always available; non-fatal */
  }

  // A JSON literal survives embedding in the evaluated source: quotes, newlines,
  // control chars and unicode all come back intact.
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
    // Plain Error, not FailureError: the only caller, the POST /api/clipboard/text
    // route, flattens this to a 500 `{ error }`, so a failure code would be lost.
    throw new Error(
      `Chromium clipboard set failed: ${result?.error ?? "renderer rejected the write"}`
    );
  }
}

/**
 * No-op stub: real OS ↔ device sync would need the Chromium app to opt in via
 * main-process IPC, which CDP cannot reach. It holds no field — nothing can read
 * the requested state back, and a stored one would only look like state the rest
 * of the server consults. What the type buys is the seam: `setClipboardSync`
 * resolves like the other commands, so the WS `clipboardSync` route needs no
 * not-yet-implemented branch, and a future native bridge lands here.
 */
export class ClipboardSyncState {
  set(_enabled: boolean): void {}
}
