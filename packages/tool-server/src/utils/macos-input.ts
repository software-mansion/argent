import { PNG } from "pngjs";
import { FAILURE_CODES } from "@argent/registry";
import type { DeviceInfo, FailureError, Registry, ServiceRef } from "@argent/registry";
import { macosAppRef, type MacosAppApi } from "../blueprints/macos-app";
import { InvalidToolInputError, macosAppsUnavailableReason } from "./capability";
import { assertMacosAppsEnabled, macosFailure } from "./macos-apps";
import type { MacosModifier } from "./macos-modifiers";
import { scaleDecodedPng } from "./png-scale";

// Requests to the in-app library of a Mac app, and the click and typing
// sequences the tools compose from them. Coordinates are fractions of the area
// describe reports.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Service plumbing ────────────────────────────────────────────────────────

/**
 * The `services()` entry of a macOS branch. Empty while a Mac app cannot be
 * driven here (the flag is off, or the host is not a Mac), so a flow
 * sub-invocation (which skips the capability gate) starts no app connection
 * before the branch refuses.
 */
export function macosAppServices(device: DeviceInfo): Record<string, ServiceRef> {
  return macosAppsUnavailableReason() === null ? { macosApp: macosAppRef(device) } : {};
}

/** First step of a macOS branch whose tool declares `macosAppServices`. */
export function requireMacosApp(
  services: Record<string, unknown>,
  toolId: string,
  device?: DeviceInfo
): MacosAppApi {
  assertMacosAppsEnabled(toolId, device);
  const app = services.macosApp as MacosAppApi | undefined;
  // Only a flag flipped on between `services()` and `execute` gets here.
  if (!app) throw new Error(`Tool '${toolId}' has no Mac app service. Retry the call.`);
  return app;
}

/** First step of a macOS branch in a tool that resolves its services lazily. */
export async function resolveMacosApp(
  registry: Registry,
  device: DeviceInfo,
  toolId: string
): Promise<MacosAppApi> {
  assertMacosAppsEnabled(toolId, device);
  const ref = macosAppRef(device);
  return registry.resolveService<MacosAppApi>(ref.urn, ref.options);
}

// ── Mouse ───────────────────────────────────────────────────────────────────

/**
 * Wait after the last mouse-up. Right after a SwiftUI state change, a tree read
 * can meet an element that answers no attribute: after a toggle click 7 of 30
 * reads at 0 ms were slow, 0 of 30 at 150 ms. The wait sits here and not in the
 * flow, because the MCP auto-capture and the agent's next `describe` also read
 * the tree right after a tap.
 */
export const MACOS_CLICK_SETTLE_MS = 150;

/**
 * A point exactly on the window's right or top edge misses the window, so an x
 * of exactly 1 or a y of exactly 0 moves just inside it.
 */
const EDGE_INSET = 1e-4;

function insideMaxEdges<T extends { x: number; y: number }>(point: T): T {
  return {
    ...point,
    x: point.x === 1 ? 1 - EDGE_INSET : point.x,
    y: point.y === 0 ? EDGE_INSET : point.y,
  };
}

type MacosMouseEvent = {
  type: "down" | "up" | "move";
  x: number;
  y: number;
  button?: "left" | "right";
  clickCount?: number;
  /** The modifier keys held during the event. */
  modifiers?: MacosModifier[];
};

/** Resolves with the library's reply. */
export async function macosMouse<T = unknown>(
  app: MacosAppApi,
  event: MacosMouseEvent
): Promise<T> {
  // An up runs even after its call timed out: a late release is better than a
  // press the app holds until the next click.
  const reply = await app.call<T>(
    "Input.mouse",
    insideMaxEdges(event),
    event.type === "up" ? { runLate: true } : undefined
  );
  rememberPointer(app, event);
  return reply;
}

/**
 * Move, then `clickCount` down/up pairs with an escalating click count (a
 * double-click is counts 1 then 2), then the settle wait. Apply `modifiers` to
 * the move and every press and release.
 */
