import { PNG } from "pngjs";
import { FAILURE_CODES } from "@argent/registry";
import type { DeviceInfo, Registry, ServiceRef } from "@argent/registry";
import { macosAppRef, type MacosAppApi } from "../blueprints/macos-app";
import { InvalidToolInputError } from "./capability";
import { assertMacosAppsEnabled, isMacosAppsEnabled } from "./macos-apps";
import { scaleDecodedPng } from "./png-scale";

// Requests to the in-app library of a Mac app, and the click and typing
// sequences the tools compose from them. Coordinates are fractions of the area
// describe reports.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type MacosModifier = "command" | "shift" | "option" | "control";

// ── Service plumbing ────────────────────────────────────────────────────────

/**
 * The `services()` entry of a macOS branch. Empty while the flag is off, so a
 * flow sub-invocation (which skips the capability gate) starts no app
 * connection before the branch refuses.
 */
export function macosAppServices(device: DeviceInfo): Record<string, ServiceRef> {
  return isMacosAppsEnabled() ? { macosApp: macosAppRef(device) } : {};
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
};

export async function macosMouse(app: MacosAppApi, event: MacosMouseEvent): Promise<void> {
  // An up runs even after its call timed out: a late release is better than a
  // press the app holds until the next click.
  await app.call(
    "Input.mouse",
    insideMaxEdges(event),
    event.type === "up" ? { runLate: true } : undefined
  );
}

/**
 * Move, then `clickCount` down/up pairs with an escalating click count (a
 * double-click is counts 1 then 2), then the settle wait.
 */
export async function macosClick(
  app: MacosAppApi,
  x: number,
  y: number,
  opts: { clickCount?: number; button?: "left" | "right" } = {}
): Promise<void> {
  await macosMouse(app, { type: "move", x, y });
  for (let i = 1; i <= (opts.clickCount ?? 1); i++) {
    const event = { x, y, button: opts.button, clickCount: i };
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
  for (const char of text) {
    count++;
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
