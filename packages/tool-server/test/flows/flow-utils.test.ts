import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import {
  countStepsOnDisk,
  serializeFlow,
  parseFlow,
  describeSelector,
  assertValidProjectRoot,
  startRecordingSession,
  getRecordingSession,
  requireRecordingSession,
  clearRecordingSession,
  listActiveRecordings,
  __resetRecordingsForTesting,
  MAX_RECORDINGS,
  getFlowPath,
  appIdForPlatform,
  chromiumLaunchSpec,
  writeNewFlowFile,
  type FlowFile,
} from "../../src/tools/flows/flow-utils";

// ── serializeFlow ────────────────────────────────────────────────────

describe("serializeFlow", () => {
  it("serializes an empty flow with prerequisite", async () => {
    const flow: FlowFile = {
      executionPrerequisite: "App on home screen",
      steps: [],
    };
    const result = serializeFlow(flow);
    expect(result).toContain("executionPrerequisite: App on home screen");
    expect(result).toContain("steps: []");
  });

  it("serializes echo steps", async () => {
    const flow: FlowFile = {
      executionPrerequisite: "Fresh reload",
      steps: [{ kind: "echo", message: "Hello" }],
    };
    const result = serializeFlow(flow);
    expect(result).toContain("- echo: Hello");
  });

  it("serializes tool steps with args", async () => {
    const flow: FlowFile = {
      executionPrerequisite: "",
      steps: [{ kind: "tool", name: "tap", args: { x: 0.5, y: 0.3 } }],
    };
    const result = serializeFlow(flow);
    expect(result).toContain("- tool: tap");
    expect(result).toContain("    x: 0.5");
    expect(result).toContain("    y: 0.3");
  });

  it("serializes tool steps with empty args (omits args key)", async () => {
    const flow: FlowFile = {
      executionPrerequisite: "",
      steps: [{ kind: "tool", name: "screenshot", args: {} }],
    };
    const result = serializeFlow(flow);
    expect(result).toContain("- tool: screenshot");
    expect(result).not.toContain("args:");
  });

  it("rejects gesture targets that cannot round-trip through the parser", async () => {
    const serializeStep = (step: FlowFile["steps"][number]) =>
      serializeFlow({ executionPrerequisite: "", steps: [step] });

    expect(() => serializeStep({ kind: "tap", x: 1.5, y: 0.5 })).toThrow(
      /normalized 0–1 fractions/i
    );
    expect(() => serializeStep({ kind: "long-press", x: Number.NaN, y: 0.5 })).toThrow(
      /normalized 0–1 fractions/i
    );
    expect(() => serializeStep({ kind: "tap", x: 0.5 })).toThrow(/needs numeric x and y/i);
    expect(() =>
      serializeStep({ kind: "long-press", selector: { text: "Row" }, x: 0.5, y: 0.5 })
    ).toThrow(/selector or x\/y coordinates, not both/i);
  });
});

// ── describeSelector ─────────────────────────────────────────────────

describe("describeSelector", () => {
  it("spells identifier as id, the flow-YAML spelling", async () => {
    expect(describeSelector({ identifier: "submit" })).toBe('id="submit"');
  });

  it("renders a text selector", async () => {
    expect(describeSelector({ text: "Login" })).toBe('text="Login"');
  });

  it("drops the internal loose flag", async () => {
    expect(describeSelector({ text: "Login", loose: true })).toBe('text="Login"');
  });

  it("joins multiple keys with spaces", async () => {
    expect(describeSelector({ text: "Login", role: "button" })).toBe('text="Login" role="button"');
  });
});

// ── parseFlow ────────────────────────────────────────────────────────

