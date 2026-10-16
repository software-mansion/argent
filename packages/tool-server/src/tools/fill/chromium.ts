import type { DeviceInfo, Registry } from "@argent/registry";
import { FAILURE_CODES, FailureError, getFailureSignal } from "@argent/registry";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import {
  noFocusedFieldError,
  notVerifiedError,
  pageNotAnsweringError,
  pageNotFinishedError,
  unsupportedFieldError,
} from "./errors";
import type { FillResult } from "./types";

/** What the page script answers. Never text: only a verdict. */
interface PageFillAnswer {
  status: "ok" | "no_focus" | "unsupported" | "error";
  detail?: string;
  verified?: boolean;
}

/**
 * The page script. It finds the focused editable — through open shadow roots
 * and same-origin frames — selects its content and replaces it with the
 * page's own editing commands, so the page sees a user edit: `beforeinput`
 * and `input` fire, React's value tracker and rich-text editors update. A text
 * control whose page refused the command, so it still holds its old text, gets
 * the native value setter and `input` and `change` events instead. A control
 * the browser keeps from holding the text (maxlength, a number or email
 * input's value rules) is refused before anything changes.
 *
 * The comparison happens in the page, after a task boundary so an editor that
 * restores its model on a microtask has done so. Only a boolean comes
 * back; the field may be a password.
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
    while (el && /^i?frame$/.test(String(el.tagName).toLowerCase())) {
      let inner = null;
      try { inner = el.contentDocument; } catch (e) { inner = null; }
      // A cross-origin or sandboxed frame hides its document.
      if (!inner) return { status: "unsupported", detail: "focus is in a cross-origin frame, which fill cannot reach" };
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
    // Typed text stops at maxlength, which the value setter ignores.
    const limited = tag === "textarea" || /^(text|search|url|tel|email|password)$/.test(type);
    if (limited && el.maxLength >= 0 && text.length > el.maxLength) {
      return { status: "unsupported", detail: "the text is longer than its maxlength of " + el.maxLength };
    }
    // A number input holds only a valid number and an email input drops the
    // whitespace around an address, typed or set. A detached input of the
    // same type applies the browser's own rules.
    if (type === "number" || type === "email") {
      const probe = doc.createElement("input");
      probe.type = type;
      probe.multiple = el.multiple === true;
      probe.value = text;
      if (probe.value !== text) {
        return {
          status: "unsupported",
          detail: type === "number" ? "a number input holds only a valid number" : "an email input drops the whitespace around an address",
        };
      }
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

    const before = read();
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
    // A refused edit leaves the old text. Other text is the browser's or the
    // page's own rewrite, which the setter must not override.
    if (!verified && control && read() === before) {
      const proto = tag === "textarea" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, text);
      el.dispatchEvent(new win.Event("input", { bubbles: true }));
      el.dispatchEvent(new win.Event("change", { bubbles: true }));
      verified = await settle();
    }
    return { status: "ok", verified: verified };
  } catch (e) {
    return { status: "error" };
  }
})()`;
}

/** How long a no-op evaluation may take before fill decides the page is blocked. */
const PAGE_ANSWER_TIMEOUT_MS = 2_000;
const FILL_TIMEOUT_MS = 10_000;

async function withTimeoutError<T>(send: () => Promise<T>, timeoutError: () => Error): Promise<T> {
  try {
    return await send();
  } catch (err) {
    if (getFailureSignal(err)?.error_code === FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT) {
      throw timeoutError();
    }
    throw err;
  }
}

export async function fillChromium(
  registry: Registry,
  device: DeviceInfo,
  text: string
): Promise<FillResult> {
  const ref = chromiumCdpRef(device);
  const api = await registry.resolveService<ChromiumCdpApi>(ref.urn, ref.options);
  // A page under a JavaScript dialog queues every evaluation and runs it when
  // the dialog closes. A no-op goes first, so a blocked page is sent nothing
  // that writes.
  await withTimeoutError(
    () => api.cdp.send("Runtime.evaluate", { expression: "0" }, PAGE_ANSWER_TIMEOUT_MS),
    () => pageNotAnsweringError("fill_chromium_page_blocked")
  );
  const out = (await withTimeoutError(
    () =>
      api.cdp.send(
        "Runtime.evaluate",
        { expression: buildChromiumFillScript(text), awaitPromise: true, returnByValue: true },
        FILL_TIMEOUT_MS
      ),
    () => pageNotFinishedError("fill_chromium_timeout")
  )) as { result?: { value?: PageFillAnswer } };
  const answer = out.result?.value;
  switch (answer?.status) {
    case "ok":
      if (answer.verified === true) {
        return { verified: true };
      }
      throw notVerifiedError("fill_chromium_not_verified");
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