export async function macosClick(
  app: MacosAppApi,
  x: number,
  y: number,
  opts: { clickCount?: number; button?: "left" | "right"; modifiers?: MacosModifier[] } = {}
): Promise<void> {
  const modifiers = opts.modifiers?.length ? [...new Set(opts.modifiers)] : undefined;
  // Older libraries ignore modifiers. Check the move reply before pressing a button.
  const moved = await macosMouse<{ modifiers?: unknown } | undefined>(app, {
    type: "move",
    x,
    y,
    modifiers,
  });
  if (modifiers && !Array.isArray(moved?.modifiers)) {
    throw macosFailure(
      `The argent library running in ${app.bundleId} is older than this argent and cannot hold ` +
        `modifier keys, so nothing was clicked. Restart the app with restart-app to load the ` +
        `current library, then tap again.`,
      FAILURE_CODES.MACOS_APP_LIBRARY_OUTDATED,
      "macos_click_modifiers",
      "unsupported"
    );
  }
  for (let i = 1; i <= (opts.clickCount ?? 1); i++) {
    const event = { x, y, button: opts.button, clickCount: i, modifiers };
    await macosMouse(app, { ...event, type: "down" });
    await macosMouse(app, { ...event, type: "up" });
  }
  await sleep(MACOS_CLICK_SETTLE_MS);
}

/** Deltas are fractions of the window; a positive `deltaY` scrolls the content down. */
export async function macosScroll(
  app: MacosAppApi,
  event: { x: number; y: number; deltaX?: number; deltaY?: number }
): Promise<void> {
  await app.call("Input.scroll", insideMaxEdges(event));
  rememberPointer(app, event);
}

// ── Hover ───────────────────────────────────────────────────────────────────

/**
 * Where argent's pointer is in each Mac app, after its last mouse, scroll or
 * hover request, with the pid of the process that took it. The library's
 * pointer follows those requests too, so a hover starts its path there.
 */
const lastPointers = new WeakMap<MacosAppApi, { pid: number; x: number; y: number }>();

function rememberPointer(app: MacosAppApi, point: { x: number; y: number }): void {
  const pid = app.handshake()?.pid;
  if (pid === undefined) lastPointers.delete(app);
  else lastPointers.set(app, { pid, x: point.x, y: point.y });
}

/** Unknown in a process argent has not moved the pointer in yet, such as a relaunched app. */
function lastPointer(app: MacosAppApi): { x: number; y: number } | undefined {
  const last = lastPointers.get(app);
  return last && last.pid === app.handshake()?.pid ? last : undefined;
}

/** How long the pointer takes from its last point to the hover target, by default. */
export const MACOS_HOVER_DURATION_MS = 150;
/** One move per frame at 60 Hz, as a real mouse reports. */
const HOVER_STEP_MS = 16;
/**
 * Wait after the last move of a hover or a leave. Hover effects animate in:
 * AppKit's and SwiftUI's highlight and toolbar fades take about 0.2 to 0.25 s,
 * and the tree read after the hover must see the end state.
 */
export const MACOS_HOVER_SETTLE_MS = 300;

function hoverUnsupported(app: MacosAppApi, outcome: string): FailureError {
  return macosFailure(
    `The argent library running in ${app.bundleId} is older than this argent and cannot hover, ` +
      `so ${outcome}. Restart the app with restart-app to load the current library, then ` +
      `hover again.`,
    FAILURE_CODES.MACOS_APP_LIBRARY_OUTDATED,
    "macos_hover",
    "unsupported"
  );
}

/**
 * Glides argent's pointer from its last point to (x, y) in one move per
 * {@link HOVER_STEP_MS} over `durationMs`, the last one exactly at (x, y), so
 * a menu that follows the route sees one. Without a last point, one move goes
 * straight there. Then the settle wait. The pointer stays, hovering, until
 * argent's next pointer request or the user's own input in the app.
 */
export async function macosHover(
  app: MacosAppApi,
  x: number,
  y: number,
  opts: { durationMs?: number; signal?: AbortSignal } = {}
): Promise<void> {
  const from = lastPointer(app);
  const durationMs = opts.durationMs ?? MACOS_HOVER_DURATION_MS;
  const steps =
    from && (from.x !== x || from.y !== y)
      ? Math.max(1, Math.round(durationMs / HOVER_STEP_MS))
      : 1;
  // No button is down, so a cancelled hover just stops where the pointer is.
  const throwIfAborted = (sent: number) => {
    if (!opts.signal?.aborted) return;
    const err = new Error(`gesture-hover aborted - cancelled after ${sent} of ${steps} moves`);
    err.name = "AbortError";
    throw err;
  };
  for (let i = 1; i <= steps; i++) {
    throwIfAborted(i - 1);
    const point =
      i === steps || !from
        ? { x, y }
        : { x: from.x + ((x - from.x) * i) / steps, y: from.y + ((y - from.y) * i) / steps };
    const reply = await macosMouse<{ hover?: unknown } | undefined>(app, {
      type: "move",
      ...point,
    });
    // An older library moves the pointer without keeping a hover.
    if (i === 1 && reply?.hover !== true) {
      throw hoverUnsupported(app, "the pointer did not stay over the app");
    }
    if (i < steps) await sleep(HOVER_STEP_MS);
  }
  throwIfAborted(steps);
  await sleep(MACOS_HOVER_SETTLE_MS);
}