describe("parseFlow", () => {
  it("parses a flow with executionPrerequisite and echo steps", async () => {
    const content = "executionPrerequisite: App on home screen\nsteps:\n  - echo: Hello\n";
    const flow = parseFlow(content);
    expect(flow.executionPrerequisite).toBe("App on home screen");
    expect(flow.steps).toEqual([{ kind: "echo", message: "Hello" }]);
  });

  it("parses tool entries with args", async () => {
    const content =
      'executionPrerequisite: ""\nsteps:\n  - tool: tap\n    args:\n      x: 0.5\n      y: 0.3\n';
    const flow = parseFlow(content);
    expect(flow.steps).toEqual([{ kind: "tool", name: "tap", args: { x: 0.5, y: 0.3 } }]);
  });

  it("parses tool entries with no args", async () => {
    const content = 'executionPrerequisite: ""\nsteps:\n  - tool: screenshot\n';
    const flow = parseFlow(content);
    expect(flow.steps).toEqual([{ kind: "tool", name: "screenshot", args: {} }]);
  });

  it("parses a multi-step flow", async () => {
    const content = [
      "executionPrerequisite: Settings open",
      "steps:",
      "  - echo: Step 1",
      "  - tool: tap",
      "    args:",
      "      x: 0.5",
      "  - echo: Step 2",
      "  - tool: screenshot",
      "    args:",
      "      udid: ABC",
    ].join("\n");

    const flow = parseFlow(content);
    expect(flow.executionPrerequisite).toBe("Settings open");
    expect(flow.steps).toEqual([
      { kind: "echo", message: "Step 1" },
      { kind: "tool", name: "tap", args: { x: 0.5 } },
      { kind: "echo", message: "Step 2" },
      { kind: "tool", name: "screenshot", args: { udid: "ABC" } },
    ]);
  });

  it("returns empty steps for empty content", async () => {
    const flow = parseFlow("");
    expect(flow.executionPrerequisite).toBe("");
    expect(flow.steps).toEqual([]);
  });

  it("defaults executionPrerequisite to empty string when missing", async () => {
    const content = "steps:\n  - echo: Hello\n";
    const flow = parseFlow(content);
    expect(flow.executionPrerequisite).toBe("");
    expect(flow.steps).toEqual([{ kind: "echo", message: "Hello" }]);
  });

  it("throws on unrecognized entries", async () => {
    const content = 'executionPrerequisite: ""\nsteps:\n  - bogus: line\n';
    expect(() => parseFlow(content)).toThrow("Unrecognized flow entry");
  });

  it("renders a small unrecognized entry in full", async () => {
    // The common authoring error: a short mistyped step. The echo cap must
    // leave it untouched — seeing the whole entry is what makes it fixable.
    const content = 'executionPrerequisite: ""\nsteps:\n  - bogus: line\n';
    expect(() => parseFlow(content)).toThrow(': {"bogus":"line"}');
  });

  it("caps the echoed entry so an oversized value cannot ride the diagnostic", async () => {
    // A mistyped run: path can point parseFlow at any in-project YAML file,
    // and this message flows verbatim to stdout and into agent context — so
    // the render must be bounded, and the tail of the value must not appear.
    const content = `steps:\n  - db_password: "hunter2-${"x".repeat(5000)}-SECRET-TAIL"\n`;
    let message = "";
    try {
      parseFlow(content);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("Unrecognized flow entry");
    expect(message).toContain("…(+");
    expect(message).not.toContain("SECRET-TAIL");
    expect(message.length).toBeLessThan(400);
  });

  it("throws when content is not an object with steps", async () => {
    expect(() => parseFlow("- echo: Hello\n")).toThrow("expected an object with a steps array");
  });

  it("classifies a YAML syntax error as a validation failure with the parser's detail", async () => {
    let thrown: unknown;
    try {
      parseFlow("steps: ][\n");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const signal = getFailureSignal(thrown);
    expect(signal?.error_kind).toBe("validation");
    expect(signal?.error_code).toBe(FAILURE_CODES.FLOW_FILE_INVALID);
    // The yaml library's line/column detail must survive so the user can
    // locate the syntax error.
    expect((thrown as Error).message).toContain("Invalid flow file:");
    expect((thrown as Error).message).toContain("line 1");
  });

  it("throws a validation error (not a TypeError) on a primitive step entry", async () => {
    const content = 'executionPrerequisite: ""\nsteps:\n  - tap\n';
    expect(() => parseFlow(content)).toThrow("Unrecognized flow entry");
  });

  it("throws a validation error on a null step entry", async () => {
    const content = 'executionPrerequisite: ""\nsteps:\n  - ~\n';
    expect(() => parseFlow(content)).toThrow("Unrecognized flow entry");
  });

  it("sugars a bare-string selector into a loose { text } for tap", async () => {
    const flow = parseFlow("steps:\n  - tap: Settings\n");
    // Bare string ⇒ loose: resolves identifier-first, then falls back to text.
    expect(flow.steps).toEqual([{ kind: "tap", selector: { text: "Settings", loose: true } }]);
  });

  it("sugars a bare-string selector for type.into", async () => {
    const flow = parseFlow('steps:\n  - type: { into: email, text: "a@b.com" }\n');
    expect(flow.steps).toEqual([
      { kind: "type", into: { text: "email", loose: true }, text: "a@b.com" },
    ]);
  });

  it("defaults type.submit to on (no submit key in the parsed model)", async () => {
    const flow = parseFlow('steps:\n  - type: { into: email, text: "a@b.com" }\n');
    expect(flow.steps[0]).not.toHaveProperty("submit");
  });

  it("parses and round-trips an explicit type.submit: false opt-out", async () => {
    const flow = parseFlow('steps:\n  - type: { into: email, text: "a@b.com", submit: false }\n');
    expect(flow.steps).toEqual([
      { kind: "type", into: { text: "email", loose: true }, text: "a@b.com", submit: false },
    ]);
    expect(serializeFlow(flow)).toContain("submit: false");
    expect(parseFlow(serializeFlow(flow)).steps).toEqual(flow.steps);
  });

  it("rejects a non-boolean type.submit", async () => {
    expect(() => parseFlow('steps:\n  - type: { into: email, text: "x", submit: 3 }\n')).toThrow();
  });

  it("keeps an explicit { text } map strict (no loose fallback)", async () => {
    const flow = parseFlow("steps:\n  - tap: { text: Settings }\n");
    expect(flow.steps).toEqual([{ kind: "tap", selector: { text: "Settings" } }]);
  });

  it.each([
    [
      "selector",
      "steps:\n  - tap: { text: { matches: '^Order #\\d+$' } }\n",
      { kind: "tap", selector: { textMatches: "^Order #\\d+$" } },
    ],
    [
      "text condition",
      "steps:\n  - assert: { text: { in: total, matches: '^Total: \\$\\d+$' } }\n",
      {
        kind: "assert",
        condition: "text",
        selector: { text: "total", loose: true },
        expectedText: "^Total: \\$\\d+$",
        textMatch: "matches",
      },
    ],
  ] as const)("accepts a valid regex pattern at the %s ingress", (_ingress, yaml, expected) => {
    expect(parseFlow(yaml).steps).toEqual([expected]);
  });

  it("accepts a regex selector combined with id and role", async () => {
    expect(
      parseFlow(
        "steps:\n  - tap: { text: { matches: '^Order #\\d+$' }, id: order-row, role: button }\n"
      ).steps
    ).toEqual([
      {
        kind: "tap",
        selector: {
          textMatches: "^Order #\\d+$",
          identifier: "order-row",
          role: "button",
        },
      },
    ]);
  });

  it.each([
    ["id", "''"],
    ["id", "42"],
    ["role", "''"],
    ["role", "42"],
  ])(
    "validates an invalid regex-selector %s through the same schema as a literal selector (%s)",
    (field, value) => {
      const validationDetail = (text: string | { matches: string }): string => {
        const yamlText = typeof text === "string" ? text : `{ matches: '${text.matches}' }`;
        try {
          parseFlow(`steps:\n  - tap: { text: ${yamlText}, ${field}: ${value} }\n`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const detail = /^Unrecognized flow entry \((.*)\): /.exec(message)?.[1];
          expect(detail).toBeDefined();
          return detail!;
        }
        throw new Error("expected selector validation to fail");
      };

      const literalDetail = validationDetail("Order");
      const regexDetail = validationDetail({ matches: "^Order #\\d+$" });

      expect(literalDetail).toMatch(/^tap: /);
      expect(regexDetail).toBe(literalDetail);
    }
  );

  it.each([
    [
      "selector",
      "steps:\n  - assert: { visible: { text: { matches: '(' } } }\n",
      "assert.visible: text",
    ],
    [
      "text condition",
      "steps:\n  - assert: { text: { in: total, matches: '(' } }\n",
      "assert text",
    ],
  ])("reports invalid regex syntax consistently at the %s ingress", (_ingress, yaml, where) => {
    expect(() => parseFlow(yaml)).toThrow(`${where} \`matches\` is not a valid regular expression`);
  });

  it("parses the map form's `id` as the internal identifier field (strict)", async () => {
    const flow = parseFlow("steps:\n  - tap: { id: submit-btn }\n");
    expect(flow.steps).toEqual([{ kind: "tap", selector: { identifier: "submit-btn" } }]);
  });

  it("accepts `identifier` as a parse-only alias for `id`", async () => {
    const flow = parseFlow("steps:\n  - tap: { identifier: submit-btn }\n");
    expect(flow.steps).toEqual([{ kind: "tap", selector: { identifier: "submit-btn" } }]);
  });

  it("rejects a selector map carrying both `id` and `identifier`", async () => {
    expect(() => parseFlow("steps:\n  - tap: { id: a, identifier: b }\n")).toThrow(
      /`id` or `identifier`.*not both/
    );
  });

  it("re-serializes an identifier-spelled flow with the `id` spelling", async () => {
    // Old files parse via the alias; the next write (appendStep re-serializes
    // the whole file) migrates them to the canonical `id` spelling.
    const yaml = serializeFlow(parseFlow("steps:\n  - tap: { identifier: submit-btn }\n"));
    expect(yaml).toContain("id: submit-btn");
    expect(yaml).not.toContain("identifier:");
  });

  it("parses condition-as-key await/assert sugar (visible/exists/hidden)", async () => {
    const flow = parseFlow(
      [
        "steps:",
        "  - await: { visible: Account }",
        "  - assert: { exists: { id: row } }",
        "  - await: { hidden: spinner }",
      ].join("\n")
    );
    expect(flow.steps).toEqual([
      { kind: "await", condition: "visible", selector: { text: "Account", loose: true } },
      { kind: "assert", condition: "exists", selector: { identifier: "row" } },
      { kind: "await", condition: "hidden", selector: { text: "spinner", loose: true } },
    ]);
  });

  it("parses the text sugar { in, contains } as a substring match", async () => {
    const flow = parseFlow(
      'steps:\n  - assert: { text: { in: { id: counter }, contains: "Taps: 0" } }\n'
    );
    expect(flow.steps).toEqual([
      {
        kind: "assert",
        condition: "text",
        selector: { identifier: "counter" },
        expectedText: "Taps: 0",
        textMatch: "contains",
      },
    ]);
  });

  it("parses the text sugar { in, equals } as an exact match", async () => {
    const flow = parseFlow(
      'steps:\n  - assert: { text: { in: { id: counter }, equals: "Taps: 0" } }\n'
    );
    expect(flow.steps).toEqual([
      {
        kind: "assert",
        condition: "text",
        selector: { identifier: "counter" },
        expectedText: "Taps: 0",
        textMatch: "equals",
      },
    ]);
  });

  it("rejects text sugar with both contains and equals", async () => {
    expect(() =>
      parseFlow("steps:\n  - assert: { text: { in: counter, contains: a, equals: b } }\n")
    ).toThrow(/exactly one of `contains`, `equals`, or `matches`/);
  });

  it("rejects the explicit { condition, selector, expectedText } form (sugar only)", async () => {
    expect(() =>
      parseFlow(
        [
          "steps:",
          "  - assert:",
          "      condition: text",
          "      selector: { text: 'Taps:' }",
          "      expectedText: 'Taps: 0'",
        ].join("\n")
      )
    ).toThrow(/exactly one condition key/);
  });

  it("rejects an await/assert body with no condition key", async () => {
    expect(() => parseFlow("steps:\n  - assert: { selector: foo }\n")).toThrow(
      /exactly one condition key/
    );
  });

  it("rejects text sugar with neither contains nor equals", async () => {
    expect(() => parseFlow("steps:\n  - assert: { text: { in: counter } }\n")).toThrow(
      /exactly one of `contains`, `equals`, or `matches`/
    );
  });

  it("rejects text sugar with an empty contains", async () => {
    expect(() =>
      parseFlow('steps:\n  - assert: { text: { in: counter, contains: "" } }\n')
    ).toThrow(/non-empty `contains`/);
  });

  it("serializes await/assert with the condition-as-key sugar (no condition: field)", async () => {
    const yaml = serializeFlow({
      executionPrerequisite: "",
      steps: [
        // loose ⇒ bare-string sugar; a strict { text } would keep the map form
        { kind: "assert", condition: "visible", selector: { text: "Welcome", loose: true } },
        {
          kind: "assert",
          condition: "text",
          selector: { identifier: "counter" },
          expectedText: "Taps: 0",
          textMatch: "contains",
        },
        {
          kind: "assert",
          condition: "text",
          selector: { identifier: "total" },
          expectedText: "1",
          textMatch: "equals",
        },
      ],
    });
    expect(yaml).toContain("visible: Welcome");
    expect(yaml).not.toContain("condition:");
    expect(yaml).toContain('contains: "Taps: 0"');
    expect(yaml).toContain('equals: "1"');
    expect(yaml).toContain("id: counter");
    expect(yaml).not.toContain("identifier:");
    // An assert never emits a `timeout` key (the parser would reject it back).
    expect(yaml).not.toContain("timeout");
  });

  it.each([
    ["contains", "contains: Expected"],
    ["equals", "equals: Expected"],
    ["matches", "matches: Expected"],
  ] as const)("serializes and round-trips the %s text comparator", (textMatch, yamlComparator) => {
    const step = {
      kind: "assert" as const,
      condition: "text" as const,
      selector: { identifier: "status" },
      expectedText: "Expected",
      textMatch,
    };

    const yaml = serializeFlow({ executionPrerequisite: "", steps: [step] });

    expect(yaml).toContain(yamlComparator);
    expect(parseFlow(yaml).steps).toEqual([step]);
  });

  it("roundtrips the sugared step kinds through YAML", async () => {
    // The spelling carries the loose bit exactly both ways: a LOOSE text-only
    // selector serializes to a bare string (which parses back loose); a strict
    // `{ text }` keeps the map form (which parses back strict). Identifier
    // selectors keep the map form and stay strict.
    const flow: FlowFile = {
      executionPrerequisite: "",
      steps: [
        { kind: "tap", selector: { text: "Login", loose: true } },
        { kind: "tap", selector: { text: "Save" } },
        { kind: "type", into: { text: "email", loose: true }, text: "a@b.com" },
        { kind: "type", into: { text: "Password" }, text: "hunter2" },
        { kind: "await", condition: "hidden", selector: { identifier: "spinner" } },
        { kind: "await", condition: "visible", selector: { text: "Welcome" } },
        { kind: "wait", ms: 500 },
        {
          kind: "assert",
          condition: "text",
          selector: { text: "Taps:", loose: true },
          expectedText: "Taps: 0",
          textMatch: "contains",
        },
        {
          kind: "assert",
          condition: "text",
          selector: { identifier: "total" },
          expectedText: "1",
          textMatch: "equals",
        },
        { kind: "scroll-to", target: { text: "Order #1234", loose: true }, direction: "down" },
        {
          kind: "scroll-to",
          target: { text: "Summer Sale", loose: true },
          direction: "right",
          within: { identifier: "promotions" },
        },
        {
          kind: "scroll-to",
          target: { text: "Checkout" },
          direction: "down",
          within: { text: "Cart items" },
        },
      ],
    };
    expect(parseFlow(serializeFlow(flow)).steps).toEqual(flow.steps);
  });

  it("keeps a strict { text } selector strict across repeated round-trips (never collapsed to a bare loose string)", async () => {
    // The recorder derives strict `{ text }` selectors, and every recorded step
    // re-reads and re-writes the whole file (appendStep) — so a single lossy
    // serialization would silently promote them to loose, sending them through
    // the identifier-first fallback they were never verified against.
    const flow: FlowFile = {
      executionPrerequisite: "",
      steps: [{ kind: "tap", selector: { text: "Save" } }],
    };
    const once = serializeFlow(flow);
    expect(once).toContain("text: Save");
    expect(once).not.toContain("tap: Save");
    const reparsed = parseFlow(once);
    expect(reparsed.steps).toEqual(flow.steps); // no `loose` flag introduced
    expect(parseFlow(serializeFlow(reparsed)).steps).toEqual(flow.steps);
  });

  it("sugars a bare-string scroll-to target and keeps the within map", async () => {
    const flow = parseFlow(
      ["steps:", "  - scroll-to: { target: Account, direction: down }"].join("\n")
    );
    expect(flow.steps).toEqual([
      { kind: "scroll-to", target: { text: "Account", loose: true }, direction: "down" },
    ]);
  });

  it("parses a bare-number wait as milliseconds", async () => {
    const flow = parseFlow("steps:\n  - wait: 750\n");
    expect(flow.steps).toEqual([{ kind: "wait", ms: 750 }]);
  });

  it("rejects a wait that is not a non-negative number", async () => {
    expect(() => parseFlow("steps:\n  - wait: soon\n")).toThrow("wait needs a non-negative number");
    expect(() => parseFlow("steps:\n  - wait: -5\n")).toThrow("wait needs a non-negative number");
  });

  it("parses an await timeout in milliseconds", async () => {
    const flow = parseFlow("steps:\n  - await: { visible: Account, timeout: 10000 }\n");
    expect(flow.steps).toEqual([
      {
        kind: "await",
        condition: "visible",
        selector: { text: "Account", loose: true },
        timeout: 10000,
      },
    ]);
  });

  it("rejects an await timeout that is not a positive finite number", async () => {
    // `.inf`, `.nan`, and an overflowing literal all parse to a typeof-number
    // value; letting Infinity through would make the runner's poll deadline
    // unreachable (an unbounded await).
    for (const bad of ["soon", "0", "-5", ".inf", ".nan", "1e400"]) {
      expect(() => parseFlow(`steps:\n  - await: { visible: Account, timeout: ${bad} }\n`)).toThrow(
        "await.timeout needs a positive number of milliseconds"
      );
    }
  });

  it("rejects a timeout on an assert step (an assert is an immediate check)", async () => {
    // The internal assert step has no timeout field, so a YAML `timeout` used
    // to be silently dropped; reject it loudly instead — a check that needs
    // time to become true is a wait, spelled `await`.
    expect(() => parseFlow("steps:\n  - assert: { visible: Account, timeout: 9000 }\n")).toThrow(
      /assert has no timeout/
    );
    expect(() =>
      parseFlow('steps:\n  - assert: { text: { in: counter, equals: "0" }, timeout: 5000 }\n')
    ).toThrow(/assert has no timeout/);
  });

  it("rejects a scroll-to with an invalid direction", async () => {
    expect(() =>
      parseFlow("steps:\n  - scroll-to: { target: Account, direction: sideways }\n")
    ).toThrow("scroll-to direction must be one of");
  });

  it("defaults scroll-to direction to down", async () => {
    const flow = parseFlow("steps:\n  - scroll-to: { target: Account }\n");
    expect(flow.steps).toEqual([
      { kind: "scroll-to", target: { text: "Account", loose: true }, direction: "down" },
    ]);
  });

  it("parses a bare-string scroll-to as a down-scroll to that target", async () => {
    const flow = parseFlow("steps:\n  - scroll-to: Account\n");
    expect(flow.steps).toEqual([
      { kind: "scroll-to", target: { text: "Account", loose: true }, direction: "down" },
    ]);
  });

  it("serializes the default scroll-to back to the bare-string sugar", async () => {
    const steps = [
      { kind: "scroll-to", target: { text: "Account", loose: true }, direction: "down" },
    ] as FlowFile["steps"];
    const yaml = serializeFlow({ executionPrerequisite: "", steps });
    expect(yaml).toContain("- scroll-to: Account");
    expect(parseFlow(yaml).steps).toEqual(steps);
  });

  it("parses a bare-string snapshot as its name", async () => {
    const flow = parseFlow("steps:\n  - snapshot: home\n");
    expect(flow.steps).toEqual([{ kind: "snapshot", name: "home" }]);
  });

  it("serializes a name-only snapshot as a bare string, keeps the map with maxMismatch", async () => {
    const steps = [
      { kind: "snapshot", name: "home" },
      { kind: "snapshot", name: "cart", maxMismatch: 1.5 },
    ] as FlowFile["steps"];
    const yaml = serializeFlow({ executionPrerequisite: "", steps });
    expect(yaml).toContain("- snapshot: home");
    expect(yaml).toContain("maxMismatch: 1.5");
    expect(parseFlow(yaml).steps).toEqual(steps);
  });

  it("rejects a snapshot name that is not path-safe", async () => {
    expect(() => parseFlow("steps:\n  - snapshot: ../evil\n")).toThrow(/must match/);
  });

  it("accepts a string-number maxMismatch", async () => {
    const flow = parseFlow('steps:\n  - snapshot: { name: home, maxMismatch: "1.5" }\n');
    expect(flow.steps).toEqual([{ kind: "snapshot", name: "home", maxMismatch: 1.5 }]);
  });

  it("rejects a non-numeric, negative, or out-of-range maxMismatch", async () => {
    for (const bad of ['"5%"', "-1", "101", ".nan"]) {
      expect(() =>
        parseFlow(`steps:\n  - snapshot: { name: home, maxMismatch: ${bad} }\n`)
      ).toThrow("snapshot maxMismatch must be a number between 0 and 100");
    }
  });

  it("parses snapshot cropOn as a selector (bare-string loose, map strict)", async () => {
    const flow = parseFlow(
      "steps:\n" +
        "  - snapshot: { name: home, cropOn: Header }\n" +
        "  - snapshot: { name: cart, cropOn: { id: cart-total } }\n"
    );
    expect(flow.steps).toEqual([
      { kind: "snapshot", name: "home", cropOn: { text: "Header", loose: true } },
      { kind: "snapshot", name: "cart", cropOn: { identifier: "cart-total" } },
    ]);
  });

  it("serializes snapshot cropOn in the map form and round-trips", async () => {
    const steps = [
      { kind: "snapshot", name: "home", cropOn: { text: "Header", loose: true } },
      { kind: "snapshot", name: "cart", maxMismatch: 1.5, cropOn: { identifier: "cart-total" } },
    ] as FlowFile["steps"];
    const yaml = serializeFlow({ executionPrerequisite: "", steps });
    expect(yaml).toContain("cropOn: Header");
    expect(parseFlow(yaml).steps).toEqual(steps);
  });

  it("rejects a point-form cropOn — a point has no extent to crop to", async () => {
    expect(() =>
      parseFlow("steps:\n  - snapshot: { name: home, cropOn: { x: 0.5, y: 0.5 } }\n")
    ).toThrow(/snapshot\.cropOn: selector has unknown keys `x`, `y`/);
  });

  it("rejects a tap body mixing a selector with coordinates", async () => {
    for (const key of ["id", "identifier"]) {
      expect(() => parseFlow(`steps:\n  - tap: { ${key}: box, x: 0.5, y: 0.5 }\n`)).toThrow(
        "tap takes a selector or x/y coordinates, not both"
      );
    }
  });

  it("rejects a coordinate tap with a missing or non-numeric x/y", async () => {
    expect(() => parseFlow("steps:\n  - tap: { x: 0.5 }\n")).toThrow(
      "tap: a coordinate target needs numeric x and y"
    );
    expect(() => parseFlow('steps:\n  - tap: { x: "0.5", y: 0.5 }\n')).toThrow(
      "tap: a coordinate target needs numeric x and y"
    );
  });

  it("round-trips free-text values exactly, including whitespace-only lines", async () => {
    // The parser stores every free-text field verbatim — `type.text`, `echo`,
    // await/assert `contains`/`equals`, and `executionPrerequisite` are never
    // trimmed — so serialization must be byte-exact too. Default yamlStringify
    // emits multi-line values as block scalars, whose chomping silently strips
    // whitespace-only lines on re-parse (" \n" came back as "\n"); serializeFlow
    // disables blockQuote so these values round-trip via double-quoted escapes.
    const values = [
      "line1\nline2",
      "line1\nline2 ", // trailing space on the final content line
      " \n", // whitespace-only line — silently corrupted by a block scalar
      "  \n \n",
      "\t\n",
      "  hi  ",
      "plain single line",
    ];
    for (const value of values) {
      const flow: FlowFile = {
        executionPrerequisite: value,
        steps: [
          { kind: "echo", message: value },
          { kind: "type", into: { text: "email", loose: true }, text: value },
          {
            kind: "await",
            condition: "text",
            selector: { identifier: "counter" },
            expectedText: value,
            textMatch: "contains",
            timeout: 5000,
          },
          {
            kind: "assert",
            condition: "text",
            selector: { identifier: "total" },
            expectedText: value,
            textMatch: "equals",
          },
        ],
      };
      expect(parseFlow(serializeFlow(flow))).toEqual(flow);
    }
  });

  it("never serializes a whitespace-only-line value as a block scalar", async () => {
    const steps = [{ kind: "echo", message: "step one \n \ndone" }] as FlowFile["steps"];
    const yaml = serializeFlow({ executionPrerequisite: "", steps });
    // Block (|) and folded (>) scalars are not round-trip-safe for this shape;
    // the value must be emitted as a double-quoted flow scalar instead.
    expect(yaml).not.toContain("|");
    expect(yaml).not.toContain(">");
    expect(yaml).toContain("\\n"); // newlines spelled as escapes inside quotes
    expect(parseFlow(yaml).steps).toEqual(steps);
  });

  // Flows are hand-authored YAML, so a misspelled option key must fail at
  // parse time — silently dropping it would apply the default instead and
  // surface later as a misleading runtime failure (wrong scroll direction,
  // lost submit opt-out, lost timeout, lost snapshot tolerance).
  describe("unknown option keys are rejected at parse time", () => {
    it("rejects a misspelled scroll-to direction key with a suggestion", async () => {
      expect(() =>
        parseFlow("steps:\n  - scroll-to: { target: Order-1234, directon: up }\n")
      ).toThrow(/scroll-to has unknown key `directon` \(did you mean `direction`\?\)/);
    });

    it("rejects a misspelled type.submit key with a suggestion", async () => {
      expect(() =>
        parseFlow('steps:\n  - type: { into: email, text: "a@b.com", sumbit: false }\n')
      ).toThrow(/type has unknown key `sumbit` \(did you mean `submit`\?\)/);
    });

    it("rejects a misspelled await.timeout key with a suggestion", async () => {
      expect(() => parseFlow("steps:\n  - await: { visible: Account, timeut: 10000 }\n")).toThrow(
        /await has unknown key `timeut` \(did you mean `timeout`\?\)/
      );
    });

    it("rejects a misspelled snapshot.maxMismatch key with a suggestion", async () => {
      expect(() => parseFlow("steps:\n  - snapshot: { name: home, maxMissmatch: 1.5 }\n")).toThrow(
        /snapshot has unknown key `maxMissmatch` \(did you mean `maxMismatch`\?\)/
      );
    });

    it("rejects a miscased snapshot.cropOn key with a suggestion", async () => {
      expect(() => parseFlow("steps:\n  - snapshot: { name: home, cropon: Header }\n")).toThrow(
        /snapshot has unknown key `cropon` \(did you mean `cropOn`\?\)/
      );
    });

    it("rejects an unknown key on a selector map", async () => {
      expect(() => parseFlow("steps:\n  - tap: { text: Save, roel: button }\n")).toThrow(
        /tap: selector has unknown key `roel` \(did you mean `role`\?\)/
      );
      expect(() => parseFlow("steps:\n  - await: { visible: { txt: Save } }\n")).toThrow(
        /await.visible: selector has unknown key `txt` \(did you mean `text`\?\)/
      );
      expect(() =>
        parseFlow("steps:\n  - scroll-to: { target: { text: Row }, within: { identfier: list } }\n")
      ).toThrow(
        /scroll-to.within: selector has unknown key `identfier` \(did you mean `identifier`\?\)/
      );
    });

    it("rejects an unknown key without a suggestion when nothing is close", async () => {
      expect(() => parseFlow("steps:\n  - scroll-to: { target: Row, sideways: true }\n")).toThrow(
        /scroll-to has unknown key `sideways` — allowed keys: target, direction, within/
      );
    });

    it("rejects an unknown key in an await/assert text body", async () => {
      expect(() =>
        parseFlow('steps:\n  - assert: { text: { in: counter, contians: "Taps: 0" } }\n')
      ).toThrow(/assert.text has unknown key `contians` \(did you mean `contains`\?\)/);
    });

    it("rejects a stray key on a coordinate tap", async () => {
      expect(() => parseFlow("steps:\n  - tap: { x: 0.5, y: 0.5, why: 0.6 }\n")).toThrow(
        /tap: a coordinate target takes only \{ x, y \}/
      );
    });

    it("rejects an unknown key in a launch map and its chromium value", async () => {
      expect(() => parseFlow("steps:\n  - launch: { amdroid: com.acme.app }\n")).toThrow(
        /launch has unknown key `amdroid` \(did you mean `android`\?\)/
      );
      expect(() =>
        parseFlow("steps:\n  - launch: { chromium: { path: ./app, arg: [--e2e] } }\n")
      ).toThrow(/launch.chromium has unknown key `arg` \(did you mean `args`\?\)/);
    });

    it("rejects a step-level sibling key (options belong inside the directive value)", async () => {
      expect(() =>
        parseFlow("steps:\n  - await: { visible: Account }\n    timeout: 5000\n")
      ).toThrow(
        /a `await` step has unknown key `timeout` — step options go inside the `await:` value/
      );
    });

    it("rejects a step carrying two directive keys", async () => {
      expect(() => parseFlow("steps:\n  - echo: hi\n    tap: Save\n")).toThrow(
        /a step takes exactly one directive key, found `echo`, `tap`/
      );
    });

    it("suggests the directive key for a misspelled step kind", async () => {
      expect(() => parseFlow("steps:\n  - snapshoot: home\n")).toThrow(
        /unrecognized step kind \(did you mean `snapshot`\?\)/
      );
    });

    it("rejects an unknown top-level flow file key", async () => {
      expect(() =>
        parseFlow("executionPrerequisit: Settings open\nsteps:\n  - echo: hi\n")
      ).toThrow(/unknown key `executionPrerequisit` \(did you mean `executionPrerequisite`\?\)/);
    });
  });

  it("roundtrips: serialize then parse", async () => {
    const flow: FlowFile = {
      executionPrerequisite: "App freshly loaded on home screen",
      steps: [
        { kind: "echo", message: "Launch app" },
        { kind: "tool", name: "launch-app", args: { bundleId: "com.test" } },
        { kind: "tool", name: "tap", args: { x: 0.5, y: 0.3 } },
        { kind: "echo", message: "Done" },
      ],
    };
    const serialized = serializeFlow(flow);
    expect(parseFlow(serialized)).toEqual(flow);
  });
});

// ── chromium launch (app path) ───────────────────────────────────────

describe("chromium launch parsing", () => {
  it("parses a chromium launch with a bare-string app path", async () => {
    const flow = parseFlow("steps:\n  - launch: { chromium: ./app }\n");
    expect(flow.steps).toEqual([{ kind: "launch", app: { chromium: "./app" } }]);
  });

  it("parses a chromium launch with a { path, args } map", async () => {
    const flow = parseFlow("steps:\n  - launch: { chromium: { path: ./app, args: [--e2e] } }\n");
    expect(flow.steps).toEqual([
      { kind: "launch", app: { chromium: { path: "./app", args: ["--e2e"] } } },
    ]);
  });

  it("parses a mixed per-platform launch (ios id + chromium path)", async () => {
    const flow = parseFlow("steps:\n  - launch: { ios: com.acme.app, chromium: ./app }\n");
    expect(flow.steps).toEqual([
      { kind: "launch", app: { ios: "com.acme.app", chromium: "./app" } },
    ]);
  });

  it("round-trips a chromium { path, args } launch through YAML", async () => {
    const flow: FlowFile = {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: { chromium: { path: "/abs/app", args: ["--foo", "--bar"] } } },
      ],
    };
    expect(parseFlow(serializeFlow(flow)).steps).toEqual(flow.steps);
  });

  it("rejects a chromium map with no path", async () => {
    expect(() => parseFlow("steps:\n  - launch: { chromium: { args: [--e2e] } }\n")).toThrow(
      /launch needs/
    );
  });

  it("rejects a chromium map with non-string args", async () => {
    expect(() =>
      parseFlow("steps:\n  - launch: { chromium: { path: ./app, args: [1, 2] } }\n")
    ).toThrow(/launch needs/);
  });
});

describe("chromiumLaunchSpec", () => {
  it("reads a bare-string launch as the app path", async () => {
    expect(chromiumLaunchSpec("./app")).toEqual({ path: "./app" });
  });

  it("reads a chromium string value as the path", async () => {
    expect(chromiumLaunchSpec({ chromium: "./app" })).toEqual({ path: "./app" });
  });

  it("reads a chromium { path, args } value", async () => {
    expect(chromiumLaunchSpec({ chromium: { path: "./app", args: ["--e2e"] } })).toEqual({
      path: "./app",
      args: ["--e2e"],
    });
  });

  it("returns null when no chromium target is declared", async () => {
    expect(chromiumLaunchSpec({ ios: "com.acme.app" })).toBeNull();
    expect(chromiumLaunchSpec(undefined)).toBeNull();
  });

  it("appIdForPlatform returns the chromium path (the runner's declared-target guard)", async () => {
    expect(appIdForPlatform({ chromium: { path: "./app", args: ["--e2e"] } }, "chromium")).toBe(
      "./app"
    );
    expect(appIdForPlatform({ chromium: "./app" }, "chromium")).toBe("./app");
    expect(appIdForPlatform({ ios: "com.acme.app" }, "chromium")).toBeNull();
  });
});

// ── native shorthand ─────────────────────────────────────────────────

describe("native launch shorthand", () => {
  it("parses a native-only launch and round-trips it", async () => {
    const flow = parseFlow("steps:\n  - launch: { native: com.acme.app }\n");
    expect(flow.steps).toEqual([{ kind: "launch", app: { native: "com.acme.app" } }]);
    expect(parseFlow(serializeFlow(flow)).steps).toEqual(flow.steps);
  });

  it("parses native alongside a per-platform override and a chromium path", async () => {
    const flow = parseFlow(
      "steps:\n  - launch: { native: com.acme.app, android: com.acme.app.debug, chromium: ./app }\n"
    );
    expect(flow.steps).toEqual([
      {
        kind: "launch",
        app: { native: "com.acme.app", android: "com.acme.app.debug", chromium: "./app" },
      },
    ]);
  });

  it("rejects an empty native id", async () => {
    expect(() => parseFlow('steps:\n  - launch: { native: "" }\n')).toThrow(/launch needs/);
  });

  it("appIdForPlatform falls back to native for installed platforms, override wins", async () => {
    const app = { native: "com.acme.app", android: "com.acme.app.debug" };
    // native fills in for platforms without a specific key…
    expect(appIdForPlatform(app, "ios")).toBe("com.acme.app");
    expect(appIdForPlatform(app, "vega")).toBe("com.acme.app");
    // …and a specific key overrides it.
    expect(appIdForPlatform(app, "android")).toBe("com.acme.app.debug");
  });

  it("native never applies to chromium (chromium takes a path, not an id)", async () => {
    expect(appIdForPlatform({ native: "com.acme.app" }, "chromium")).toBeNull();
    expect(chromiumLaunchSpec({ native: "com.acme.app" })).toBeNull();
  });
});

// ── Recording sessions ───────────────────────────────────────────────

// Recordings live in a map keyed by the resolved flow file path, so a session
// has no identity beyond (project_root, name) — two agents recording at once
// must never write into each other's take. What is isolated is the artifact,
// not the fact that a recording exists: the not-found message deliberately
// names the other live flows in the caller's own project and counts the rest,
// and the two cases below pin that disclosure as bounded rather than absent.
describe("recording sessions", () => {
  beforeEach(() => {
    __resetRecordingsForTesting();
  });

  const emptyFlow = (): FlowFile => ({ executionPrerequisite: "", steps: [] });

  const start = (projectRoot: string, name: string, flow: FlowFile = emptyFlow()) =>
    startRecordingSession({
      name,
      projectRoot,
      persist: "host",
      filePath: getFlowPath(projectRoot, name),
      flow,
    });

  it("throws when the key has no recording", async () => {
    await expect(requireRecordingSession("/tmp/proj-a", "my-flow")).rejects.toThrow(
      /No active recording for flow "my-flow"/
    );
  });

  it("classifies the not-found throw as FLOW_NO_ACTIVE_RECORDING", async () => {
    let caught: unknown;
    try {
      await requireRecordingSession("/tmp/proj-a", "my-flow");
    } catch (err) {
      caught = err;
    }
    expect(getFailureSignal(caught)?.error_code).toBe(FAILURE_CODES.FLOW_NO_ACTIVE_RECORDING);
  });

  it("names the asked-for key and this project's live recordings in the not-found message", async () => {
    // With concurrent recordings the usual cause is a typo or the wrong
    // project_root; the agent can only self-correct if it sees the live keys.
    await start("/tmp/proj-a", "checkout");
    await start("/tmp/proj-b", "login");
    await expect(requireRecordingSession("/tmp/proj-a", "chekout")).rejects.toThrow(
      /No active recording for flow "chekout" in \/tmp\/proj-a\./
    );
    await expect(requireRecordingSession("/tmp/proj-a", "chekout")).rejects.toThrow(
      /Active recordings: "checkout" \(plus 1 in other projects\)\./
    );
  });

  it("counts other projects' recordings without naming them", async () => {
    // A tool-server bound beyond loopback serves unrelated callers; another
    // project's flow names and absolute paths are not this caller's to see.
    await start("/tmp/proj-b", "login");
    await start("/tmp/proj-c", "secret-onboarding");
    const message = await (async () => {
      try {
        await requireRecordingSession("/tmp/proj-a", "my-flow");
      } catch (err) {
        return (err as Error).message;
      }
      throw new Error("expected a throw");
    })();
    expect(message).toMatch(
      /Active recordings: none in this project \(plus 2 in other projects\)\./
    );
    expect(message).not.toContain("login");
    expect(message).not.toContain("secret-onboarding");
    expect(message).not.toContain("/tmp/proj-b");
    expect(message).not.toContain("/tmp/proj-c");
  });

  it("treats a differently-spelled but identical root as THIS project", async () => {
    // The partition compares path.join-normalized flows dirs, not raw strings.
    // A caller that spells its own root with a trailing slash must still be
    // shown its own live recordings — a strict === would answer "none in this
    // project (plus 1 in other projects)", degrading the message in exactly the
    // wrong-project_root case it exists to diagnose. Every other test here
    // spells both sides identically, so only this one separates the two.
    await start("/tmp/proj-a", "checkout");
    const message = await (async () => {
      try {
        await requireRecordingSession("/tmp/proj-a/", "chekout");
      } catch (err) {
        return (err as Error).message;
      }
      throw new Error("expected a throw");
    })();
    expect(message).toMatch(/Active recordings: "checkout"\./);
    expect(message).not.toContain("other projects");
  });

  it("does not tell the agent to just call flow-start-recording", async () => {
    // This message is reached for a key that was never started, but equally for
    // one that was finished, superseded, or dropped by the concurrency cap —
    // and in those cases the flow file on disk is fully populated. Naming
    // flow-start-recording as the fix destroys it, because it truncates
    // unconditionally and reports no `restarted` when no session was replaced.
    const message = await (async () => {
      try {
        await requireRecordingSession("/tmp/proj-a", "finished-earlier");
      } catch (err) {
        return (err as Error).message;
      }
      throw new Error("expected a throw");
    })();
    expect(message).toContain("truncates");
    expect(message).toMatch(/record under a fresh name|copy it aside/);
    expect(message).not.toMatch(/Call flow-start-recording first/);
  });

  it('reports "none in this project" when nothing is being recorded', async () => {
    await expect(requireRecordingSession("/tmp/proj-a", "my-flow")).rejects.toThrow(
      /Active recordings: none in this project\./
    );
  });

  it("returns the session that was started for that key", async () => {
    await start("/tmp/proj-a", "my-flow");
    const session = await requireRecordingSession("/tmp/proj-a", "my-flow");
    expect(session.name).toBe("my-flow");
    expect(session.projectRoot).toBe("/tmp/proj-a");
    expect(session.persist).toBe("host");
    expect(session.filePath).toBe(getFlowPath("/tmp/proj-a", "my-flow"));
  });

  it("getRecordingSession returns undefined for a key with no recording", async () => {
    expect(await getRecordingSession("/tmp/proj-a", "my-flow")).toBeUndefined();
  });

  it("getRecordingSession returns the live session", async () => {
    await start("/tmp/proj-a", "my-flow");
    expect((await getRecordingSession("/tmp/proj-a", "my-flow"))?.name).toBe("my-flow");
  });

  it("clearRecordingSession removes only that key", async () => {
    await start("/tmp/proj-a", "my-flow");
    await start("/tmp/proj-a", "other-flow");
    await clearRecordingSession("/tmp/proj-a", "my-flow");
    expect(await getRecordingSession("/tmp/proj-a", "my-flow")).toBeUndefined();
    await expect(requireRecordingSession("/tmp/proj-a", "my-flow")).rejects.toThrow(
      /No active recording for flow "my-flow"/
    );
    // The unrelated recording is untouched.
    expect((await requireRecordingSession("/tmp/proj-a", "other-flow")).name).toBe("other-flow");
  });

  it("keeps same-named recordings under different project roots independent", async () => {
    await start("/tmp/proj-a", "my-flow", { executionPrerequisite: "A", steps: [] });
    await start("/tmp/proj-b", "my-flow", { executionPrerequisite: "B", steps: [] });
    expect(
      (await requireRecordingSession("/tmp/proj-a", "my-flow")).flow.executionPrerequisite
    ).toBe("A");
    expect(
      (await requireRecordingSession("/tmp/proj-b", "my-flow")).flow.executionPrerequisite
    ).toBe("B");
    // Finishing one leaves the other recording.
    await clearRecordingSession("/tmp/proj-a", "my-flow");
    expect(await getRecordingSession("/tmp/proj-a", "my-flow")).toBeUndefined();
    expect(
      (await requireRecordingSession("/tmp/proj-b", "my-flow")).flow.executionPrerequisite
    ).toBe("B");
  });

  it("returns null when starting a recording on a free key", async () => {
    expect(await start("/tmp/proj-a", "my-flow")).toBeNull();
    // A second, unrelated recording is the common concurrent case — not a replace.
    expect(await start("/tmp/proj-a", "other-flow")).toBeNull();
    expect(await start("/tmp/proj-b", "my-flow")).toBeNull();
  });

  it("returns the replaced session when re-recording the same key", async () => {
    await start("/tmp/proj-a", "my-flow", { executionPrerequisite: "first take", steps: [] });
    const replaced = await start("/tmp/proj-a", "my-flow", {
      executionPrerequisite: "second take",
      steps: [],
    });
    expect(replaced?.flow.executionPrerequisite).toBe("first take");
    // The later take wins — one key, one writer.
    expect(
      (await requireRecordingSession("/tmp/proj-a", "my-flow")).flow.executionPrerequisite
    ).toBe("second take");
  });

  it("evicts the least recently USED recording, not the oldest one", async () => {
    // The cap is a leak backstop, but which entry it drops matters: evicting a
    // recording an agent is actively using would strand its steps. Fill past
    // the cap, touching the first-registered key just before the overflow — it
    // must survive and the untouched next-oldest must go. A FIFO eviction fails
    // this deterministically.
    //
    // It does NOT reliably catch an LRU keyed on a millisecond clock: that only
    // ties when the whole fill and the touch land inside one millisecond, which
    // holds when this file runs alone but not under full-suite load. The
    // counter's tie-freedom is argued at `touch()` rather than pinned here.
    const cap = MAX_RECORDINGS;
    for (let i = 0; i < cap; i++) await start("/tmp/proj-a", `flow-${i}`);
    expect(listActiveRecordings()).toHaveLength(cap);

    await requireRecordingSession("/tmp/proj-a", "flow-0"); // now most-recently-used
    await start("/tmp/proj-a", "overflow");

    const live = new Set(listActiveRecordings().map((r) => r.name));
    expect(live.size).toBe(cap);
    expect(live.has("flow-0")).toBe(true); // touched, so kept
    expect(live.has("flow-1")).toBe(false); // untouched and now the oldest use
    expect(live.has("overflow")).toBe(true);
  });

  it("listActiveRecordings reflects what is live", async () => {
    expect(listActiveRecordings()).toEqual([]);
    await start("/tmp/proj-a", "my-flow", {
      executionPrerequisite: "",
      steps: [{ kind: "echo", message: "hi" }],
    });
    await start("/tmp/proj-b", "my-flow");
    expect(listActiveRecordings()).toEqual([
      { name: "my-flow", projectRoot: "/tmp/proj-a", steps: 1 },
      { name: "my-flow", projectRoot: "/tmp/proj-b", steps: 0 },
    ]);
    await clearRecordingSession("/tmp/proj-a", "my-flow");
    expect(listActiveRecordings()).toEqual([
      { name: "my-flow", projectRoot: "/tmp/proj-b", steps: 0 },
    ]);
    __resetRecordingsForTesting();
    expect(listActiveRecordings()).toEqual([]);
  });

  it("keys a session by the normalized flow path, so a trailing slash rejoins it", async () => {
    await start("/tmp/proj-a", "my-flow");
    expect((await requireRecordingSession("/tmp/proj-a/", "my-flow")).name).toBe("my-flow");
    expect(await start("/tmp/proj-a/", "my-flow")).not.toBeNull();
    expect(listActiveRecordings()).toHaveLength(1);
  });
});

// ── getFlowPath name validation ──────────────────────────────────────

describe("getFlowPath name validation", () => {
  // Pure path math over two explicit inputs — the root is a parameter, never
  // shared state, so two callers naming two projects can never collide.
  const root = "/tmp/argent-flow-name-test";

  it("accepts plain alphanumeric names", async () => {
    expect(getFlowPath(root, "my-flow_1")).toBe(
      path.join(root, ".argent", "flows", "my-flow_1.yaml")
    );
  });

  it("normalizes a trailing slash on the project root", async () => {
    // The flow path doubles as the recording-session key: a trailing slash must
    // not mint a second identity for the same file.
    expect(getFlowPath("/tmp/x/", "f")).toBe(getFlowPath("/tmp/x", "f"));
  });

  it("rejects path-traversal segments", async () => {
    expect(() => getFlowPath(root, "../../etc/passwd")).toThrow(/Invalid flow name/);
    expect(() => getFlowPath(root, "../foo")).toThrow(/Invalid flow name/);
  });

  it("rejects path separators", async () => {
    expect(() => getFlowPath(root, "foo/bar")).toThrow(/Invalid flow name/);
    expect(() => getFlowPath(root, "/abs/path")).toThrow(/Invalid flow name/);
  });

  it("rejects names with spaces or shell metacharacters", async () => {
    expect(() => getFlowPath(root, "foo bar")).toThrow(/Invalid flow name/);
    expect(() => getFlowPath(root, "foo;bar")).toThrow(/Invalid flow name/);
    expect(() => getFlowPath(root, "foo$(id)")).toThrow(/Invalid flow name/);
  });

  it("rejects empty names", async () => {
    expect(() => getFlowPath(root, "")).toThrow(/Invalid flow name/);
  });
});

// PR #194 follow-up C: project_root must be absolute AND free of ".."
// segments (path.join collapses ".." and would relocate the flows dir).
describe("assertValidProjectRoot validation", () => {
  it("rejects a relative project_root", async () => {
    expect(() => assertValidProjectRoot("relative/path")).toThrow(/absolute path/);
  });

  it('rejects an absolute project_root containing ".." segments', async () => {
    expect(() => assertValidProjectRoot("/a/../../../etc")).toThrow(/must not contain "\.\."/);
    expect(() => assertValidProjectRoot("/home/user/../../root")).toThrow(
      /must not contain "\.\."/
    );
  });

  it("accepts a clean absolute project_root", async () => {
    expect(() => assertValidProjectRoot("/tmp/argent-pr194-c-test")).not.toThrow();
  });
});

// ── within (descendant) selector scoping ─────────────────────────────

describe("within selector scoping", () => {
  it("parses a within scope on a tap selector", async () => {
    const flow = parseFlow("steps:\n  - tap: { text: Delete, within: { id: profile-card } }\n");
    expect(flow.steps).toEqual([
      {
        kind: "tap",
        selector: { text: "Delete", within: { identifier: "profile-card" } },
      },
    ]);
  });

  it("a bare-string within stays loose (identifier-first, then text)", async () => {
    const flow = parseFlow("steps:\n  - tap: { text: Delete, within: profile-card }\n");
    expect(flow.steps).toEqual([
      {
        kind: "tap",
        selector: { text: "Delete", within: { text: "profile-card", loose: true } },
      },
    ]);
  });

  it("within chains outward and round-trips exactly", async () => {
    const flow: FlowFile = {
      executionPrerequisite: "",
      steps: [
        {
          kind: "tap",
          selector: {
            text: "Delete",
            within: { identifier: "cards", within: { text: "Settings" } },
          },
        },
        {
          kind: "await",
          condition: "visible",
          selector: { text: "Saved", within: { text: "toast-area", loose: true } },
        },
        {
          kind: "assert",
          condition: "text",
          selector: { identifier: "total", within: { role: "AXTable" } },
          expectedText: "Total: 3",
          textMatch: "equals",
        },
      ],
    };
    expect(parseFlow(serializeFlow(flow))).toEqual(flow);
  });

  it("serializes a loose within back to its bare-string spelling", async () => {
    const yaml = serializeFlow({
      executionPrerequisite: "",
      steps: [
        {
          kind: "tap",
          selector: { text: "Delete", within: { text: "profile-card", loose: true } },
        },
      ],
    });
    expect(yaml).toContain("within: profile-card");
  });

  it("accepts the regex text matcher inside a within scope", async () => {
    const flow = parseFlow(
      "steps:\n  - assert: { visible: { text: Delete, within: { text: { matches: '^Card \\d+$' } } } }\n"
    );
    expect(flow.steps).toEqual([
      {
        kind: "assert",
        condition: "visible",
        selector: { text: "Delete", within: { textMatches: "^Card \\d+$" } },
      },
    ]);
  });

  it("rejects a selector that is ONLY a within scope", async () => {
    expect(() => parseFlow("steps:\n  - tap: { within: { id: card } }\n")).toThrow(
      /still needs its own text\/id\/role/
    );
  });

  it("rejects unknown keys inside a within scope, naming the nested slot", async () => {
    expect(() => parseFlow("steps:\n  - tap: { text: Delete, within: { idd: card } }\n")).toThrow(
      /tap\.within: selector has unknown key `idd` \(did you mean `id`\?\)/
    );
  });

  it("rejects id+identifier both set inside a within scope", async () => {
    expect(() =>
      parseFlow("steps:\n  - tap: { text: A, within: { id: x, identifier: x } }\n")
    ).toThrow(/`id` or `identifier` \(its alias\), not both/);
  });

  it("rejects a cyclic within alias via the depth cap", async () => {
    const yaml = "steps:\n  - tap: &s { text: Delete, within: *s }\n";
    expect(() => parseFlow(yaml)).toThrow(/nest deeper than|cyclic YAML alias/);
  });

  it("rejects a within selector mixed with coordinates", async () => {
    expect(() => parseFlow("steps:\n  - tap: { within: { id: card }, x: 0.5, y: 0.5 }\n")).toThrow(
      /takes a selector or x\/y coordinates, not both/
    );
  });

  it("rejects a within key beside the tap options form", async () => {
    expect(() =>
      parseFlow("steps:\n  - tap: { on: Photo, times: 2, within: { id: card } }\n")
    ).toThrow(/the tap options form takes a nested selector/);
  });

  it("within works in scroll-to's target while scroll-to's own within stays the container anchor", async () => {
    const flow = parseFlow(
      [
        "steps:",
        "  - scroll-to:",
        "      target: { text: Delete, within: { id: cards } }",
        "      direction: down",
        "      within: { id: settings-list }",
      ].join("\n") + "\n"
    );
    expect(flow.steps).toEqual([
      {
        kind: "scroll-to",
        target: { text: "Delete", within: { identifier: "cards" } },
        direction: "down",
        within: { identifier: "settings-list" },
      },
    ]);
  });

  it("describeSelector renders the scope chain in parentheses", async () => {
    expect(
      describeSelector({
        text: "Delete",
        within: { identifier: "cards", within: { text: "Settings" } },
      })
    ).toBe('text="Delete" within (id="cards" within (text="Settings"))');
  });

  it("when guards reject a {{secret:…}} placeholder hidden in a within scope", async () => {
    expect(() =>
      parseFlow(
        [
          "steps:",
          "  - when: { visible: { text: Delete, within: { text: '{{secret:TOKEN}}' } } }",
          "    steps:",
          "      - echo: hi",
        ].join("\n") + "\n"
      )
    ).toThrow(/secret/);
  });
});

// ── sibling scopes (`after`/`next`) and the `any` universal selector ──

describe("sibling selector scopes and the universal selector", () => {
  it("parses `after` (CSS ~) and `next` (CSS +) scopes", async () => {
    const flow = parseFlow(
      [
        "steps:",
        "  - tap: { role: Switch, next: { text: Wi-Fi } }",
        "  - assert: { visible: { role: Button, after: { text: Danger zone } } }",
      ].join("\n") + "\n"
    );
    expect(flow.steps).toEqual([
      { kind: "tap", selector: { role: "Switch", next: { text: "Wi-Fi" } } },
      {
        kind: "assert",
        condition: "visible",
        selector: { role: "Button", after: { text: "Danger zone" } },
      },
    ]);
  });

  it("parses `any: true` paired with a scope and round-trips exactly", async () => {
    const yaml =
      [
        "steps:",
        "  - tap: { any: true, next: { text: Airplane }, within: { id: row } }",
        "  - assert: { hidden: { any: true, within: { id: empty-state } } }",
      ].join("\n") + "\n";
    const flow = parseFlow(yaml);
    expect(flow.steps).toEqual([
      {
        kind: "tap",
        selector: { any: true, within: { identifier: "row" }, next: { text: "Airplane" } },
      },
      {
        kind: "assert",
        condition: "hidden",
        selector: { any: true, within: { identifier: "empty-state" } },
      },
    ]);
    expect(parseFlow(serializeFlow(flow))).toEqual(flow);
  });

  it("a bare-string sibling scope stays loose, and serializes back to the bare spelling", async () => {
    const flow = parseFlow("steps:\n  - tap: { role: Switch, next: wifi-row }\n");
    expect(flow.steps).toEqual([
      { kind: "tap", selector: { role: "Switch", next: { text: "wifi-row", loose: true } } },
    ]);
    expect(serializeFlow(flow)).toContain("next: wifi-row");
    expect(parseFlow(serializeFlow(flow))).toEqual(flow);
  });

  it("scopes combine and nest, round-tripping through YAML", async () => {
    const flow = parseFlow(
      [
        "steps:",
        "  - tap:",
        "      role: Button",
        "      within: { id: cards }",
        "      after: { text: Danger, within: { id: cards } }",
      ].join("\n") + "\n"
    );
    expect(flow.steps).toEqual([
      {
        kind: "tap",
        selector: {
          role: "Button",
          within: { identifier: "cards" },
          after: { text: "Danger", within: { identifier: "cards" } },
        },
      },
    ]);
    expect(parseFlow(serializeFlow(flow))).toEqual(flow);
  });

  it("accepts the regex text matcher inside a sibling scope", async () => {
    const flow = parseFlow(
      "steps:\n  - tap: { role: Switch, next: { text: { matches: '^Row \\d+$' } } }\n"
    );
    expect(flow.steps).toEqual([
      { kind: "tap", selector: { role: "Switch", next: { textMatches: "^Row \\d+$" } } },
    ]);
  });

  it("rejects a selector that is ONLY a sibling scope", async () => {
    expect(() => parseFlow("steps:\n  - tap: { after: { text: Danger } }\n")).toThrow(
      /`after` only scopes where to look — the selector still needs its own text\/id\/role/
    );
  });

  it("rejects `any: true` alongside the fields it would make redundant", async () => {
    expect(() =>
      parseFlow("steps:\n  - tap: { any: true, role: Button, next: { text: Wi-Fi } }\n")
    ).toThrow(/already matches every element — drop it, or drop the `role`/);
  });

  it("rejects a bare `any: true` with no scope to narrow it", async () => {
    expect(() => parseFlow("steps:\n  - tap: { any: true }\n")).toThrow(
      /matches every element on screen — pair it with a scope \(within\/after\/next\)/
    );
  });

  it("rejects a non-`true` any value rather than reading it as a locator", async () => {
    // Falsy AND truthy: a truthiness check would wave `any: 1` / `any: yes`
    // through as the universal selector — a spelling no reader can predict and
    // the serializer cannot reproduce.
    for (const value of ["false", "1", "yes", "'true'", "0"]) {
      expect(() => parseFlow(`steps:\n  - tap: { any: ${value}, within: { id: card } }\n`)).toThrow(
        /`any` takes only `true`/
      );
    }
  });

  it("rejects unknown keys inside a sibling scope, naming the nested slot", async () => {
    expect(() => parseFlow("steps:\n  - tap: { role: Switch, next: { roel: Button } }\n")).toThrow(
      /tap\.next: selector has unknown key `roel` \(did you mean `role`\?\)/
    );
  });

  it("rejects a cyclic sibling alias via the scope budget", async () => {
    expect(() => parseFlow("steps:\n  - tap: &s { text: Delete, after: *s }\n")).toThrow(
      /more than \d+ scopes|cyclic YAML alias/
    );
  });

  it("bounds a selector's whole scope TREE, not just its depth", async () => {
    // Three relations per level means a depth cap alone still admits 3^depth
    // scopes — and the runner expands one alternative per combination of
    // bare-string scopes, so a few hundred bytes of YAML would exhaust the heap
    // before any tree is ever read. Six scopes down one branch is fine; the
    // same six spread across branches must cost the same budget.
    const chain = (n: number): string =>
      Array.from({ length: n }, () => "{ id: c, within: ").join("") +
      "{ id: leaf }" +
      Array.from({ length: n }, () => " }").join("");
    expect(() => parseFlow(`steps:\n  - tap: { text: T, within: ${chain(5)} }\n`)).not.toThrow();
    expect(() => parseFlow(`steps:\n  - tap: { text: T, within: ${chain(6)} }\n`)).toThrow(
      /more than 6 scopes/
    );
    // The branching form the depth cap alone would have let through: 3 + 9 = 12
    // scopes across two levels, all shallow.
    const branch = "{ id: b, within: x, after: y, next: z }";
    expect(() =>
      parseFlow(
        `steps:\n  - tap: { text: T, within: ${branch}, after: ${branch}, next: ${branch} }\n`
      )
    ).toThrow(/more than 6 scopes/);
  });

  it("serializeFlow refuses an `any` selector the parser would reject on read-back", async () => {
    // appendStep re-parses the whole file on every recorded step, so a selector
    // that violates the parser's `any` rules must fail where it was built, not
    // on some later append.
    const step = (selector: Record<string, unknown>): Parameters<typeof serializeFlow>[0] => ({
      executionPrerequisite: "",
      steps: [{ kind: "tap", selector } as never],
    });
    expect(() => serializeFlow(step({ any: true }))).toThrow(/needs a scope/);
    expect(() =>
      serializeFlow(step({ any: true, text: "Save", within: { identifier: "c" } }))
    ).toThrow(/cannot be combined with text\/id\/role/);
    expect(() => serializeFlow(step({ any: false, within: { identifier: "c" } }))).toThrow(
      /takes only `true`/
    );
    expect(() => serializeFlow(step({ within: { identifier: "c" } }))).toThrow(
      /only narrows where to look/
    );
    // The legal shape still round-trips.
    const yaml = serializeFlow(step({ any: true, within: { identifier: "c" } }));
    expect(parseFlow(yaml).steps).toEqual([
      { kind: "tap", selector: { any: true, within: { identifier: "c" } } },
    ]);
  });

  it("rejects a sibling-scoped selector mixed with coordinates or tap options", async () => {
    expect(() => parseFlow("steps:\n  - tap: { after: { id: card }, x: 0.5, y: 0.5 }\n")).toThrow(
      /takes a selector or x\/y coordinates, not both/
    );
    expect(() =>
      parseFlow("steps:\n  - tap: { on: Photo, times: 2, next: { id: card } }\n")
    ).toThrow(/the tap options form takes a nested selector/);
  });

  it("a loose bare-string selector cannot carry a scope through serialization", async () => {
    expect(() =>
      serializeFlow({
        executionPrerequisite: "",
        steps: [
          { kind: "tap", selector: { text: "Delete", loose: true, after: { identifier: "hdr" } } },
        ],
      })
    ).toThrow(/incompatible fields: after/);
  });

  it("names the missing scroll-to target instead of leaking a schema message", async () => {
    // `within` is a selector key now, so this body reads like a scoped selector
    // — it is actually the options map, missing its target.
    for (const body of ["{ within: { id: list } }", "{ direction: up }", "{}"]) {
      expect(() => parseFlow(`steps:\n  - scroll-to: ${body}\n`)).toThrow(
        /scroll-to needs a `target`/
      );
    }
    // The sibling scopes are not step options at all.
    expect(() => parseFlow("steps:\n  - scroll-to: { target: Row, after: { id: hdr } }\n")).toThrow(
      /unknown key `after` — allowed keys: target, direction, within/
    );
    // ...while they are welcome inside the target.
    expect(() =>
      parseFlow(
        "steps:\n  - scroll-to: { target: { text: Delete, after: { id: hdr } }, within: { id: list } }\n"
      )
    ).not.toThrow();
  });

  it("describeSelector renders each scope, and `*` for the universal selector", async () => {
    expect(describeSelector({ role: "Switch", next: { text: "Wi-Fi" } })).toBe(
      'role="Switch" next (text="Wi-Fi")'
    );
    expect(
      describeSelector({ any: true, within: { identifier: "row" }, after: { text: "Name" } })
    ).toBe('* within (id="row") after (text="Name")');
  });

  it("when guards reject a {{secret:…}} placeholder hidden in ANY scope", async () => {
    // Every relation, so no branch of the walk can be skipped unnoticed.
    for (const scope of ["within", "after", "next"]) {
      expect(() =>
        parseFlow(
          [
            "steps:",
            `  - when: { visible: { role: Switch, ${scope}: { text: '{{secret:TOKEN}}' } } }`,
            "    steps:",
            "      - echo: hi",
          ].join("\n") + "\n"
        )
      ).toThrow(/secret/);
    }
    // ...including one buried two relations deep.
    expect(() =>
      parseFlow(
        [
          "steps:",
          "  - when: { visible: { role: Switch, after: { id: row, within: { text: '{{secret:TOKEN}}' } } } }",
          "    steps:",
          "      - echo: hi",
        ].join("\n") + "\n"
      )
    ).toThrow(/secret/);
  });
});

// ── countStepsOnDisk ─────────────────────────────────────────────────

// The count `flow-start-recording` reports for a take it is about to truncate.
// Its contract is the distinction between "0 steps" and "no answer": an empty
// take really did hold nothing, while an unreadable one is a loss of unknown
// size, and reporting the first for the second understates it in exactly the
// case that produced it.
describe("countStepsOnDisk", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "count-steps-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const write = async (content: string) => {
    const file = path.join(dir, "flow.yaml");
    await fs.writeFile(file, content, "utf8");
    return file;
  };

  it("counts the steps a readable flow file holds", async () => {
    const file = await write(
      serializeFlow({
        executionPrerequisite: "",
        steps: [
          { kind: "echo", message: "one" },
          { kind: "echo", message: "two" },
          { kind: "echo", message: "three" },
        ],
      })
    );
    expect(await countStepsOnDisk(file)).toBe(3);
  });

  it("counts an empty take as 0, which is a real answer", async () => {
    const file = await write(serializeFlow({ executionPrerequisite: "", steps: [] }));
    expect(await countStepsOnDisk(file)).toBe(0);
  });

  it("returns undefined for a file that does not exist", async () => {
    expect(await countStepsOnDisk(path.join(dir, "absent.yaml"))).toBeUndefined();
  });

  it("returns undefined rather than 0 for YAML the parser rejects", async () => {
    // A hand-edit can leave this behind, and `parseFlow("")` returning an empty
    // flow with no error is the reason 0 cannot double as "unknown".
    const file = await write("steps: [ this: is: not: a: flow\n");
    expect(await countStepsOnDisk(file)).toBeUndefined();
  });

  it("returns undefined for a directory in the file's place", async () => {
    const asDir = path.join(dir, "flow-dir.yaml");
    await fs.mkdir(asDir);
    expect(await countStepsOnDisk(asDir)).toBeUndefined();
  });
});

