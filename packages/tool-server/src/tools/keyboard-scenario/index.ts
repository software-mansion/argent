import { z } from "zod";
import type { Registry, ToolCapability, ToolContext, ToolDefinition } from "@argent/registry";
import { resolveDevice } from "../../utils/device-info";
import { invokeSubTool } from "../../utils/sub-invoke";
import { settleWithin, sleepOrAbort } from "../../utils/timing";
import type { DescribeFrame, DescribeNode } from "../describe/contract";
import {
  describeSelectorSchema,
  matchesDescribeSelector,
  type DescribeSelector,
} from "../describe/selectors";

const DEFAULT_KEY_DELAY_MS = 75;
const DEFAULT_KEYBOARD_TIMEOUT_MS = 5_000;
const DEFAULT_SETTLE_TIMEOUT_MS = 1_500;
const KEYBOARD_POLL_MS = 250;
const SETTLE_POLL_MS = 100;
const WRAP_HEIGHT_DELTA = 0.005;
const KEYBOARD_TOP_LIMIT = 0.45;
const QWERTY_LETTERS = "abcdefghijklmnopqrstuvwxyz";
const ANDROID_IME_PACKAGES = [
  "com.google.android.inputmethod",
  "com.android.inputmethod",
  "com.samsung.android.honeyboard",
  "com.touchtype.swiftkey",
  "com.microsoft.swiftkey",
  "org.futo.inputmethod",
] as const;

const assertionSchema = z
  .object({
    finalText: z
      .string()
      .optional()
      .describe("Exact final input value. Defaults to the value before the scenario plus `text`."),
    keyboardVisible: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "Whether the visible soft keyboard must remain present after typing (default true)."
      ),
    inputFocused: z
      .boolean()
      .optional()
      .describe(
        "Optional focus assertion. Fails as unavailable when the platform accessibility provider does not expose focus."
      ),
    wrapped: z
      .boolean()
      .optional()
      .describe(
        "Optional line-wrap assertion, derived from whether the input frame height grew from its focused baseline."
      ),
  })
  .default({ keyboardVisible: true });

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe("Target iOS simulator or Android emulator/device id from `list-devices`."),
  input: describeSelectorSchema.describe(
    "Selector for the text input. Every provided field matches as a case-insensitive substring."
  ),
  text: z
    .string()
    .min(1)
    .describe(
      "Text to enter by tapping the visible soft keyboard. Only keys visible on the current English QWERTY layout are used."
    ),
  bundleId: z
    .string()
    .optional()
    .describe("Optional iOS app bundle id used by describe's native fallback."),
  perKeyDelayMs: z
    .number()
    .int()
    .min(0)
    .max(2_000)
    .optional()
    .default(DEFAULT_KEY_DELAY_MS)
    .describe(`Delay after each visible key tap (default ${DEFAULT_KEY_DELAY_MS}ms).`),
  keyboardTimeoutMs: z
    .number()
    .int()
    .positive()
    .max(30_000)
    .optional()
    .default(DEFAULT_KEYBOARD_TIMEOUT_MS)
    .describe(
      `Time to wait for a visible English QWERTY key tree (default ${DEFAULT_KEYBOARD_TIMEOUT_MS}ms).`
    ),
  settleTimeoutMs: z
    .number()
    .int()
    .positive()
    .max(10_000)
    .optional()
    .default(DEFAULT_SETTLE_TIMEOUT_MS)
    .describe(
      `Time to poll for the expected input value after a word or final key (default ${DEFAULT_SETTLE_TIMEOUT_MS}ms).`
    ),
  assertions: assertionSchema,
});

type Params = z.infer<typeof zodSchema>;

interface ScreenElement extends DescribeNode {
  line: string;
}

interface ScreenSnapshot {
  source: string;
  elements: ScreenElement[];
}

