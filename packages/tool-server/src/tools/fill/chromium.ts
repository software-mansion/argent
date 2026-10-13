import type { DeviceInfo, Registry } from "@argent/registry";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { noFocusedFieldError, notVerifiedError, unsupportedFieldError } from "./errors";
import type { FillResult } from "./types";

/** What the page script answers. Never text: only a verdict and a length. */
interface PageFillAnswer {
  status: "ok" | "no_focus" | "unsupported" | "error";
  detail?: string;
  verified?: boolean;
  length?: number;
}

/**
 * The page script. It finds the focused editable — through open shadow roots
 * and same-origin frames — selects its content and replaces it with the
 * page's own editing commands, so the page sees a user edit: `beforeinput`
 * and `input` fire, React's value tracker and rich-text editors update. A text
 * control whose page refused the command (or that has no selection API, like
 * `type=number`) gets the native value setter and an `input` event instead.
 *
 * The comparison happens in the page, after a task boundary so an editor that
 * restores its model on a microtask has done so. Only a boolean and a length
 * come back; the field may be a password.
 *
 * Exported for the script test, which runs it against a mock document.
 */
export function buildChromiumFillScript(text: string): string {
  // A JSON literal survives embedding: quotes, newlines and unicode come back intact.
  return `(async () => {
  const text = ${JSON.stringify(text)};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const deepActive = (doc) => {
      let el = doc.activeElement;
      while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
      return el;
    };
    let el = deepActive(document);
    while (el && String(el.tagName).toLowerCase() === "iframe") {
      let inner = null;
      try { inner = el.contentDocument; } catch (e) { inner = null; }
      if (!inner) return { status: "no_focus" };
      el = deepActive(inner);
    }
    if (!el || el.tagName === undefined) return { status: "no_focus" };
    const doc = el.ownerDocument || document;
    const win = doc.defaultView || window;
    const tag = String(el.tagName).toLowerCase();
    const type = tag === "input" ? String(el.type || "text").toLowerCase() : null;
    if (type !== null && /^(date|time|month|week|datetime-local)$/.test(type)) {
      return { status: "unsupported", detail: "a " + type + " input holds a structured value" };
    }
    const control =
      tag === "textarea" ||
      (tag === "input" && !/^(button|checkbox|radio|file|submit|reset|image|range|color|hidden)$/.test(type));
    if (!control && el.isContentEditable !== true) return { status: "no_focus" };
    if (control && el.disabled === true) return { status: "unsupported", detail: "it is disabled" };
    if (control && el.readOnly === true) return { status: "unsupported", detail: "it is read-only" };
    // An <input> holds one line and drops a newline.
    if (tag === "input" && /[\\r\\n]/.test(text)) {
      return { status: "unsupported", detail: "a single-line input cannot hold a newline" };
    }
    if (!control) {
      // designMode or <body contenteditable>: the whole document is the field.
      let host = el;
      while (host.parentElement && host.parentElement.isContentEditable === true) host = host.parentElement;
      if (host === doc.body || host === doc.documentElement) {
        return { status: "unsupported", detail: "the whole document is editable" };
      }
    }
    const trimEnd = (s) => s.replace(/[\\u200b\\ufeff]/g, "").replace(/\\n+$/, "");
    const read = () =>
      control ? String(el.value == null ? "" : el.value) : trimEnd(String(el.innerText == null ? el.textContent || "" : el.innerText));
    const matches = () => (control ? read() === text : read() === trimEnd(text));
    const settle = async () => {
      for (let i = 0; i < 10; i++) {
        await sleep(i === 0 ? 0 : 50);
        if (matches()) return true;
      }
      return false;
    };

    if (control) {
      try { el.select(); } catch (e) { /* no selection API */ }
    } else {
      const sel = doc.getSelection();
      const range = doc.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    if (text === "") {
      if (read() !== "") doc.execCommand("delete");
    } else {
      doc.execCommand("insertText", false, text);
    }
    let verified = await settle();
    if (!verified && control) {
      const proto = tag === "textarea" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, text);
      el.dispatchEvent(new win.Event("input", { bubbles: true }));
      el.dispatchEvent(new win.Event("change", { bubbles: true }));
      verified = await settle();
    }
    return { status: "ok", verified: verified, length: read().length };
  } catch (e) {
    return { status: "error" };
  }
})()`;
}

export async function fillChromium(
  registry: Registry,
  device: DeviceInfo,
  text: string
): Promise<FillResult> {
  const ref = chromiumCdpRef(device);
  const api = await registry.resolveService<ChromiumCdpApi>(ref.urn, ref.options);
  const out = (await api.cdp.send(
    "Runtime.evaluate",
    { expression: buildChromiumFillScript(text), awaitPromise: true, returnByValue: true },
    10_000
  )) as { result?: { value?: PageFillAnswer } };
  const answer = out.result?.value;
  switch (answer?.status) {
    case "ok":
      if (answer.verified === true) {
        return { method: "cdp", verified: true, length: answer.length };
      }
      throw notVerifiedError("cdp", "fill_chromium_not_verified");
    case "no_focus":
      throw noFocusedFieldError("fill_chromium_no_focus");
    case "unsupported":
      throw unsupportedFieldError(answer.detail ?? "unsupported field", "fill_chromium_field");
    default:
      // The page threw, or the evaluation itself failed. The exception text is
      // dropped on purpose: it could quote the field.
      throw new FailureError("fill could not run in the page; nothing is known about the field.", {
        error_code: FAILURE_CODES.FILL_NOT_VERIFIED,
        failure_stage: "fill_chromium_script",
        failure_area: "tool_server",
        error_kind: "unknown",
        failure_command: "cdp",
      });
  }
}
