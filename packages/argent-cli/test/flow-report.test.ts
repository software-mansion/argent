import { describe, it, expect } from "vitest";
import { buildJUnitXml, parseReporterSpec, xmlEscape } from "../src/flow-report.js";
import { FlagParseException } from "../src/flag-parser.js";
import type { FlowReport, FlowStepFailure, StepReport } from "../src/flow.js";

const FAILURE: FlowStepFailure = {
  code: "selector-not-found",
  category: "selector",
  determinacy: "determinate",
  message: 'no visible element matched selector text="Checkout"',
  hint: "the closest match differs only by a space",
  step: { index: 3, ordinal: 3, kind: "tap", flow: "checkout", target: '"Checkout"' },
  selector: { described: 'text="Checkout"' },
  screen: {
    state: "available",
    capturedAt: "at-failure",
    elementCount: 47,
    elements: [],
    size: { width: 390, height: 844 },
  },
  candidates: [
    {
      score: 0.86,
      basis: "text-near",
      node: {
        role: "button",
        label: "Check out",
        identifier: "checkout-cta",
        frame: { x: 0.4, y: 0.84, width: 0.2, height: 0.04 },
      },
    },
  ],
  candidateCount: 1,
  screenshot: "flow-artifacts/checkout/step-03-screen.png",
  tree: "flow-artifacts/checkout/step-03-tree.txt",
  timing: { startedAt: 1, durationMs: 5002 },
};

const MIXED_STEPS: StepReport[] = [
  { index: 0, kind: "echo", status: "pass", message: "Opening the cart" },
  { index: 1, kind: "launch", status: "pass", target: "com.acme.shop", durationMs: 3100 },
  { index: 2, kind: "tap", status: "pass", target: '"Cart"', durationMs: 400 },
  {
    index: 3,
    kind: "tap",
    status: "fail",
    target: '"Checkout"',
    durationMs: 5002,
    reason: 'no visible element matched selector text="Checkout"',
    failure: FAILURE,
  },
  { index: 4, kind: "assert", status: "skip", target: 'visible "Order placed"' },
  {
    index: 5,
    kind: "tool",
    tool: "screenshot",
    status: "error",
    durationMs: 12,
    reason: "device disconnected",
  },
  { index: 6, kind: "echo", status: "skip", message: "Done" },
];

function mkReport(overrides: Partial<FlowReport> = {}): FlowReport {
  return {
    flow: "checkout",
    device: "SIM-1",
    ok: false,
    passed: 2,
    failed: 1,
    skipped: 1,
    errored: 1,
    startedAt: Date.parse("2026-07-28T10:15:00.000Z"),
    durationMs: 12480,
    steps: MIXED_STEPS,
    ...overrides,
  };
}

describe("parseReporterSpec", () => {
  it("accepts the two documented formats", () => {
    expect(parseReporterSpec("default")).toEqual({ format: "default" });
    expect(parseReporterSpec("junit:out.xml")).toEqual({ format: "junit", path: "out.xml" });
    expect(parseReporterSpec("  junit:reports/flow.xml  ")).toEqual({
      format: "junit",
      path: "reports/flow.xml",
    });
  });

  it("splits on the FIRST colon so a Windows path survives", () => {
    expect(parseReporterSpec("junit:C:\\ci\\out.xml")).toEqual({
      format: "junit",
      path: "C:\\ci\\out.xml",
    });
  });

  it("rejects an empty spec, a pathless junit, and an unknown format", () => {
    // Every one of these must exit 2 before the tool call: a report the
    // operator asked for and did not get is worse than a run that never began.
    expect(() => parseReporterSpec("")).toThrow(FlagParseException);
    expect(() => parseReporterSpec("   ")).toThrow("--reporter requires a value");
    expect(() => parseReporterSpec("junit")).toThrow("--reporter junit requires a path");
    expect(() => parseReporterSpec("junit:")).toThrow("--reporter junit requires a path");
    expect(() => parseReporterSpec("junit:   ")).toThrow("--reporter junit requires a path");
    expect(() => parseReporterSpec("tap:out.tap")).toThrow(/unknown format "tap"/);
    expect(() => parseReporterSpec("JUnit:out.xml")).toThrow(/unknown format "JUnit"/);
    expect(() => parseReporterSpec("default:out.xml")).toThrow("does not take a path");
  });
});