/** Moves argent's pointer out of every view, which ends a hover, then the settle wait. */
export async function macosHoverLeave(app: MacosAppApi): Promise<void> {
  try {
    await app.call("Input.mouse", { type: "leave" });
  } catch (err) {
    if (err instanceof Error && /type must be down, up or move/i.test(err.message)) {
      throw hoverUnsupported(app, "nothing changed");
    }
    throw err;
  }
  // Out of the window: the next hover goes straight to its point.
  lastPointers.delete(app);
  await sleep(MACOS_HOVER_SETTLE_MS);
}

// ── Screenshot ──────────────────────────────────────────────────────────────

/** A capture of a large Retina window is over 1 MiB of base64. */
const SCREENSHOT_TIMEOUT_MS = 15_000;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * The app window as PNG bytes, `scale` pixels per point (1.0 by default: one
 * pixel per point, as a Chromium capture is one pixel per CSS pixel; at least 0.1).
 */
export async function macosScreenshotPng(
  app: MacosAppApi,
  opts: { scale?: number; timeoutMs?: number } = {}
): Promise<Buffer> {
  const capture = await app.call<{ base64?: unknown } | undefined>(
    "Screenshot.capture",
    { scale: Math.max(0.1, opts.scale ?? 1.0) },
    { timeoutMs: opts.timeoutMs ?? SCREENSHOT_TIMEOUT_MS }
  );
  const bytes = Buffer.from(typeof capture?.base64 === "string" ? capture.base64 : "", "base64");
  if (bytes.length <= PNG_SIGNATURE.length || PNG_SIGNATURE.some((b, i) => bytes[i] !== b)) {
    throw new Error(
      `The in-app library of ${app.bundleId} returned no PNG for Screenshot.capture ` +
        `(${bytes.length} bytes).`
    );
  }
  return bytes;
}

/**
 * The long side of a screenshot taken without `scale`, as a TV capture gets
 * 576 px. A wider window keeps {@link MACOS_MIN_PIXELS_PER_POINT} instead.
 */
const MACOS_DEFAULT_LONG_SIDE = 768;
/** At 0.6 pixels per point the smallest common text (10 pt) still reads; at 0.5 it blurs. */
const MACOS_MIN_PIXELS_PER_POINT = 0.6;

/** A capture at one pixel per point downscaled to the default size, never upscaled. */
export function fitMacosDefaultSize(png: Buffer): Buffer {
  // The width and height in the IHDR chunk: decode only a capture that needs the resample.
  const longSide = Math.max(png.readUInt32BE(16), png.readUInt32BE(20));
  if (longSide <= MACOS_DEFAULT_LONG_SIDE) return png;
  const scale = Math.max(MACOS_MIN_PIXELS_PER_POINT, MACOS_DEFAULT_LONG_SIDE / longSide);
  return PNG.sync.write(scaleDecodedPng(PNG.sync.read(png), scale));
}

// ── Keyboard ────────────────────────────────────────────────────────────────

/**
 * The keyboard tool's key names on a Mac app, the names the library takes.
 * `delete` is the forward delete, as on Chromium.
 */