interface KeyboardLayout {
  letters: Map<string, ScreenElement>;
  space: ScreenElement;
  shift?: ScreenElement;
  direct: Map<string, ScreenElement>;
}

type KeyboardPlatform = "ios" | "android";

interface Checkpoint {
  charIndex: number;
  value: string | null;
  focused: boolean | null;
  keyboardVisible: boolean;
  inputFrame: DescribeFrame | null;
  wrapped: boolean | null;
}

interface AssertionResult<T> {
  expected: T;
  actual: T | null;
  passed: boolean;
  available: boolean;
}

interface ScenarioResult {
  success: boolean;
  typed: string;
  checkpoints: Checkpoint[];
  assertions: {
    finalText: AssertionResult<string>;
    keyboardVisible: AssertionResult<boolean>;
    inputFocused?: AssertionResult<boolean>;
    wrapped?: AssertionResult<boolean>;
  };
  error?: { stage: "input" | "keyboard" | "typing" | "inspection"; message: string };
}

type ScenarioStage = NonNullable<ScenarioResult["error"]>["stage"];

const capability: ToolCapability = {
  apple: { simulator: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
};

const FRAME_RE = /\(([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\)\s*$/;
const ATTR_RE = /\b(label|value|id|package)="((?:\\.|[^"\\])*)"/g;

function unescapeLineValue(value: string): string {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

export function parseDescribeScreen(result: unknown): ScreenSnapshot {
  const record =
    typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {};
  const description = typeof record.description === "string" ? record.description : "";
  const source = typeof record.source === "string" ? record.source : "unknown";
  const elements: ScreenElement[] = [];

  for (const line of description.split("\n")) {
    if (line.trimStart().startsWith("ROOT ")) continue;
    const frameMatch = FRAME_RE.exec(line);
    if (!frameMatch) continue;
    const trimmed = line.trim();
    const role = trimmed.split(/\s+/, 1)[0];
    if (!role) continue;
    const attrs: Record<string, string> = {};
    for (const match of line.matchAll(ATTR_RE)) {
      attrs[match[1]!] = unescapeLineValue(match[2]!);
    }
    // A label is the first quoted token and intentionally has no `label=` prefix
    // in describe's compact rendering.
    const labelMatch = /\s"((?:\\.|[^"\\])*)"/.exec(line);
    const flagsMatch = /\[([^\]]+)]/.exec(line);
    const flags = new Set(
      (flagsMatch?.[1] ?? "")
        .split(",")
        .map((flag) => flag.trim())
        .filter(Boolean)
    );
    elements.push({
      role,
      frame: {
        x: Number(frameMatch[1]),
        y: Number(frameMatch[2]),
        width: Number(frameMatch[3]),
        height: Number(frameMatch[4]),
      },
      children: [],
      label: labelMatch ? unescapeLineValue(labelMatch[1]!) : attrs.label,
      value: attrs.value,
      identifier: attrs.id,
      packageName: attrs.package,
      clickable: flags.has("clickable") ? true : undefined,
      focused: flags.has("focused") ? true : undefined,
      line,
    });
  }

  return { source, elements };
}

function center(frame: DescribeFrame): { x: number; y: number } {
  return { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
}

function elementText(element: ScreenElement): string[] {
  return [element.label, element.value, element.identifier]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.trim());
}

function isButtonLike(element: ScreenElement): boolean {
  const role = element.role.toLowerCase();
  return role.includes("button") || role.includes("key");
}

function isKeyboardRegion(element: ScreenElement): boolean {
  return (
    element.frame.y >= KEYBOARD_TOP_LIMIT && element.frame.width > 0 && element.frame.height > 0
  );
}

function isNativeAndroidIme(element: ScreenElement): boolean {
  const packageName = element.packageName?.toLowerCase();
  return Boolean(
    packageName && ANDROID_IME_PACKAGES.some((prefix) => packageName.startsWith(prefix))
  );
}