describe("writeFlowFile failure hints", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "flow-write-hint-"));
  });

  afterEach(async () => {
    // Restore write permission first, or the recursive rm cannot descend.
    for (const dir of [path.join(root, "vault"), path.join(root, ".argent", "flows")]) {
      await fs.chmod(dir, 0o755).catch(() => {});
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  /** Whether this process can be denied by mode bits at all (root cannot). */
  async function modeBitsBite(dir: string): Promise<boolean> {
    await fs.chmod(dir, 0o555);
    const probe = path.join(dir, ".probe");
    const denied = await fs
      .writeFile(probe, "x", "utf8")
      .then(() => false)
      .catch(() => true);
    if (!denied) await fs.rm(probe, { force: true });
    return denied;
  }

  it("does not call the flow file a symlink when only an ANCESTOR is one", async () => {
    // On macOS the temp dir is reached through /var -> /private/var, so the
    // resolved swap directory differs from the spelled one for a flow file that
    // is a perfectly ordinary regular file. Comparing the two spellings made
    // every such failure claim a symlink and then contrast one directory with
    // itself.
    const flowsDir = path.join(root, ".argent", "flows");
    await fs.mkdir(flowsDir, { recursive: true });
    if (!(await modeBitsBite(flowsDir))) return;

    const err = await writeNewFlowFile(path.join(flowsDir, "x.yaml"), "steps: []\n").catch(
      (e: unknown) => e
    );

    const message = (err as Error).message;
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_FILE_WRITE_FAILED);
    expect(message).toContain("must be writable");
    expect(message).not.toMatch(/is a symlink/);
  });

  it("still points at the vault when the flow file really is a symlink", async () => {
    // The case the clause exists for: naming `.argent/flows` here would send the
    // reader to a directory that is already writable while the vault, the only
    // unwritable thing in the picture, went unmentioned.
    const flowsDir = path.join(root, ".argent", "flows");
    const vault = path.join(root, "vault");
    await fs.mkdir(flowsDir, { recursive: true });
    await fs.mkdir(vault, { recursive: true });
    await fs.writeFile(path.join(vault, "shared.yaml"), "steps: []\n", "utf8");
    await fs.symlink(path.join(vault, "shared.yaml"), path.join(flowsDir, "shared.yaml"));
    if (!(await modeBitsBite(vault))) return;

    const err = await writeNewFlowFile(path.join(flowsDir, "shared.yaml"), "steps: []\n").catch(
      (e: unknown) => e
    );

    const message = (err as Error).message;
    expect(message).toContain("shared.yaml is a symlink, so the write lands in");
    expect(message).toContain(await fs.realpath(vault));
  });
});
