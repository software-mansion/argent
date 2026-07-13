import { describe, expect, it, vi } from "vitest";
import type { Registry } from "@argent/registry";
import { createRegistry } from "../src/utils/setup-registry";
import { parseUiAutomatorDump } from "../src/tools/describe/platforms/android/uiautomator-parser";
import { findDescribeMatches } from "../src/tools/describe/selectors";
import {
  createKeyboardScenarioTool,
  discoverEnglishQwerty,
  parseDescribeScreen,
} from "../src/tools/keyboard-scenario";

const IOS = "11111111-1111-1111-1111-111111111111";
const ANDROID = "emulator-5554";

function inputLine(value: string, options: { focused?: boolean; height?: number } = {}): string {
  const flags = options.focused ? " [focused]" : "";
  return `  AXTextField "Message" value="${value}" id="chat-input"${flags}  (0.100, 0.400, 0.800, ${(options.height ?? 0.04).toFixed(3)})`;
}

const KEY_LABELS = [..."abcdefghijklmnopqrstuvwxyz"];

function keyboardLines(
  options: {
    shift?: boolean;
    omit?: string;
    uppercase?: boolean;
    packageName?: string;
    role?: string;
  } = {}
): string[] {
  const lines = KEY_LABELS.filter((label) => label !== options.omit).map((label, index) => {
    const visibleLabel = options.uppercase ? label.toUpperCase() : label;
    const packagePart = options.packageName ? ` package="${options.packageName}"` : "";
    const flags = options.packageName ? " [clickable]" : "";
    return `  ${options.role ?? "AXButton"} "${visibleLabel}"${packagePart}${flags}  (${(0.02 + (index % 10) * 0.095).toFixed(3)}, ${(0.59 + Math.floor(index / 10) * 0.08).toFixed(3)}, 0.070, 0.060)`;
  });
  const packagePart = options.packageName ? ` package="${options.packageName}"` : "";
  const flags = options.packageName ? " [clickable]" : "";
  const role = options.role ?? "AXButton";
  lines.push(`  ${role} "space"${packagePart}${flags}  (0.250, 0.850, 0.500, 0.070)`);
  lines.push(`  ${role} "delete"${packagePart}${flags}  (0.870, 0.760, 0.100, 0.070)`);
  if (options.shift !== false) {
    lines.push(`  ${role} "shift"${packagePart}${flags}  (0.030, 0.760, 0.100, 0.070)`);
  }
  return lines;
}

function screen(
  value: string,
  options: {
    keyboard?: boolean;
    focused?: boolean;
    height?: number;
    shift?: boolean;
    uppercase?: boolean;
  } = {}
): { source: string; description: string } {
  return {
    source: "ax-service",
    description: [
      "Source: ax-service",
      "Mode: flat",
      "",
      "ROOT  AXGroup (0.000, 0.000, 1.000, 1.000)",
      "",
      inputLine(value, options),
      ...(options.keyboard === false
        ? []
        : keyboardLines({ shift: options.shift, uppercase: options.uppercase })),
    ].join("\n"),
  };
}

function mockRegistry(describes: Array<{ source: string; description: string }>): Registry {
  let describeIndex = 0;
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "describe") {
        const snapshot = describes[Math.min(describeIndex, describes.length - 1)];
        describeIndex += 1;
        return snapshot;
      }
      if (id === "gesture-tap") return { tapped: true };
      throw new Error(`Unexpected tool ${id}`);
    }),
  } as unknown as Registry;
}

function params(
  text: string,
  assertions: {
    finalText?: string;
    keyboardVisible?: boolean;
    inputFocused?: boolean;
    wrapped?: boolean;
  } = { keyboardVisible: true }
) {
  return {
    udid: IOS,
    input: { identifier: "chat-input" },
    text,
    perKeyDelayMs: 0,
    keyboardTimeoutMs: 10,
    settleTimeoutMs: 250,
    assertions: { keyboardVisible: true, ...assertions },
  };
}