export function discoverEnglishQwerty(
  elements: ScreenElement[],
  platform: KeyboardPlatform = "ios"
): KeyboardLayout | null {
  const imeCandidates = elements.filter(
    (element) =>
      isNativeAndroidIme(element) &&
      isKeyboardRegion(element) &&
      (element.clickable || isButtonLike(element))
  );
  // Android requires native IME package provenance. iOS AX does not expose an
  // owning bundle, so its fallback is a complete QWERTY + native-control
  // signature rather than accepting an arbitrary group of app buttons.
  const candidates =
    platform === "android"
      ? imeCandidates
      : elements.filter(
          (element) => !element.packageName && isButtonLike(element) && isKeyboardRegion(element)
        );
  const letters = new Map<string, ScreenElement>();
  const direct = new Map<string, ScreenElement>();
  let space: ScreenElement | undefined;
  let shift: ScreenElement | undefined;
  let deleteKey: ScreenElement | undefined;

  for (const element of candidates) {
    for (const text of elementText(element)) {
      if (/^[A-Za-z]$/.test(text)) letters.set(text.toLowerCase(), element);
      if (text.length === 1) direct.set(text, element);
      const normalized = text.toLowerCase();
      if (normalized === "space" || normalized === "spacebar") space = element;
      if (normalized === "shift" || normalized.includes("shift key")) shift = element;
      if (
        normalized === "delete" ||
        normalized === "backspace" ||
        normalized.includes("delete key")
      ) {
        deleteKey = element;
      }
    }
  }

  if (
    !space ||
    !shift ||
    !deleteKey ||
    [...QWERTY_LETTERS].some((letter) => !letters.has(letter))
  ) {
    return null;
  }
  return { letters, space, shift, direct };
}

function usesUppercaseLabels(layout: KeyboardLayout): boolean {
  let uppercase = 0;
  let lowercase = 0;
  for (const element of new Set(layout.letters.values())) {
    const label = elementText(element).find((text) => /^[A-Za-z]$/.test(text));
    if (!label) continue;
    if (label === label.toUpperCase()) uppercase += 1;
    else lowercase += 1;
  }
  return uppercase > lowercase;
}

function findInput(
  snapshot: ScreenSnapshot,
  selector: DescribeSelector
): ScreenElement | undefined {
  return snapshot.elements.find((element) => matchesDescribeSelector(element, selector));
}

function inputValue(element: ScreenElement | undefined): string | null {
  if (!element) return null;
  return element.value ?? "";
}

function inputFocus(snapshot: ScreenSnapshot, input: ScreenElement | undefined): boolean | null {
  if (!input) return null;
  if (input.focused === true) return true;
  // A focused peer proves that the provider exposed focus and this input is
  // false. With no positive focus signal, preserve unknown as null.
  return snapshot.elements.some((element) => element.focused === true) ? false : null;
}

function didWrap(baseline: DescribeFrame | null, current: DescribeFrame | null): boolean | null {
  if (!baseline || !current) return null;
  return current.height > baseline.height + WRAP_HEIGHT_DELTA;
}

async function readScreen(
  registry: Registry,
  ctx: ToolContext | undefined,
  params: Pick<Params, "udid" | "bundleId">
): Promise<ScreenSnapshot> {
  const result = await invokeSubTool(registry, ctx, "describe", {
    udid: params.udid,
    bundleId: params.bundleId,
  });
  const snapshot = parseDescribeScreen(result);
  if (resolveDevice(params.udid).platform !== "android") return snapshot;

  // The legacy full rendering intentionally omits Android package names. Ask
  // compact describe for native IME-owned nodes and merge them into the app
  // snapshot so Gboard's clickable `android.view.View` keys remain discoverable
  // without changing selector-less describe output.
  for (const packageMarker of ["inputmethod", "honeyboard", "swiftkey"] as const) {
    const imeResult = await invokeSubTool(registry, ctx, "describe", {
      udid: params.udid,
      selector: { package: packageMarker },
      projection: "matches",
      fields: ["role", "label", "value", "identifier", "package", "flags", "frame"],
      limit: 200,
      maxChars: 50_000,
    });
    const imeSnapshot = parseDescribeScreen(imeResult);
    const nativeImeElements = imeSnapshot.elements.filter(isNativeAndroidIme);
    if (nativeImeElements.length > 0) {
      return { source: snapshot.source, elements: [...snapshot.elements, ...nativeImeElements] };
    }
  }
  return snapshot;
}

