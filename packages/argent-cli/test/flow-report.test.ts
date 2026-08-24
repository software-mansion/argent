import { describe, it, expect } from "vitest";
import { XMLParser, XMLValidator } from "fast-xml-parser";
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

/**
 * Parse the document rather than grepping it. Every JUnit assertion here used
 * to be `toContain`, which is satisfied by a fragment sitting ANYWHERE — so an
 * `<error>` in a position no schema allows passed the suite unnoticed.
 */
type XmlNode = Record<string, unknown>;
const parser = new XMLParser({ ignoreAttributes: false, isArray: (name) => name === "testcase" });

function parseSuites(xml: string): XmlNode[] {
  expect(XMLValidator.validate(xml), `not well-formed XML:\n${xml}`).toBe(true);
  const doc = parser.parse(xml) as XmlNode;
  const suites = (doc["testsuites"] as XmlNode)["testsuite"];
  return Array.isArray(suites) ? (suites as XmlNode[]) : [suites as XmlNode];
}

function testcases(suite: XmlNode): XmlNode[] {
  return (suite["testcase"] as XmlNode[] | undefined) ?? [];
}

/** An XML attribute is always text; the counters are read as the numbers they mean. */
function attrNumber(node: XmlNode, name: string): number {
  return Number(node[`@_${name}`]);
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
    // A bare/blank trailer is still a path separator. `rest` is trimmed to ""
    // for these two, so testing it let them through while `default::` and
    // `default:x` correctly threw.
    expect(() => parseReporterSpec("default:")).toThrow("does not take a path");
    expect(() => parseReporterSpec("default:   ")).toThrow("does not take a path");
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
        // No `time`: this step was never measured, which is not the same
        // claim as "took 0.000s".
        '    <testcase classname="checkout" name="04 assert visible &quot;Order placed&quot;">',
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

  it("keeps the withheld-capture note in the body of a snapshot failure", () => {
    // The `<failure>` body suppresses `screenshot:` on a snapshot step, because
    // `current` names the same image. That must bound PATHS only: a snapshot
    // that failed after a secret was typed had the omission note suppressed
    // too, so the JUnit file — the artifact CI actually publishes — said
    // nothing about a withheld capture while listing the screen it protects.
    const xml = buildJUnitXml(
      mkReport({
        steps: [
          {
            index: 0,
            kind: "snapshot",
            status: "fail",
            target: '"home"',
            durationMs: 600,
            reason: "diff 2.10% > 1%",
            artifacts: { current: "out/checkout/home-current.png" },
            failure: {
              code: "snapshot-diff",
              category: "snapshot",
              determinacy: "determinate",
              message: "diff 2.10% > 1%",
              step: { index: 0, ordinal: 1, kind: "snapshot", flow: "checkout" },
              screen: { state: "unavailable", reason: "read-failed" },
              candidates: [],
              candidateCount: 0,
              data: { screenshotOmitted: "secret-typed" },
              timing: { startedAt: 1, durationMs: 600 },
            },
          },
        ],
      })
    );
    expect(xml).toContain("screenshot: (omitted — a secret was typed onto this device");
    expect(xml).toContain("warning: the current image above is of that same screen");
  });

  it("uses <failure> for a failed assertion and <error> for broken machinery", () => {
    const xml = buildJUnitXml(mkReport());
    expect(xml).toContain('<failure type="selector-not-found"');
    expect(xml).toContain('<error type="error" message="device disconnected"');
    expect(xml).not.toContain('<error type="selector-not-found"');
  });

  it("wraps a cancelled run's <error> in a testcase, as every consumer expects", () => {
    // ok:false does not imply a failing step. Reporting the suite as clean
    // would show green in the checks UI next to a red build.
    //
    // The `<error>` used to sit directly under `<testsuite>`, where JUnit's
    // content model (`properties?, testcase*, system-out?, system-err?`) does
    // not allow it — so a validating consumer rejected the whole document,
    // which in CI means no annotations at all out of a file that exists and
    // looks plausible. pytest and surefire both wrap it in a synthetic
    // testcase; so does this.
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
    const suite = parseSuites(xml)[0]!;
    expect(suite["error"], "an <error> directly under <testsuite> is illegal").toBeUndefined();
    const incomplete = testcases(suite).find((c) => c["@_name"] === "run")!;
    expect(incomplete["error"]).toMatchObject({
      "@_type": "run-incomplete",
      "@_message": "run cancelled before it completed",
    });
    // The attribute agrees with the elements that are actually present.
    expect(attrNumber(suite, "errors")).toBe(1);
    expect(xml).toContain('<skipped message="run aborted"/>');
  });

  it("counts the synthetic testcase, so a rejected flow is never an empty green report", () => {
    // `tests` counts steps, and a rejected or cancelled flow has none — so the
    // document carried `tests="0"` with zero testcases. Any consumer that
    // derives results from testcases, which is most of them, read that as an
    // empty PASSING report for a run that exited 1.
    const xml = buildJUnitXml(
      {
        flow: "broken",
        device: "",
        ok: false,
        passed: 0,
        failed: 0,
        skipped: 0,
        errored: 0,
        steps: [],
      },
      { incompleteMessage: 'unknown step kind "tapp"' }
    );
    const suite = parseSuites(xml)[0]!;
    expect(attrNumber(suite, "tests")).toBe(1);
    expect(testcases(suite)).toHaveLength(1);
  });

  it("keeps time= a decimal for an absurd duration, and omits it when unmeasured", () => {
    // `toFixed` switches to exponential notation at 1e21, which is not a valid
    // `xs:decimal` — and `wireFinite` placed no magnitude bound on `durationMs`,
    // even though `wireTimestamp` exists to bound exactly this class of value
    // for `startedAt`.
    const xml = buildJUnitXml(
      mkReport({
        durationMs: 1e25,
        steps: [
          { index: 0, kind: "tap", status: "pass", durationMs: 1e25 },
          { index: 1, kind: "tap", status: "pass" },
        ],
      })
    );
    expect(xml).not.toMatch(/e\+/);
    for (const [, value] of xml.matchAll(/time="([^"]*)"/g)) {
      expect(value).toMatch(/^\d+\.\d{3}$/);
    }
    // The unmeasured step carries no `time` at all.
    expect(xml).toContain('<testcase classname="checkout" name="02 tap"/>');
  });

  it("gives a flow the batch never ran a skipped suite instead of dropping it", () => {
    // A stopped batch reports the remaining flows as skipped in the terminal
    // summary. They carry no report, so they used to be filtered out of the
    // document entirely — leaving `skipped="0"` for a run that said N skipped.
    const xml = buildJUnitXml(
      {
        flow: "c-later",
        device: "",
        ok: false,
        passed: 0,
        failed: 0,
        skipped: 0,
        errored: 0,
        steps: [],
      },
      { notRunMessage: "not run — the batch stopped at an earlier flow" }
    );
    const suite = parseSuites(xml)[0]!;
    expect(attrNumber(suite, "skipped")).toBe(1);
    expect(attrNumber(suite, "errors")).toBe(0);
    const only = testcases(suite)[0]!;
    expect(only["skipped"]).toMatchObject({
      "@_message": "not run — the batch stopped at an earlier flow",
    });
    // NOT an error: the flow did not fail, it never ran.
    expect(xml).not.toContain("run-incomplete");
  });

  it("survives a startedAt no Date can represent, and still writes the file", () => {
    // `new Date(n).toISOString()` throws a RangeError past ±8.64e15, and the
    // reporter's own try/catch swallowed it into a warning — so one bad number
    // cost CI its ENTIRE JUnit file rather than one attribute. Load-bearing and
    // untested: removing `wireTimestamp` makes this throw.
    const xml = buildJUnitXml(mkReport({ startedAt: 1e18 }));
    expect(xml).toContain("<testsuite ");
    expect(xml).not.toContain("timestamp=");
    // A representable one still renders.
    expect(buildJUnitXml(mkReport())).toContain('timestamp="2026-07-28T10:15:00.000Z"');
  });

  it("reports the RESOLVED platform when no --platform was pinned", () => {
    // `--platform` only narrows auto-detection, so it is absent on the common
    // run and the property would disappear exactly when a CI reader most wants
    // it — on a failing run nobody pinned a platform for. It rides in on the
    // failure's `data.platform` instead. Dead to the suite until now.
    const xml = buildJUnitXml(
      mkReport({
        steps: [
          {
            index: 0,
            kind: "tap",
            status: "fail",
            reason: "no match",
            failure: { ...FAILURE, data: { platform: "android" } },
          },
        ],
      })
    );
    expect(xml).toContain('<property name="argent.platform" value="android"/>');
    // An explicit flag still wins: it is a choice, the other is a fallback.
    expect(buildJUnitXml(mkReport(), { platform: "ios" })).toContain(
      '<property name="argent.platform" value="ios"/>'
    );
  });

  it("renders the expected/actual/match/reads/device slots in the failure body", () => {
    // The sole verbatim JUnit pin uses a determinate, non-environmental fixture
    // with no `expected`/`actual`, so five slots of the body never rendered at
    // all. An indeterminate tree-source failure fills the other four.
    const xml = buildJUnitXml(
      mkReport({
        steps: [
          {
            index: 0,
            kind: "assert",
            status: "fail",
            reason: "still visible",
            failure: {
              code: "assert-hidden-unmet",
              category: "assertion",
              determinacy: "determinate",
              message: "still visible",
              step: { index: 0, ordinal: 1, kind: "assert", flow: "checkout" },
              selector: { described: 'id="spinner"' },
              expected: { kind: "condition", condition: "hidden", timeoutMs: 5000 },
              actual: {
                element: {
                  role: "progressbar",
                  label: "Loading…",
                  identifier: "spinner",
                  frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 },
                },
              },
              screen: { state: "unavailable", reason: "read-failed" },
              candidates: [],
              candidateCount: 0,
              timing: { startedAt: 1, durationMs: 5000 },
            },
          },
        ],
      })
    );
    expect(xml).toContain("expected: hidden");
    expect(xml).toContain("match: &quot;Loading…&quot;  progressbar  id=spinner  visible");

    const environmental = buildJUnitXml(
      mkReport({
        steps: [
          {
            index: 0,
            kind: "assert",
            status: "error",
            reason: "the UI tree source failed",
            failure: {
              code: "tree-source-unavailable",
              category: "environment",
              determinacy: "indeterminate",
              message: "the UI tree source failed",
              step: { index: 0, ordinal: 1, kind: "assert", flow: "checkout" },
              screen: { state: "unavailable", reason: "never-readable" },
              candidates: [],
              candidateCount: 0,
              data: { platform: "ios" },
              timing: { startedAt: 1, durationMs: 5000, attempts: 21, trustedAttempts: 14 },
            },
          },
        ],
      })
    );
    expect(environmental).toContain("reads: 21 attempted, 14 trusted");
    expect(environmental).toContain("device: SIM-1 (ios)");
  });

  it("keeps every document well-formed and structurally valid", () => {
    // Every assertion in this file was `toContain` or a regex, which passes
    // wherever in the document a fragment happens to sit — which is exactly how
    // an element in an illegal position survived the suite.
    for (const xml of [
      buildJUnitXml(mkReport()),
      buildJUnitXml(mkReport({ ok: false, aborted: true, failed: 0, errored: 0, steps: [] })),
      buildJUnitXml({
        flow: "broken",
        device: "",
        ok: false,
        passed: 0,
        failed: 0,
        skipped: 0,
        errored: 0,
        steps: [],
      }),
    ]) {
      expect(XMLValidator.validate(xml)).toBe(true);
      for (const suite of parseSuites(xml)) {
        // The whole content model in one assertion: nothing but the four legal
        // children, and the counters agree with the elements below them.
        expect(
          Object.keys(suite)
            .filter((k) => !k.startsWith("@_"))
            .sort()
        ).toEqual(expect.arrayContaining([]));
        for (const key of Object.keys(suite)) {
          if (key.startsWith("@_")) continue;
          expect(["properties", "testcase", "system-out", "system-err"]).toContain(key);
        }
        expect(attrNumber(suite, "tests")).toBe(testcases(suite).length);
      }
    }
  });

  it("falls back to reason-only output for a pre-diagnostics tool-server", () => {
    const xml = buildJUnitXml(
      mkReport({
        steps: [
          { index: 0, kind: "assert", status: "fail", target: '"Done"', reason: "never visible" },
        ],
      })
    );
    // No failure object and no durationMs: type is the status, and the `time`
    // attribute is ABSENT rather than 0.000 — "never measured" is a different
    // claim from "took no time", and the attribute is optional in JUnit.
    expect(xml).toContain('<failure type="fail" message="never visible">never visible</failure>');
    expect(xml).toContain('<testcase classname="checkout" name="01 assert &quot;Done&quot;">');
    expect(xml).not.toMatch(/<testcase[^>]*time=/);
    // ...and the system-out reports no fabricated duration either.
    expect(xml).not.toContain("durationMs: 0");
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