const MACOS_KEY_NAMES = new Set([
  ..."enter return escape esc backspace delete tab space home end page-up page-down".split(" "),
  ...["up", "down", "left", "right"].map((d) => `arrow-${d}`),
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);

const MODIFIER_NAMES: Record<string, MacosModifier> = {
  command: "command",
  cmd: "command",
  shift: "shift",
  option: "option",
  opt: "option",
  alt: "option",
  control: "control",
  ctrl: "control",
};

/** Printable ASCII: every character of it has a key on the US layout, with or without Shift. */
const hasUsKey = (char: string) => /^[\x20-\x7e]$/.test(char);

/**
 * Parses a `keyboard` key: a name from MACOS_KEY_NAMES, optionally after
 * modifiers joined with `+` (`shift+tab`, `command+a`, `command++`). One
 * character with a US key is accepted only after a modifier, as a shortcut.
 */
export function parseMacosKey(spec: string): {
  key?: string;
  text?: string;
  modifiers: MacosModifier[];
} {
  const modifiers: MacosModifier[] = [];
  let rest = spec;
  for (;;) {
    const plus = rest.indexOf("+");
    // A `+` at index 0 is the key itself (`command++`), not a separator.
    if (plus <= 0) break;
    const modifier = MODIFIER_NAMES[rest.slice(0, plus).toLowerCase()];
    if (!modifier || plus === rest.length - 1) break;
    if (!modifiers.includes(modifier)) modifiers.push(modifier);
    rest = rest.slice(plus + 1);
  }
  const lower = rest.toLowerCase();
  if (MACOS_KEY_NAMES.has(lower)) return { key: lower, modifiers };
  if (modifiers.length > 0 && hasUsKey(rest)) {
    // `command+A` is how a menu shows Command-A; the library adds Shift for a
    // capital, so a letter goes lowercase and Shift only when it is named.
    return { text: /^[A-Z]$/.test(rest) ? rest.toLowerCase() : rest, modifiers };
  }
  throw new InvalidToolInputError(
    `Unknown key "${spec}". Supported on a Mac app: ${[...MACOS_KEY_NAMES].join(", ")}, ` +
      "each optionally after modifiers joined with + (command, shift, option, control), " +
      "and one character of the US keyboard after a modifier, such as command+a.",
    {
      error_code: FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED,
      failure_stage: "keyboard_named_key_macos",
      error_kind: "unsupported",
    }
  );
}

/**
 * One request per keystroke, down and up: the app performs a shortcut after its
 * reply, so Command-Q quits it with no request left to fail.
 */
async function pressKey(
  app: MacosAppApi,
  press: { key?: string; text?: string; modifiers: MacosModifier[] }
): Promise<void> {
  await app.call("Input.key", {
    key: press.key,
    text: press.text,
    modifiers: press.modifiers.length > 0 ? press.modifiers : undefined,
  });
}

/** Presses one `keyboard` key spec (see `parseMacosKey`). */
export async function macosPressKey(app: MacosAppApi, spec: string): Promise<void> {
  await pressKey(app, parseMacosKey(spec));
}

/**
 * Inserts text at the focused element, ordered after every key request sent
 * before it. Never touches the pasteboard. The library takes at most 64 KiB
 * per request; 16 Ki code points stay under it in UTF-8.
 */
export async function macosInsertText(app: MacosAppApi, text: string): Promise<void> {
  const codePoints = [...text];
  for (let i = 0; i < codePoints.length; i += 16 * 1024) {
    try {
      await app.call("Input.insertText", { text: codePoints.slice(i, i + 16 * 1024).join("") });
    } catch (err) {
      // The focused element takes no text: the caller's state to fix, so a 400 with the fix.
      if (err instanceof Error && /does not accept text/i.test(err.message)) {
        throw new InvalidToolInputError(
          `${err.message}. Click the text field first (gesture-tap on it), then retry.`,
          {
            error_code: FAILURE_CODES.KEYBOARD_INPUT_NOT_FOCUSED,
            failure_stage: "macos_insert_text_not_focused",
            error_kind: "validation",
          }
        );
      }
      throw err;
    }
  }
}

/**
 * Types `text` in order: a printable ASCII character as a keystroke (the
 * library adds Shift), a newline as Enter, a tab as Tab, and every run of other
 * characters (accents, symbols, emoji) as one insertion. Each request is
 * awaited before the next. Returns the number of characters typed.
 */
export async function macosTypeText(
  app: MacosAppApi,
  text: string,
  opts: { delayMs?: number } = {}
): Promise<number> {
  const delay = opts.delayMs ?? 50;
  let pending = "";
  let count = 0;
  const flush = async (): Promise<void> => {
    if (!pending) return;
    await macosInsertText(app, pending);
    pending = "";
    await sleep(delay);
  };
  let afterCr = false;
  for (const char of text) {
    count++;
    // CRLF is one line break: its LF presses nothing.
    const crlf = afterCr && char === "\n";
    afterCr = char === "\r";
    if (crlf) continue;
    if (char === "\n" || char === "\r" || char === "\t") {
      await flush();
      await pressKey(app, { key: char === "\t" ? "tab" : "enter", modifiers: [] });
    } else if (hasUsKey(char)) {
      await flush();
      await pressKey(app, { text: char, modifiers: [] });
    } else {
      pending += char;
      continue;
    }
    await sleep(delay);
  }
  await flush();
  return count;
}