describe("xmlEscape", () => {
  it("escapes the five XML entities", () => {
    expect(xmlEscape(`a & b < c > d " e ' f`)).toBe("a &amp; b &lt; c &gt; d &quot; e &apos; f");
    // & must be escaped first, or the other replacements get double-escaped.
    expect(xmlEscape("&lt;")).toBe("&amp;lt;");
  });

  it("strips the control characters that make a document unparseable", () => {
    // Device-supplied labels can carry control bytes; one \x00 in an attribute
    // makes the whole report unreadable, which in CI means no annotations at
    // all rather than a slightly wrong one.
    expect(xmlEscape("a\x00b\x01c\x1fd\x0be\x0c")).toBe("abcde");
    // Tab / LF / CR are legal XML 1.0 characters and survive verbatim.
    expect(xmlEscape("a\tb\nc\rd")).toBe("a\tb\nc\rd");
  });

  it("strips the BMP noncharacters the control range misses", () => {
    // U+FFFE / U+FFFF are outside the `Char` production, so no spelling makes
    // them legal — one in an on-screen label made every parser reject the whole
    // document while the reporter reported nothing wrong. A mis-decoded UTF-16
    // BOM lands as U+FFFE exactly this way.
    expect(xmlEscape("ready\uFFFF now")).toBe("ready now");
    expect(xmlEscape("\uFFFEbom")).toBe("bom");
    // U+FFFD (the replacement character) and the astral noncharacters ARE
    // legal, and must not be collateral damage.
    expect(xmlEscape("a\uFFFDb")).toBe("a\uFFFDb");
    expect(xmlEscape("a\u{1FFFF}b")).toBe("a\u{1FFFF}b");
  });
});