async function tapElement(
  registry: Registry,
  ctx: ToolContext | undefined,
  udid: string,
  element: ScreenElement
): Promise<void> {
  const point = center(element.frame);
  await invokeSubTool(registry, ctx, "gesture-tap", { udid, ...point });
}

async function waitForKeyboard(
  registry: Registry,
  ctx: ToolContext | undefined,
  params: Params
): Promise<{ snapshot: ScreenSnapshot; layout: KeyboardLayout } | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < params.keyboardTimeoutMs) {
    if (ctx?.signal?.aborted) return null;
    const remaining = params.keyboardTimeoutMs - (Date.now() - startedAt);
    const settled = await settleWithin(readScreen(registry, ctx, params), remaining, ctx?.signal);
    if (settled.type !== "value") return null;
    const snapshot = settled.value;
    const platform = resolveDevice(params.udid).platform === "android" ? "android" : "ios";
    const layout = discoverEnglishQwerty(snapshot.elements, platform);
    if (layout) return { snapshot, layout };
    if (!(await sleepOrAbort(KEYBOARD_POLL_MS, ctx?.signal))) return null;
  }
  return null;
}

interface SettledInspection {
  snapshot: ScreenSnapshot;
  input: ScreenElement | undefined;
  layout: KeyboardLayout | null;
  settled: boolean;
  keyboardLost: boolean;
}

async function waitForExpectedState(
  registry: Registry,
  ctx: ToolContext | undefined,
  params: Params,
  expectedValue: string,
  expectedKeyboardVisible: boolean,
  failImmediatelyWhenKeyboardLost: boolean
): Promise<SettledInspection> {
  const startedAt = Date.now();
  let last: SettledInspection | null = null;
  while (Date.now() - startedAt < params.settleTimeoutMs) {
    const remaining = params.settleTimeoutMs - (Date.now() - startedAt);
    const read = await settleWithin(readScreen(registry, ctx, params), remaining, ctx?.signal);
    if (read.type !== "value") break;
    const snapshot = read.value;
    const input = findInput(snapshot, params.input);
    const platform = resolveDevice(params.udid).platform === "android" ? "android" : "ios";
    const layout = discoverEnglishQwerty(snapshot.elements, platform);
    const keyboardVisible = layout !== null;
    last = {
      snapshot,
      input,
      layout,
      settled: inputValue(input) === expectedValue && keyboardVisible === expectedKeyboardVisible,
      keyboardLost: !keyboardVisible,
    };
    if (last.settled) return last;
    if (failImmediatelyWhenKeyboardLost && last.keyboardLost) return last;
    if (!(await sleepOrAbort(Math.min(SETTLE_POLL_MS, remaining), ctx?.signal))) break;
  }

  return (
    last ?? {
      snapshot: { source: "unknown", elements: [] },
      input: undefined,
      layout: null,
      settled: false,
      keyboardLost: true,
    }
  );
}

function failedResult(
  typed: string,
  checkpoints: Checkpoint[],
  stage: ScenarioStage,
  message: string,
  expectedFinalText: string
): ScenarioResult {
  return {
    success: false,
    typed,
    checkpoints,
    assertions: {
      finalText: {
        expected: expectedFinalText,
        actual: null,
        passed: false,
        available: false,
      },
      keyboardVisible: { expected: true, actual: null, passed: false, available: false },
    },
    error: { stage, message },
  };
}