describe("keyboard-scenario", () => {
  it("parses compact describe lines without surfacing the full tree", () => {
    const snapshot = parseDescribeScreen(screen("hello", { focused: true }));
    const input = snapshot.elements.find((element) => element.identifier === "chat-input");

    expect(snapshot.source).toBe("ax-service");
    expect(input).toMatchObject({
      role: "AXTextField",
      label: "Message",
      value: "hello",
      identifier: "chat-input",
      focused: true,
      frame: { x: 0.1, y: 0.4, width: 0.8, height: 0.04 },
    });
  });

  it("accepts a visible English QWERTY tree and rejects app buttons alone", () => {
    const keyboard = parseDescribeScreen(screen("", { keyboard: true }));
    const appOnly = parseDescribeScreen(screen("", { keyboard: false }));

    expect(discoverEnglishQwerty(keyboard.elements)?.letters.size).toBe(26);
    expect(discoverEnglishQwerty(keyboard.elements)?.space.label).toBe("space");
    expect(discoverEnglishQwerty(appOnly.elements)).toBeNull();
  });

  it("rejects an app-owned custom keypad that only matches the old loose signature", () => {
    const customLines = keyboardLines().filter((line) =>
      /"[a-j]"|"space"|"shift"|"delete"/.test(line)
    );
    const custom = parseDescribeScreen({
      source: "ax-service",
      description: [inputLine(""), ...customLines].join("\n"),
    });

    expect(discoverEnglishQwerty(custom.elements)).toBeNull();
  });

  it("accepts clickable Android View keys only with native IME package provenance", () => {
    const packageName = "com.google.android.inputmethod.latin";
    const labels = [...KEY_LABELS, "space", "shift", "delete"];
    const nodes = labels
      .map((label, index) => {
        const column = index % 10;
        const row = Math.floor(index / 10);
        const left = 20 + column * 100;
        const top = 1400 + row * 180;
        return `<node index="${index}" text="" resource-id="" class="android.view.View" package="${packageName}" content-desc="${label}" clickable="true" enabled="true" focused="false" bounds="[${left},${top}][${left + 80},${top + 120}]" />`;
      })
      .join("");
    const tree = parseUiAutomatorDump(
      `<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0">${nodes}</hierarchy>`,
      1080,
      2400
    );
    const imeNodes = findDescribeMatches(tree, { package: "inputmethod" }).map((node) => ({
      ...node,
      line: "",
    }));

    expect(imeNodes).toHaveLength(labels.length);
    expect(imeNodes.every((node) => node.role === "View" && node.clickable)).toBe(true);
    expect(discoverEnglishQwerty(imeNodes, "android")?.letters.size).toBe(26);
  });

  it("rejects a package-less legacy Android app QWERTY end to end", async () => {
    let fullReads = 0;
    const registry = {
      invokeTool: vi.fn(async (id: string, args: Record<string, unknown>) => {
        if (id === "gesture-tap") return { tapped: true };
        if (id !== "describe") throw new Error(`Unexpected tool ${id}`);
        if (args.selector) return { source: "uiautomator", description: "" };
        fullReads += 1;
        const snapshot =
          fullReads === 1
            ? screen("", { keyboard: false })
            : screen("", { focused: true, keyboard: true });
        return { ...snapshot, source: "uiautomator" };
      }),
    } as unknown as Registry;
    const tool = createKeyboardScenarioTool(registry);

    const result = await tool.execute({}, { ...params("h"), udid: ANDROID, keyboardTimeoutMs: 10 });

    expect(result).toMatchObject({ success: false, error: { stage: "keyboard" } });
    expect(
      (registry.invokeTool as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([id]) => id === "gesture-tap"
      )
    ).toHaveLength(1);
  });

  it("taps visible keys, records word checkpoints, and verifies focus and wrapping", async () => {
    const registry = mockRegistry([
      screen("", { keyboard: false }),
      screen("", { focused: true }),
      screen("hi ", { focused: true }),
      screen("hi go", { focused: true, height: 0.08 }),
      screen("hi go", { focused: true, height: 0.08 }),
    ]);
    const tool = createKeyboardScenarioTool(registry);

    const result = await tool.execute({}, params("hi go", { inputFocused: true, wrapped: true }));

    expect(result.success).toBe(true);
    expect(result.typed).toBe("hi go");
    expect(result.checkpoints).toEqual([
      expect.objectContaining({ charIndex: 3, value: "hi ", keyboardVisible: true }),
      expect.objectContaining({
        charIndex: 5,
        value: "hi go",
        focused: true,
        keyboardVisible: true,
        wrapped: true,
      }),
    ]);
    expect(result.assertions).toMatchObject({
      finalText: { expected: "hi go", actual: "hi go", passed: true },
      keyboardVisible: { expected: true, actual: true, passed: true },
      inputFocused: { expected: true, actual: true, passed: true, available: true },
      wrapped: { expected: true, actual: true, passed: true, available: true },
    });

    const calls = (registry.invokeTool as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.filter(([id]) => id === "gesture-tap")).toHaveLength(6);
    expect(calls.some(([id]) => id === "keyboard")).toBe(false);
  });

  it("stops immediately when the keyboard disappears at a word checkpoint", async () => {
    const registry = mockRegistry([
      screen("", { keyboard: false }),
      screen("", { focused: true }),
      screen("hi ", { keyboard: false, focused: true }),
    ]);
    const tool = createKeyboardScenarioTool(registry);

    const result = await tool.execute({}, params("hi x"));

    expect(result).toMatchObject({
      success: false,
      typed: "hi ",
      error: { stage: "keyboard", message: expect.stringContaining("stale coordinates") },
    });
    const taps = (registry.invokeTool as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([id]) => id === "gesture-tap"
    );
    // Input + h + i + space. The trailing x is never tapped.
    expect(taps).toHaveLength(4);
  });

  it("polls through delayed space/autocorrect state before continuing", async () => {
    const registry = mockRegistry([
      screen("", { keyboard: false }),
      screen("", { focused: true }),
      screen("hi", { focused: true }),
      screen("hi ", { focused: true }),
      screen("hi ", { focused: true }),
    ]);
    const tool = createKeyboardScenarioTool(registry);

    const result = await tool.execute({}, params("hi "));

    expect(result.success).toBe(true);
    expect(result.checkpoints).toEqual([
      expect.objectContaining({ charIndex: 3, value: "hi ", keyboardVisible: true }),
    ]);
    expect(
      (registry.invokeTool as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([id]) => id === "describe"
      ).length
    ).toBeGreaterThanOrEqual(4);
  });

  it("uses the visible shift key for an uppercase character", async () => {
    const registry = mockRegistry([
      screen("", { keyboard: false }),
      screen("", { focused: true, shift: true }),
      screen("H", { focused: true, shift: true }),
      screen("H", { focused: true, shift: true }),
    ]);
    const tool = createKeyboardScenarioTool(registry);

    const result = await tool.execute({}, params("H"));

    expect(result.success).toBe(true);
    const taps = (registry.invokeTool as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([id]) => id === "gesture-tap"
    );
    // Input, shift, H.
    expect(taps).toHaveLength(3);
  });

  it("does not re-toggle one-shot shift after an uppercase first character", async () => {
    const registry = mockRegistry([
      screen("", { keyboard: false }),
      screen("", { focused: true, shift: true, uppercase: true }),
      screen("Hi", { focused: true, shift: true }),
      screen("Hi", { focused: true, shift: true }),
    ]);
    const tool = createKeyboardScenarioTool(registry);

    const result = await tool.execute({}, params("Hi"));

    expect(result.success).toBe(true);
    const taps = (registry.invokeTool as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([id]) => id === "gesture-tap"
    );
    // Input, H, i — no shift tap, because the initial visible keyboard was
    // already uppercase and native shift becomes lowercase after H.
    expect(taps).toHaveLength(3);
  });

  it("reports focus as unavailable instead of guessing from keyboard visibility", async () => {
    const registry = mockRegistry([
      screen("", { keyboard: false }),
      screen(""),
      screen("h"),
      screen("h"),
    ]);
    const tool = createKeyboardScenarioTool(registry);

    const result = await tool.execute({}, params("h", { inputFocused: true }));

    expect(result.success).toBe(false);
    expect(result.assertions.inputFocused).toEqual({
      expected: true,
      actual: null,
      passed: false,
      available: false,
    });
    expect(result.error?.stage).toBe("inspection");
  });

  it("fails closed when the requested character is not a visible soft key", async () => {
    const registry = mockRegistry([screen("", { keyboard: false }), screen("", { focused: true })]);
    const tool = createKeyboardScenarioTool(registry);

    const result = await tool.execute({}, params("!"));

    expect(result).toMatchObject({
      success: false,
      typed: "",
      error: {
        stage: "keyboard",
        message: expect.stringContaining("No currently visible soft key"),
      },
    });
    expect(
      (registry.invokeTool as ReturnType<typeof vi.fn>).mock.calls.some(([id]) => id === "keyboard")
    ).toBe(false);
  });

  it("surfaces predictive-text changes as an exact final-value failure", async () => {
    const registry = mockRegistry([
      screen("", { keyboard: false }),
      screen("", { focused: true }),
      screen("gone", { focused: true }),
    ]);
    const tool = createKeyboardScenarioTool(registry);

    const result = await tool.execute({}, params("go"));

    expect(result.success).toBe(false);
    expect(result.assertions.finalText).toMatchObject({
      expected: "go",
      actual: "gone",
      passed: false,
    });
    expect(result.error?.stage).toBe("inspection");
  });

  it("uses approved final autocorrection instead of raw typed text at the final checkpoint", async () => {
    const registry = mockRegistry([
      screen("", { keyboard: false }),
      screen("", { focused: true }),
      screen("gone", { focused: true }),
    ]);
    const tool = createKeyboardScenarioTool(registry);

    const result = await tool.execute({}, params("go", { finalText: "gone" }));

    expect(result.success).toBe(true);
    expect(result.checkpoints).toEqual([
      expect.objectContaining({ charIndex: 2, value: "gone", keyboardVisible: true }),
    ]);
  });

  it("lets final inspection own an expected keyboard dismissal", async () => {
    const registry = mockRegistry([
      screen("", { keyboard: false }),
      screen("", { focused: true }),
      screen("h", { keyboard: false, focused: true }),
    ]);
    const tool = createKeyboardScenarioTool(registry);

    const result = await tool.execute({}, params("h", { keyboardVisible: false }));

    expect(result.success).toBe(true);
    expect(result.assertions.keyboardVisible).toMatchObject({
      expected: false,
      actual: false,
      passed: true,
    });
    expect(result.checkpoints).toEqual([
      expect.objectContaining({ charIndex: 1, value: "h", keyboardVisible: false }),
    ]);
  });

  it("is registered with a compact generated schema", () => {
    const tool = createRegistry().getTool("keyboard-scenario");

    expect(tool).toBeDefined();
    expect(tool?.inputSchema).toMatchObject({
      type: "object",
      required: expect.arrayContaining(["udid", "input", "text"]),
    });
  });
});