describe("buildJUnitXml", () => {
  it("clamps a rejection message like every other attribute here", () => {
    // `incompleteMessage` is the transport error from a possibly-remote
    // tool-server — the untrusted wire data this module's header says is
    // "normalized ONCE, here". It was the one message attribute reaching
    // `xmlEscape` without `wireText`, so a multi-line rejection put raw
    // newlines and an unbounded string into a CI attribute.
    const xml = buildJUnitXml(
      {
        flow: "b-checkout",
        device: "",
        ok: false,
        passed: 0,
        failed: 0,
        skipped: 0,
        errored: 0,
        steps: [],
      },
      { incompleteMessage: `unknown step kind "tapp"\n  at line 4\n${"x".repeat(2000)}` }
    );
    const message = /message="([^"]*)"/.exec(xml)?.[1] ?? "";
    expect(message).toContain("unknown step kind");
    expect(message).not.toContain("\n");
    expect(message.length).toBeLessThan(400);
  });

  it("maps each step to a testcase, excluding echo from the counters", () => {
    const xml = buildJUnitXml(mkReport(), { platform: "ios" });
    expect(xml).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<testsuites name="argent flow" tests="5" failures="1" errors="1" skipped="1" time="12.480">',
        '  <testsuite name="checkout" tests="5" failures="1" errors="1" skipped="1" time="12.480" timestamp="2026-07-28T10:15:00.000Z" hostname="SIM-1">',
        "    <properties>",
        '      <property name="argent.device" value="SIM-1"/>',
        '      <property name="argent.platform" value="ios"/>',
        '      <property name="argent.flowFile" value=".argent/flows/checkout.yaml"/>',
        "    </properties>",
        '    <testcase classname="checkout" name="01 launch com.acme.shop" time="3.100"/>',
        '    <testcase classname="checkout" name="02 tap &quot;Cart&quot;" time="0.400"/>',
        '    <testcase classname="checkout" name="03 tap &quot;Checkout&quot;" time="5.002">',
        '      <failure type="selector-not-found" message="no visible element matched selector text=&quot;Checkout&quot;">selector: text=&quot;Checkout&quot;',
        "hint: the closest match differs only by a space",
        "candidates:",
        "  0.86  &quot;Check out&quot;  button  id=checkout-cta  visible",
        "screen: 47 elements, 390x844",
        "screenshot: flow-artifacts/checkout/step-03-screen.png",
        "tree: flow-artifacts/checkout/step-03-tree.txt</failure>",
        "      <system-out>status: fail",
        "durationMs: 5002",
        "code: selector-not-found</system-out>",
        "    </testcase>",
        '    <testcase classname="checkout" name="04 assert visible &quot;Order placed&quot;" time="0.000">',
        '      <skipped message="run stopped at the first failure"/>',
        "    </testcase>",
        '    <testcase classname="checkout" name="05 tool screenshot" time="0.012">',
        '      <error type="error" message="device disconnected">device disconnected</error>',
        "      <system-out>status: error",
        "durationMs: 12</system-out>",
        "    </testcase>",
        "    <system-out>Opening the cart",
        "Done</system-out>",
        "  </testsuite>",
        "</testsuites>",
        "",
      ].join("\n")
    );
  });

  it("keeps tests= equal to the testcase count (echo emits no testcase)", () => {
    const xml = buildJUnitXml(mkReport());
    const testcases = xml.match(/<testcase /g) ?? [];
    expect(testcases).toHaveLength(5);
    expect(xml).toContain('tests="5"');
    // Echo text is narration, and it lands in the suite-level system-out only.
    expect(xml).not.toMatch(/<testcase[^>]*echo/);
    expect(xml).not.toMatch(/<testcase[^>]*Opening the cart/);
    expect(xml).toContain("<system-out>Opening the cart");
  });

  it("uses <failure> for a failed assertion and <error> for broken machinery", () => {
    const xml = buildJUnitXml(mkReport());
    expect(xml).toContain('<failure type="selector-not-found"');
    expect(xml).toContain('<error type="error" message="device disconnected"');
    expect(xml).not.toContain('<error type="selector-not-found"');
  });

  it("emits a suite-level <error> for a cancelled run with no failing step", () => {
    // ok:false does not imply a failing step. Reporting the suite as clean
    // would show green in the checks UI next to a red build.
    const xml = buildJUnitXml(
      mkReport({
        ok: false,
        aborted: true,
        failed: 0,
        errored: 0,
        steps: [
          { index: 0, kind: "launch", status: "pass", durationMs: 100 },
          { index: 1, kind: "tap", status: "skip", reason: "run aborted" },
        ],
      })
    );
    expect(xml).toContain(
      '<error type="run-incomplete" message="run cancelled before it completed"/>'
    );
    // The attribute agrees with the element that is actually present.
    expect(xml).toContain('errors="1"');
    expect(xml).toContain('<skipped message="run aborted"/>');
  });

  it("falls back to reason-only output for a pre-diagnostics tool-server", () => {
    const xml = buildJUnitXml(
      mkReport({
        steps: [
          { index: 0, kind: "assert", status: "fail", target: '"Done"', reason: "never visible" },
        ],
      })
    );
    // No failure object and no durationMs: type is the status, time is zero.
    expect(xml).toContain('<failure type="fail" message="never visible">never visible</failure>');
    expect(xml).toContain('time="0.000"');
    // A skip with no reason and no failing sibling stays unannotated.
    const clean = buildJUnitXml(
      mkReport({ ok: true, steps: [{ index: 0, kind: "tap", status: "skip" }] })
    );
    expect(clean).toContain("<skipped/>");
  });

  it("escapes wire text in attributes and bodies", () => {
    const xml = buildJUnitXml(
      mkReport({
        flow: "checkout",
        steps: [
          {
            index: 0,
            kind: "assert",
            status: "fail",
            target: '"a<b&c"',
            reason: 'expected "a<b" \x00got',
          },
        ],
      })
    );
    expect(xml).toContain('name="01 assert &quot;a&lt;b&amp;c&quot;"');
    // The stripped \x00 leaves a space behind, so no two words are ever fused.
    expect(xml).toContain('message="expected &quot;a&lt;b&quot;  got"');
    // The raw control byte never reaches the document.
    expect(xml).not.toContain("\x00");
  });

  it("omits properties it has no value for, and the timestamp on an untimed run", () => {
    const xml = buildJUnitXml({
      flow: "checkout",
      device: "SIM-1",
      ok: true,
      passed: 1,
      failed: 0,
      skipped: 0,
      errored: 0,
      steps: [{ index: 0, kind: "tap", status: "pass" }],
    });
    expect(xml).toContain('<property name="argent.device" value="SIM-1"/>');
    expect(xml).not.toContain("argent.platform");
    expect(xml).not.toContain("timestamp=");
    // No run duration and no step durations: the suite time is zero, not NaN.
    expect(xml).toContain('time="0.000"');
  });
});
