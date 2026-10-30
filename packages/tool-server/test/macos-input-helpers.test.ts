import { afterEach, describe, expect, it, vi } from "vitest";
import { FAILURE_CODES, Registry, getFailureSignal } from "@argent/registry";
import { InvalidToolInputError, UnsupportedOperationError } from "../src/utils/capability";
import { resolveDevice } from "../src/utils/device-info";
import {
  MACOS_CLICK_SETTLE_MS,
  macosAppServices,
  macosClick,
  macosInsertText,
  macosScreenshotPng,
  macosTypeText,
  parseMacosKey,
  requireMacosApp,
  resolveMacosApp,
} from "../src/utils/macos-input";
import { useMacosAppsFlag } from "./helpers/macos-apps-flag";
import { MAC_ID, MAC_URN, fakeMacosApp } from "./helpers/macos-input-fake";

const flag = useMacosAppsFlag();
const macDevice = resolveDevice(MAC_ID);

afterEach(() => {
  vi.useRealTimers();
});

describe("service plumbing", () => {
  it("declares the library only while the flag is on", () => {
    expect(macosAppServices(macDevice)).toEqual({
      macosApp: { urn: MAC_URN, options: { device: macDevice } },
    });
    flag.off();
    expect(macosAppServices(macDevice)).toEqual({});
  });

  it("refuses with the flag message before it reads the service", () => {
    const { app } = fakeMacosApp();
    expect(requireMacosApp({ macosApp: app }, "gesture-tap", macDevice)).toBe(app);
    flag.off();
    const refuse = () => requireMacosApp({ macosApp: app }, "gesture-tap", macDevice);
    expect(refuse).toThrow(UnsupportedOperationError);
    expect(refuse).toThrow(/macos-apps flag is off\. Run: argent enable macos-apps/);
  });

  it("resolves the library lazily through the registry, after the flag check", async () => {
    const { app } = fakeMacosApp();
    const registry = new Registry();
    const resolve = vi.spyOn(registry, "resolveService").mockResolvedValue(app as never);
    await expect(resolveMacosApp(registry, macDevice, "keyboard")).resolves.toBe(app);
    expect(resolve).toHaveBeenCalledWith(MAC_URN, { device: macDevice });
    flag.off();
    resolve.mockClear();
    await expect(resolveMacosApp(registry, macDevice, "keyboard")).rejects.toThrow(
      /macos-apps flag is off/
    );
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("macosClick", () => {
  it("sends only the up to run late", async () => {
    const { app, calls } = fakeMacosApp({
      "Input.mouse": (p) => {
        if (p.type === "up") throw new Error("request timed out");
        return {};
      },
    });
    await expect(macosClick(app, 0.5, 0.5)).rejects.toThrow("request timed out");
    // A late press or move would surprise the caller; a late release never does.
    expect(calls.map((c) => [c.params.type, c.opts])).toEqual([
      ["move", undefined],
      ["down", undefined],
      ["up", { runLate: true }],
    ]);
  });

  it("moves an x of exactly 1 and a y of exactly 0 just inside the window", async () => {
    vi.useFakeTimers();
    const { app, calls } = fakeMacosApp();
    const click = macosClick(app, 1, 0);
    await vi.advanceTimersByTimeAsync(MACOS_CLICK_SETTLE_MS);
    await click;
    for (const c of calls) expect(c.params).toMatchObject({ x: 1 - 1e-4, y: 1e-4 });
  });

  it("leaves every other value alone, the left and bottom edges included", async () => {
    vi.useFakeTimers();
    const { app, calls } = fakeMacosApp();
    const points: [number, number][] = [
      [0, 1],
      [0.5, 0.5],
    ];
    for (const [x, y] of points) {
      const click = macosClick(app, x, y);
      await vi.advanceTimersByTimeAsync(MACOS_CLICK_SETTLE_MS);
      await click;
    }
    expect(
      calls.filter((c) => c.params.type === "move").map((c) => [c.params.x, c.params.y])
    ).toEqual(points);
  });
});

describe("macosTypeText - the keyboard split", () => {
  it("sends US characters as one keystroke each, runs of others as one insertText, in order, awaiting each reply", async () => {
    const { app, calls, overlapped } = fakeMacosApp();
    const count = await macosTypeText(app, "Ab café ✓x", { delayMs: 0 });
    expect(count).toBe(10);
    const keys = (chars: string) => [...chars].map((c) => ["Input.key", c]);
    expect(calls.map((c) => [c.method, c.params.text])).toEqual([
      ...keys("Ab caf"),
      ["Input.insertText", "é"],
      ...keys(" "),
      ["Input.insertText", "✓"],
      ...keys("x"),
    ]);
    expect(overlapped()).toBe(false);
  });

  it("joins neighbouring characters without a US key into one insertion", async () => {
    const { app, calls } = fakeMacosApp();
    await macosTypeText(app, "a🙂é✓b", { delayMs: 0 });
    expect(calls.filter((c) => c.method === "Input.insertText").map((c) => c.params.text)).toEqual([
      "🙂é✓",
    ]);
  });

  it("presses Enter for a newline and Tab for a tab", async () => {
    const { app, calls } = fakeMacosApp();
    await macosTypeText(app, "a\nb\tc", { delayMs: 0 });
    expect(calls.map((c) => c.params.key ?? c.params.text)).toEqual([
      "a",
      "enter",
      "b",
      "tab",
      "c",
    ]);
  });

  it("stops on a library error", async () => {
    const { app } = fakeMacosApp({
      "Input.key": () => {
        throw new Error("No window");
      },
    });
    await expect(macosTypeText(app, "ab", { delayMs: 0 })).rejects.toThrow("No window");
  });

  it("waits delayMs after each character (default 50)", async () => {
    vi.useFakeTimers();
    const { app, calls } = fakeMacosApp();
    const typing = macosTypeText(app, "ab");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(49);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(50);
    await typing;
  });

  it("turns a focused element that takes no text into a 400 that says to click the field", async () => {
    const { app } = fakeMacosApp({
      "Input.insertText": () => {
        throw new Error("First responder does not accept text");
      },
    });
    const err = await macosTypeText(app, "é", { delayMs: 0 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidToolInputError);
    expect((err as Error).message).toMatch(/Click the text field first/);
  });
});

describe("macosInsertText", () => {
  it("splits text over the library's 64 KiB limit into ordered chunks", async () => {
    const { app, calls } = fakeMacosApp();
    const text = "€".repeat(30_000);
    expect(Buffer.byteLength(text)).toBeGreaterThan(64 * 1024);
    await macosInsertText(app, text);
    expect(calls).toHaveLength(2);
    const chunks = calls.map((c) => c.params.text as string);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) expect(Buffer.byteLength(chunk)).toBeLessThanOrEqual(64 * 1024);
  });
});

describe("parseMacosKey", () => {
  it("takes the library's key names, in any case", () => {
    expect(parseMacosKey("enter")).toEqual({ key: "enter", modifiers: [] });
    expect(parseMacosKey("Esc")).toEqual({ key: "esc", modifiers: [] });
    expect(parseMacosKey("page-down")).toEqual({ key: "page-down", modifiers: [] });
    expect(parseMacosKey("f12")).toEqual({ key: "f12", modifiers: [] });
  });

  it("reads modifiers joined with +", () => {
    expect(parseMacosKey("shift+tab")).toEqual({ key: "tab", modifiers: ["shift"] });
    expect(parseMacosKey("cmd+a")).toEqual({ text: "a", modifiers: ["command"] });
    expect(parseMacosKey("Ctrl+Option+arrow-left")).toEqual({
      key: "arrow-left",
      modifiers: ["control", "option"],
    });
    expect(parseMacosKey("command++")).toEqual({ text: "+", modifiers: ["command"] });
    // As a menu shows it: Command-A, not Command-Shift-A.
    expect(parseMacosKey("command+A")).toEqual({ text: "a", modifiers: ["command"] });
    expect(parseMacosKey("command+shift+A")).toEqual({
      text: "a",
      modifiers: ["command", "shift"],
    });
  });

  it("rejects an unknown name, a bare character, a dangling modifier and a character with no US key", () => {
    for (const spec of ["hyper", "a", "command+", "+", "command+nope", "command+é", "option+✓"]) {
      let err: unknown;
      try {
        parseMacosKey(spec);
      } catch (e) {
        err = e;
      }
      // A 400 in the key bucket, not a library 500 at the send.
      expect(err).toBeInstanceOf(InvalidToolInputError);
      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED);
    }
  });
});

describe("macosScreenshotPng", () => {
  it("captures a PNG at one pixel per point by default, at least 0.1", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const { app, calls } = fakeMacosApp({
      "Screenshot.capture": () => ({ base64: png.toString("base64") }),
    });
    await expect(macosScreenshotPng(app)).resolves.toEqual(png);
    await macosScreenshotPng(app, { scale: 0.01, timeoutMs: 500 });
    expect(calls.map((c) => [c.params, c.opts])).toEqual([
      [{ scale: 1 }, { timeoutMs: 15_000 }],
      [{ scale: 0.1 }, { timeoutMs: 500 }],
    ]);
  });

  it("fails when the capture is not a PNG", async () => {
    const { app } = fakeMacosApp({ "Screenshot.capture": () => ({ base64: "" }) });
    await expect(macosScreenshotPng(app)).rejects.toThrow(/returned no PNG/);
  });
});
