import { describe, it, expect } from "vitest";
import { renderFlowStepDetails, type FlowStepDetails } from "../src/flow-step-details.js";

type Step = FlowStepDetails & { kind: string };

describe("renderFlowStepDetails", () => {
  it("prints expected, actual and hint, values quoted and aligned", () => {
    const lines = renderFlowStepDetails({
      kind: "assert",
      expected: "$12.00",
      actual: "$10.00",
      hint: "the cart may still be loading",
    });
    expect(lines).toEqual([
      'expected: "$12.00"',
      'actual:   "$10.00"',
      "hint: the cart may still be loading",
    ]);
    expect(lines[0]!.indexOf('"')).toBe(lines[1]!.indexOf('"'));
  });

  it("prints only the fields a step carries, and only string values", () => {
    expect(renderFlowStepDetails({ kind: "tap" })).toEqual([]);
    expect(renderFlowStepDetails({ kind: "tap", hint: "scroll first" })).toEqual([
      "hint: scroll first",
    ]);
    expect(renderFlowStepDetails({ kind: "assert", actual: "Pending" })).toEqual([
      'actual:   "Pending"',
    ]);
    const hostile = {
      kind: "assert",
      expected: 12,
      actual: null,
      hint: { text: "x" },
    } as unknown as Step;
    expect(renderFlowStepDetails(hostile)).toEqual([]);
  });

  it("escapes control characters in values and the hint", () => {
    const step: Step = {
      kind: "assert",
      expected: "line one\nline two",
      actual: "tab\there\u001b[31m",
      hint: 'wait\r\nthen\tretry\u001b, own text "Total"',
    };
    const lines = renderFlowStepDetails(step);
    expect(lines).toEqual([
      'expected: "line one\\nline two"',
      'actual:   "tab\\there\\u001b[31m"',
      // The hint prints unquoted, so its own quotes are not escaped.
      'hint: wait\\r\\nthen\\tretry\\u001b, own text "Total"',
    ]);
    // Still one line each, and still no raw escape sequence in the terminal.
    for (const line of lines) expect(line).not.toMatch(/\p{Cc}/u);
    const snapshot: Step = {
      ...step,
      kind: "snapshot",
      expected: "\u2264\n0.5%",
      actual: "3\t10%",
    };
    expect(renderFlowStepDetails(snapshot).slice(0, 2)).toEqual([
      "expected: \u2264\\n0.5%",
      "actual:   3\\t10%",
    ]);
  });

  it("prints a hint's quoted device text with the actual line's spelling", () => {
    // The tool-server quotes the own text as JSON. Escaping the hint again
    // doubled its backslashes and left its quotes raw: neither spelling.
    expect(
      renderFlowStepDetails({
        kind: "assert",
        actual: 'Say "hi" C:\\x Hello there',
        hint: 'the element\'s own text is "Say \\"hi\\" C:\\\\x"; the check accepts the subtree text or the own text',
      })
    ).toEqual([
      'actual:   "Say \\"hi\\" C:\\\\x Hello there"',
      'hint: the element\'s own text is "Say \\"hi\\" C:\\\\x"; the check accepts the subtree text or the own text',
    ]);
  });

  it("prints a pattern in slash delimiters, backslashes intact", () => {
    // The step line one row above prints the same pattern as /^Taps: \d\d\d$/.
    // JSON quoting doubled every backslash here, so the printed pattern matched
    // a literal backslash followed by `d` when it was copied back into the YAML.
    const step: Step = {
      kind: "assert",
      expected: "^Taps: \\d\\d\\d$",
      expectedKind: "pattern",
      actual: "Taps: 0",
    };
    expect(renderFlowStepDetails(step)).toEqual([
      "expected: /^Taps: \\d\\d\\d$/",
      'actual:   "Taps: 0"',
    ]);
    // A literal keeps the JSON quoting the step line uses for one.
    expect(renderFlowStepDetails({ ...step, expectedKind: undefined })[0]).toBe(
      'expected: "^Taps: \\\\d\\\\d\\\\d$"'
    );
    // A control character in a pattern still cannot break the line.
    expect(renderFlowStepDetails({ ...step, expected: "^a\nb$" })[0]).toBe("expected: /^a\\nb$/");
  });

  it("keeps a whitespace-only difference visible", () => {
    // The found text differs from the wanted one only by a line break. These
    // two lines are the only place a reader sees it.
    const lines = renderFlowStepDetails({
      kind: "assert",
      expected: "Ship to: Jane Doe",
      actual: "Ship to:\nJane Doe",
    });
    expect(lines).toEqual(['expected: "Ship to: Jane Doe"', 'actual:   "Ship to:\\nJane Doe"']);
    expect(lines[0]!.replace("expected: ", "")).not.toBe(lines[1]!.replace("actual:   ", ""));
  });

  it("escapes the invisible characters JSON quoting keeps raw", () => {
    // Each of these prints as nothing or as a plain space, so without an escape
    // the actual line reads as a twin of the expected one.
    const step: Step = {
      kind: "assert",
      expected: "10:30 AM Pay now",
      actual: "10:30\u202fAM Pay\u200bnow\u00a0\u007f\u0085\u2066x\u2069\u2028",
      hint: 'own text is "Ship\u00a0to"',
    };
    const lines = renderFlowStepDetails(step);
    expect(lines).toEqual([
      'expected: "10:30 AM Pay now"',
      'actual:   "10:30\\u202fAM Pay\\u200bnow\\u00a0\\u007f\\u0085\\u2066x\\u2069\\u2028"',
      'hint: own text is "Ship\\u00a0to"',
    ]);
    for (const line of lines) expect(line).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u00a0\u202f]/u);
    // A snapshot value and a pattern get the same escapes.
    expect(renderFlowStepDetails({ kind: "snapshot", expected: "\u2264\u00a00.5%" })).toEqual([
      "expected: \u2264\\u00a00.5%",
    ]);
    expect(
      renderFlowStepDetails({ kind: "assert", expected: "^a\u200bb$", expectedKind: "pattern" })
    ).toEqual(["expected: /^a\\u200bb$/"]);
  });

  it("escapes an invisible character outside the BMP as its surrogate pair", () => {
    // The Scotland flag is a black flag followed by tag characters, format
    // characters from U+E0067 on. A JSON escape has four hex digits, so each
    // tag character prints as two of them: a five-digit escape reads as a
    // different character followed by a digit.
    const flag = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}";
    const lines = renderFlowStepDetails({ kind: "assert", actual: `${flag} Scotland` });
    expect(lines).toEqual([
      'actual:   "\u{1F3F4}\\udb40\\udc67\\udb40\\udc62\\udb40\\udc73\\udb40\\udc63\\udb40\\udc74\\udb40\\udc7f Scotland"',
    ]);
    // The quoted value reads back as the device text.
    expect(JSON.parse(lines[0]!.replace("actual:   ", ""))).toBe(`${flag} Scotland`);
  });

  it("spells a backspace so that a pattern cannot read it as a word boundary", () => {
    // A double-quoted YAML `matches: "\bTotal\b"` loads U+0008, not a word
    // boundary. Printed as JSON's `\b`, it reads as the pattern its author meant.
    const backspace = String.fromCharCode(8);
    const step: Step = {
      kind: "assert",
      expected: `${backspace}Total${backspace}`,
      expectedKind: "pattern",
      actual: "Order Total: 42",
    };
    const backspaced = renderFlowStepDetails(step)[0];
    const bounded = renderFlowStepDetails({ ...step, expected: "\\bTotal\\b" })[0];
    expect(backspaced).toBe("expected: /\\u0008Total\\u0008/");
    expect(bounded).toBe("expected: /\\bTotal\\b/");
    expect(backspaced).not.toBe(bounded);
    // A snapshot value and a hint that quotes device text spell it the same way.
    expect(
      renderFlowStepDetails({
        kind: "snapshot",
        expected: `a${backspace}b`,
        hint: `own text is "a${backspace}b"`,
      })
    ).toEqual(["expected: a\\u0008b", 'hint: own text is "a\\u0008b"']);
  });

  it("marks a step whose check did not run, above its hint", () => {
    const step: Step = { kind: "await", indeterminate: true, hint: "check the app first" };
    expect(renderFlowStepDetails(step)).toEqual([
      "indeterminate: the check did not run",
      "hint: check the app first",
    ]);
    // Only the literal `true` the tool-server sends counts.
    const hostile = { ...step, indeterminate: "yes", hint: undefined } as unknown as Step;
    expect(renderFlowStepDetails(hostile)).toEqual([]);
  });

  it("cuts a long actual at 300 characters and counts the rest outside the quotes", () => {
    // 299 characters, an emoji (two UTF-16 units, one character), then more.
    const text = "a".repeat(299) + "😀" + "b".repeat(1300);
    expect(renderFlowStepDetails({ kind: "assert", actual: text })).toEqual([
      `actual:   "${"a".repeat(299)}😀" … (1,300 more characters)`,
    ]);
    // A text at the limit prints whole.
    expect(renderFlowStepDetails({ kind: "assert", actual: "c".repeat(300) })).toEqual([
      `actual:   "${"c".repeat(300)}"`,
    ]);
    // A snapshot value prints unquoted and is cut the same way.
    expect(renderFlowStepDetails({ kind: "snapshot", actual: "d".repeat(302) })).toEqual([
      `actual:   ${"d".repeat(300)} … (2 more characters)`,
    ]);
  });

  it("prints the whole actual with wholeActual, escaped the same way", () => {
    const text = "a".repeat(299) + "😀" + "b\n".repeat(650);
    expect(renderFlowStepDetails({ kind: "assert", actual: text }, { wholeActual: true })).toEqual([
      `actual:   "${"a".repeat(299)}😀${"b\\n".repeat(650)}"`,
    ]);
    expect(
      renderFlowStepDetails({ kind: "snapshot", actual: "d".repeat(302) }, { wholeActual: true })
    ).toEqual([`actual:   ${"d".repeat(302)}`]);
    // Without it, the line is cut.
    expect(
      renderFlowStepDetails({ kind: "assert", actual: text }, { wholeActual: false })[0]
    ).toMatch(/ … \(1,300 more characters\)$/);
  });
});