function assertion<T>(expected: T, actual: T | null): AssertionResult<T> {
  return {
    expected,
    actual,
    passed: actual !== null && actual === expected,
    available: actual !== null,
  };
}

function isCheckpoint(text: string, index: number): boolean {
  return index === text.length - 1 || /\s/.test(text[index]!);
}

export function createKeyboardScenarioTool(
  registry: Registry
): ToolDefinition<Params, ScenarioResult> {
  return {
    id: "keyboard-scenario",
    description: `Type an exact string by tapping the VISIBLE native soft keyboard and verify the input at word boundaries.

This is intentionally different from \`keyboard\`: it never injects text or key events. It discovers the
English QWERTY soft-key tree exposed by iOS accessibility / Android uiautomator and taps each key's
on-screen centre, preserving predictive-text, autocorrect, focus, layout, and line-wrap behavior.

The tool taps the selected input, waits for a visible QWERTY keyboard, types at a deterministic cadence,
and returns compact word-boundary checkpoints only. It always asserts the exact final value and keyboard
visibility; callers can also assert focus and whether the input wrapped. A missing QWERTY key, unavailable
focus signal, unexpected value, hidden keyboard, or wrap mismatch returns success=false with a stage.

Use this for keyboard regressions that hardware-key injection cannot reproduce. Configure the device to a
normal English QWERTY keyboard first. The tool refuses to guess fixed keyboard coordinates or switch layouts.`,
    alwaysLoad: true,
    longRunning: true,
    searchHint:
      "visible native soft keyboard tap qwerty predictive autocorrect focus multiline wrap regression scenario",
    zodSchema,
    capability,
    services: () => ({}),
    async execute(_services, params, ctx) {
      // Resolve up front so unsupported target shapes fail before any interaction.
      resolveDevice(params.udid);
      const checkpoints: Checkpoint[] = [];
      const before = await readScreen(registry, ctx, params);
      const inputBefore = findInput(before, params.input);
      const initialValue = inputValue(inputBefore) ?? "";
      const expectedFinalText = params.assertions.finalText ?? `${initialValue}${params.text}`;

      if (!inputBefore) {
        return failedResult(
          "",
          checkpoints,
          "input",
          "No element matched the input selector.",
          expectedFinalText
        );
      }

      await tapElement(registry, ctx, params.udid, inputBefore);
      const keyboardReady = await waitForKeyboard(registry, ctx, params);
      if (!keyboardReady) {
        return failedResult(
          "",
          checkpoints,
          "keyboard",
          "A visible English QWERTY soft-key tree did not appear before timeout.",
          expectedFinalText
        );
      }

      const focusedInput = findInput(keyboardReady.snapshot, params.input);
      const baselineFrame = focusedInput?.frame ?? inputBefore.frame;
      let layout = keyboardReady.layout;
      let uppercaseLayout = usesUppercaseLabels(layout);
      let typed = "";

      for (let index = 0; index < params.text.length; index++) {
        if (ctx?.signal?.aborted) {
          return failedResult(
            typed,
            checkpoints,
            "typing",
            "The scenario was cancelled.",
            expectedFinalText
          );
        }
        const char = params.text[index]!;
        let key: ScreenElement | undefined;

        if (char === " ") {
          key = layout.space;
        } else if (/^[A-Za-z]$/.test(char)) {
          key = layout.letters.get(char.toLowerCase());
          const wantsUppercase = char === char.toUpperCase();
          const needsShift = wantsUppercase !== uppercaseLayout;
          if (needsShift) {
            if (!layout.shift) {
              return failedResult(
                typed,
                checkpoints,
                "keyboard",
                `Visible shift key is required for ${JSON.stringify(char)} but was not found.`,
                expectedFinalText
              );
            }
            await tapElement(registry, ctx, params.udid, layout.shift);
            if (!(await sleepOrAbort(params.perKeyDelayMs, ctx?.signal))) {
              return failedResult(
                typed,
                checkpoints,
                "typing",
                "The scenario was cancelled.",
                expectedFinalText
              );
            }
            uppercaseLayout = !uppercaseLayout;
          }
        } else {
          key = layout.direct.get(char);
        }

        if (!key) {
          return failedResult(
            typed,
            checkpoints,
            "keyboard",
            `No currently visible soft key matches ${JSON.stringify(char)}. The scenario does not guess coordinates or switch layouts.`,
            expectedFinalText
          );
        }

        await tapElement(registry, ctx, params.udid, key);
        typed += char;
        // Normal mobile shift is one-shot. Re-read the layout at the next word
        // checkpoint, but keep mixed-case words correct without a tree fetch per key.
        if (/^[A-Za-z]$/.test(char)) uppercaseLayout = false;
        if (!(await sleepOrAbort(params.perKeyDelayMs, ctx?.signal))) {
          return failedResult(
            typed,
            checkpoints,
            "typing",
            "The scenario was cancelled.",
            expectedFinalText
          );
        }

        if (isCheckpoint(params.text, index) && index !== params.text.length - 1) {
          const inspection = await waitForExpectedState(
            registry,
            ctx,
            params,
            `${initialValue}${typed}`,
            true,
            true
          );
          const { snapshot, input, layout: currentLayout } = inspection;
          const currentFrame = input?.frame ?? null;
          checkpoints.push({
            charIndex: index + 1,
            value: inputValue(input),
            focused: inputFocus(snapshot, input),
            keyboardVisible: currentLayout !== null,
            inputFrame: currentFrame,
            wrapped: didWrap(baselineFrame, currentFrame),
          });
          if (inspection.keyboardLost) {
            return failedResult(
              typed,
              checkpoints,
              "keyboard",
              "The visible native keyboard disappeared at a word checkpoint; stopped before tapping stale coordinates.",
              expectedFinalText
            );
          }
          if (!inspection.settled) {
            return failedResult(
              typed,
              checkpoints,
              "inspection",
              `The input did not settle to ${JSON.stringify(`${initialValue}${typed}`)} before timeout.`,
              expectedFinalText
            );
          }
          if (currentLayout) {
            layout = currentLayout;
            uppercaseLayout = usesUppercaseLabels(currentLayout);
          }
        }
      }

      const finalInspection = await waitForExpectedState(
        registry,
        ctx,
        params,
        expectedFinalText,
        params.assertions.keyboardVisible,
        false
      );
      const finalSnapshot = finalInspection.snapshot;
      const finalInput = finalInspection.input;
      const finalLayout = finalInspection.layout;
      const finalText = inputValue(finalInput);
      const keyboardVisible = finalLayout !== null;
      const focused = inputFocus(finalSnapshot, finalInput);
      const wrapped = didWrap(baselineFrame, finalInput?.frame ?? null);
      checkpoints.push({
        charIndex: params.text.length,
        value: finalText,
        focused,
        keyboardVisible,
        inputFrame: finalInput?.frame ?? null,
        wrapped,
      });
      const assertions: ScenarioResult["assertions"] = {
        finalText: assertion(expectedFinalText, finalText),
        keyboardVisible: assertion(params.assertions.keyboardVisible, keyboardVisible),
      };
      if (params.assertions.inputFocused !== undefined) {
        assertions.inputFocused = assertion(params.assertions.inputFocused, focused);
      }
      if (params.assertions.wrapped !== undefined) {
        assertions.wrapped = assertion(params.assertions.wrapped, wrapped);
      }
      const success = Object.values(assertions).every((result) => result.passed);

      return {
        success,
        typed,
        checkpoints,
        assertions,
        ...(success
          ? {}
          : {
              error: {
                stage: "inspection" as const,
                message: "One or more final keyboard scenario assertions failed.",
              },
            }),
      };
    },
  };
}
