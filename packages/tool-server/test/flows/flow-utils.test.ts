import { describe, it, expect, beforeEach } from "vitest";
import * as path from "node:path";
import {
  serializeFlow,
  parseFlow,
  describeSelector,
  setActiveFlow,
  getActiveFlow,
  getActiveFlowOrNull,
  clearActiveFlow,
  setActiveProjectRoot,
  clearActiveProjectRoot,
  getFlowPath,
  appIdForPlatform,
  chromiumLaunchSpec,
  type FlowFile,
} from "../../src/tools/flows/flow-utils";

// ── serializeFlow ────────────────────────────────────────────────────

describe("serializeFlow", () => {
  it("serializes an empty flow with prerequisite", () => {
    const flow: FlowFile = {
      executionPrerequisite: "App on home screen",
      steps: [],
    };
    const result = serializeFlow(flow);
    expect(result).toContain("executionPrerequisite: App on home screen");
    expect(result).toContain("steps: []");
  });

  it("serializes echo steps", () => {
    const flow: FlowFile = {
      executionPrerequisite: "Fresh reload",
      steps: [{ kind: "echo", message: "Hello" }],
    };
    const result = serializeFlow(flow);
    expect(result).toContain("- echo: Hello");
  });

  it("serializes tool steps with args", () => {
    const flow: FlowFile = {
      executionPrerequisite: "",
      steps: [{ kind: "tool", name: "tap", args: { x: 0.5, y: 0.3 } }],
    };
    const result = serializeFlow(flow);
    expect(result).toContain("- tool: tap");
    expect(result).toContain("    x: 0.5");
    expect(result).toContain("    y: 0.3");
  });

  it("serializes tool steps with empty args (omits args key)", () => {
    const flow: FlowFile = {
      executionPrerequisite: "",
      steps: [{ kind: "tool", name: "screenshot", args: {} }],
    };
    const result = serializeFlow(flow);
    expect(result).toContain("- tool: screenshot");
    expect(result).not.toContain("args:");
  });

  it("rejects gesture targets that cannot round-trip through the parser", () => {
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
  it("spells identifier as id, the flow-YAML spelling", () => {
    expect(describeSelector({ identifier: "submit" })).toBe('id="submit"');
  });

  it("renders a text selector", () => {
    expect(describeSelector({ text: "Login" })).toBe('text="Login"');
  });

  it("drops the internal loose flag", () => {
    expect(describeSelector({ text: "Login", loose: true })).toBe('text="Login"');
  });

  it("joins multiple keys with spaces", () => {
    expect(describeSelector({ text: "Login", role: "button" })).toBe('text="Login" role="button"');
  });
});

// ── parseFlow ────────────────────────────────────────────────────────

describe("parseFlow", () => {
  it("parses a flow with executionPrerequisite and echo steps", () => {
    const content = "executionPrerequisite: App on home screen\nsteps:\n  - echo: Hello\n";
    const flow = parseFlow(content);
    expect(flow.executionPrerequisite).toBe("App on home screen");
    expect(flow.steps).toEqual([{ kind: "echo", message: "Hello" }]);
  });

  it("parses tool entries with args", () => {
    const content =
      'executionPrerequisite: ""\nsteps:\n  - tool: tap\n    args:\n      x: 0.5\n      y: 0.3\n';
    const flow = parseFlow(content);
    expect(flow.steps).toEqual([{ kind: "tool", name: "tap", args: { x: 0.5, y: 0.3 } }]);
  });

  it("parses tool entries with no args", () => {
    const content = 'executionPrerequisite: ""\nsteps:\n  - tool: screenshot\n';
    const flow = parseFlow(content);
    expect(flow.steps).toEqual([{ kind: "tool", name: "screenshot", args: {} }]);
  });

  it("parses a multi-step flow", () => {
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

  it("returns empty steps for empty content", () => {
    const flow = parseFlow("");
    expect(flow.executionPrerequisite).toBe("");
    expect(flow.steps).toEqual([]);
  });

  it("defaults executionPrerequisite to empty string when missing", () => {
    const content = "steps:\n  - echo: Hello\n";
    const flow = parseFlow(content);
    expect(flow.executionPrerequisite).toBe("");
    expect(flow.steps).toEqual([{ kind: "echo", message: "Hello" }]);
  });

  it("throws on unrecognized entries", () => {
    const content = 'executionPrerequisite: ""\nsteps:\n  - bogus: line\n';
    expect(() => parseFlow(content)).toThrow("Unrecognized flow entry");
  });

  it("throws when content is not an object with steps", () => {
    expect(() => parseFlow("- echo: Hello\n")).toThrow("expected an object with a steps array");
  });

  it("throws a validation error (not a TypeError) on a primitive step entry", () => {
    const content = 'executionPrerequisite: ""\nsteps:\n  - tap\n';
    expect(() => parseFlow(content)).toThrow("Unrecognized flow entry");
  });

  it("throws a validation error on a null step entry", () => {
    const content = 'executionPrerequisite: ""\nsteps:\n  - ~\n';
    expect(() => parseFlow(content)).toThrow("Unrecognized flow entry");
  });

  it("sugars a bare-string selector into a loose { text } for tap", () => {
    const flow = parseFlow("steps:\n  - tap: Settings\n");
    // Bare string ⇒ loose: resolves identifier-first, then falls back to text.
    expect(flow.steps).toEqual([{ kind: "tap", selector: { text: "Settings", loose: true } }]);
  });

  it("sugars a bare-string selector for type.into", () => {
    const flow = parseFlow('steps:\n  - type: { into: email, text: "a@b.com" }\n');
    expect(flow.steps).toEqual([
      { kind: "type", into: { text: "email", loose: true }, text: "a@b.com" },
    ]);
  });

  it("defaults type.submit to on (no submit key in the parsed model)", () => {
    const flow = parseFlow('steps:\n  - type: { into: email, text: "a@b.com" }\n');
    expect(flow.steps[0]).not.toHaveProperty("submit");
  });

  it("parses and round-trips an explicit type.submit: false opt-out", () => {
    const flow = parseFlow('steps:\n  - type: { into: email, text: "a@b.com", submit: false }\n');
    expect(flow.steps).toEqual([
      { kind: "type", into: { text: "email", loose: true }, text: "a@b.com", submit: false },
    ]);
    expect(serializeFlow(flow)).toContain("submit: false");
    expect(parseFlow(serializeFlow(flow)).steps).toEqual(flow.steps);
  });

  it("rejects a non-boolean type.submit", () => {
    expect(() => parseFlow('steps:\n  - type: { into: email, text: "x", submit: 3 }\n')).toThrow();
  });

  it("keeps an explicit { text } map strict (no loose fallback)", () => {
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

  it("accepts a regex selector combined with id and role", () => {
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

  it("parses the map form's `id` as the internal identifier field (strict)", () => {
    const flow = parseFlow("steps:\n  - tap: { id: submit-btn }\n");
    expect(flow.steps).toEqual([{ kind: "tap", selector: { identifier: "submit-btn" } }]);
  });

  it("accepts `identifier` as a parse-only alias for `id`", () => {
    const flow = parseFlow("steps:\n  - tap: { identifier: submit-btn }\n");
    expect(flow.steps).toEqual([{ kind: "tap", selector: { identifier: "submit-btn" } }]);
  });

  it("rejects a selector map carrying both `id` and `identifier`", () => {
    expect(() => parseFlow("steps:\n  - tap: { id: a, identifier: b }\n")).toThrow(
      /`id` or `identifier`.*not both/
    );
  });

  it("re-serializes an identifier-spelled flow with the `id` spelling", () => {
    // Old files parse via the alias; the next write (appendStep re-serializes
    // the whole file) migrates them to the canonical `id` spelling.
    const yaml = serializeFlow(parseFlow("steps:\n  - tap: { identifier: submit-btn }\n"));
    expect(yaml).toContain("id: submit-btn");
    expect(yaml).not.toContain("identifier:");
  });

  it("parses condition-as-key await/assert sugar (visible/exists/hidden)", () => {
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

  it("parses the text sugar { in, contains } as a substring match", () => {
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

  it("parses the text sugar { in, equals } as an exact match", () => {
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

  it("rejects text sugar with both contains and equals", () => {
    expect(() =>
      parseFlow("steps:\n  - assert: { text: { in: counter, contains: a, equals: b } }\n")
    ).toThrow(/exactly one of `contains`, `equals`, or `matches`/);
  });

  it("rejects the explicit { condition, selector, expectedText } form (sugar only)", () => {
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

  it("rejects an await/assert body with no condition key", () => {
    expect(() => parseFlow("steps:\n  - assert: { selector: foo }\n")).toThrow(
      /exactly one condition key/
    );
  });

  it("rejects text sugar with neither contains nor equals", () => {
    expect(() => parseFlow("steps:\n  - assert: { text: { in: counter } }\n")).toThrow(
      /exactly one of `contains`, `equals`, or `matches`/
    );
  });

  it("rejects text sugar with an empty contains", () => {
    expect(() =>
      parseFlow('steps:\n  - assert: { text: { in: counter, contains: "" } }\n')
    ).toThrow(/non-empty `contains`/);
  });

  it("serializes await/assert with the condition-as-key sugar (no condition: field)", () => {
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

  it("roundtrips the sugared step kinds through YAML", () => {
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

  it("keeps a strict { text } selector strict across repeated round-trips (never collapsed to a bare loose string)", () => {
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

  it("sugars a bare-string scroll-to target and keeps the within map", () => {
    const flow = parseFlow(
      ["steps:", "  - scroll-to: { target: Account, direction: down }"].join("\n")
    );
    expect(flow.steps).toEqual([
      { kind: "scroll-to", target: { text: "Account", loose: true }, direction: "down" },
    ]);
  });

  it("parses a bare-number wait as milliseconds", () => {
    const flow = parseFlow("steps:\n  - wait: 750\n");
    expect(flow.steps).toEqual([{ kind: "wait", ms: 750 }]);
  });

  it("rejects a wait that is not a non-negative number", () => {
    expect(() => parseFlow("steps:\n  - wait: soon\n")).toThrow("wait needs a non-negative number");
    expect(() => parseFlow("steps:\n  - wait: -5\n")).toThrow("wait needs a non-negative number");
  });

  it("parses an await timeout in milliseconds", () => {
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

  it("rejects an await timeout that is not a positive finite number", () => {
    // `.inf`, `.nan`, and an overflowing literal all parse to a typeof-number
    // value; letting Infinity through would make the runner's poll deadline
    // unreachable (an unbounded await).
    for (const bad of ["soon", "0", "-5", ".inf", ".nan", "1e400"]) {
      expect(() => parseFlow(`steps:\n  - await: { visible: Account, timeout: ${bad} }\n`)).toThrow(
        "await.timeout needs a positive number of milliseconds"
      );
    }
  });

  it("rejects a timeout on an assert step (an assert is an immediate check)", () => {
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

  it("rejects a scroll-to with an invalid direction", () => {
    expect(() =>
      parseFlow("steps:\n  - scroll-to: { target: Account, direction: sideways }\n")
    ).toThrow("scroll-to direction must be one of");
  });

  it("defaults scroll-to direction to down", () => {
    const flow = parseFlow("steps:\n  - scroll-to: { target: Account }\n");
    expect(flow.steps).toEqual([
      { kind: "scroll-to", target: { text: "Account", loose: true }, direction: "down" },
    ]);
  });

  it("parses a bare-string scroll-to as a down-scroll to that target", () => {
    const flow = parseFlow("steps:\n  - scroll-to: Account\n");
    expect(flow.steps).toEqual([
      { kind: "scroll-to", target: { text: "Account", loose: true }, direction: "down" },
    ]);
  });

  it("serializes the default scroll-to back to the bare-string sugar", () => {
    const steps = [
      { kind: "scroll-to", target: { text: "Account", loose: true }, direction: "down" },
    ] as FlowFile["steps"];
    const yaml = serializeFlow({ executionPrerequisite: "", steps });
    expect(yaml).toContain("- scroll-to: Account");
    expect(parseFlow(yaml).steps).toEqual(steps);
  });

  it("parses a bare-string snapshot as its name", () => {
    const flow = parseFlow("steps:\n  - snapshot: home\n");
    expect(flow.steps).toEqual([{ kind: "snapshot", name: "home" }]);
  });

  it("serializes a name-only snapshot as a bare string, keeps the map with maxMismatch", () => {
    const steps = [
      { kind: "snapshot", name: "home" },
      { kind: "snapshot", name: "cart", maxMismatch: 1.5 },
    ] as FlowFile["steps"];
    const yaml = serializeFlow({ executionPrerequisite: "", steps });
    expect(yaml).toContain("- snapshot: home");
    expect(yaml).toContain("maxMismatch: 1.5");
    expect(parseFlow(yaml).steps).toEqual(steps);
  });

  it("rejects a snapshot name that is not path-safe", () => {
    expect(() => parseFlow("steps:\n  - snapshot: ../evil\n")).toThrow(/must match/);
  });

  it("accepts a string-number maxMismatch", () => {
    const flow = parseFlow('steps:\n  - snapshot: { name: home, maxMismatch: "1.5" }\n');
    expect(flow.steps).toEqual([{ kind: "snapshot", name: "home", maxMismatch: 1.5 }]);
  });

  it("rejects a non-numeric, negative, or out-of-range maxMismatch", () => {
    for (const bad of ['"5%"', "-1", "101", ".nan"]) {
      expect(() =>
        parseFlow(`steps:\n  - snapshot: { name: home, maxMismatch: ${bad} }\n`)
      ).toThrow("snapshot maxMismatch must be a number between 0 and 100");
    }
  });

  it("parses snapshot cropOn as a selector (bare-string loose, map strict)", () => {
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

  it("serializes snapshot cropOn in the map form and round-trips", () => {
    const steps = [
      { kind: "snapshot", name: "home", cropOn: { text: "Header", loose: true } },
      { kind: "snapshot", name: "cart", maxMismatch: 1.5, cropOn: { identifier: "cart-total" } },
    ] as FlowFile["steps"];
    const yaml = serializeFlow({ executionPrerequisite: "", steps });
    expect(yaml).toContain("cropOn: Header");
    expect(parseFlow(yaml).steps).toEqual(steps);
  });

  it("rejects a point-form cropOn — a point has no extent to crop to", () => {
    expect(() =>
      parseFlow("steps:\n  - snapshot: { name: home, cropOn: { x: 0.5, y: 0.5 } }\n")
    ).toThrow(/snapshot\.cropOn: selector has unknown keys `x`, `y`/);
  });

  it("rejects a tap body mixing a selector with coordinates", () => {
    for (const key of ["id", "identifier"]) {
      expect(() => parseFlow(`steps:\n  - tap: { ${key}: box, x: 0.5, y: 0.5 }\n`)).toThrow(
        "tap takes a selector or x/y coordinates, not both"
      );
    }
  });

  it("rejects a coordinate tap with a missing or non-numeric x/y", () => {
    expect(() => parseFlow("steps:\n  - tap: { x: 0.5 }\n")).toThrow(
      "tap: a coordinate target needs numeric x and y"
    );
    expect(() => parseFlow('steps:\n  - tap: { x: "0.5", y: 0.5 }\n')).toThrow(
      "tap: a coordinate target needs numeric x and y"
    );
  });

  it("round-trips free-text values exactly, including whitespace-only lines", () => {
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

  it("never serializes a whitespace-only-line value as a block scalar", () => {
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
    it("rejects a misspelled scroll-to direction key with a suggestion", () => {
      expect(() =>
        parseFlow("steps:\n  - scroll-to: { target: Order-1234, directon: up }\n")
      ).toThrow(/scroll-to has unknown key `directon` \(did you mean `direction`\?\)/);
    });

    it("rejects a misspelled type.submit key with a suggestion", () => {
      expect(() =>
        parseFlow('steps:\n  - type: { into: email, text: "a@b.com", sumbit: false }\n')
      ).toThrow(/type has unknown key `sumbit` \(did you mean `submit`\?\)/);
    });

    it("rejects a misspelled await.timeout key with a suggestion", () => {
      expect(() => parseFlow("steps:\n  - await: { visible: Account, timeut: 10000 }\n")).toThrow(
        /await has unknown key `timeut` \(did you mean `timeout`\?\)/
      );
    });

    it("rejects a misspelled snapshot.maxMismatch key with a suggestion", () => {
      expect(() => parseFlow("steps:\n  - snapshot: { name: home, maxMissmatch: 1.5 }\n")).toThrow(
        /snapshot has unknown key `maxMissmatch` \(did you mean `maxMismatch`\?\)/
      );
    });

    it("rejects a miscased snapshot.cropOn key with a suggestion", () => {
      expect(() => parseFlow("steps:\n  - snapshot: { name: home, cropon: Header }\n")).toThrow(
        /snapshot has unknown key `cropon` \(did you mean `cropOn`\?\)/
      );
    });

    it("rejects an unknown key on a selector map", () => {
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

    it("rejects an unknown key without a suggestion when nothing is close", () => {
      expect(() => parseFlow("steps:\n  - scroll-to: { target: Row, sideways: true }\n")).toThrow(
        /scroll-to has unknown key `sideways` — allowed keys: target, direction, within/
      );
    });

    it("rejects an unknown key in an await/assert text body", () => {
      expect(() =>
        parseFlow('steps:\n  - assert: { text: { in: counter, contians: "Taps: 0" } }\n')
      ).toThrow(/assert.text has unknown key `contians` \(did you mean `contains`\?\)/);
    });

    it("rejects a stray key on a coordinate tap", () => {
      expect(() => parseFlow("steps:\n  - tap: { x: 0.5, y: 0.5, why: 0.6 }\n")).toThrow(
        /tap: a coordinate target takes only \{ x, y \}/
      );
    });

    it("rejects an unknown key in a launch map and its chromium value", () => {
      expect(() => parseFlow("steps:\n  - launch: { amdroid: com.acme.app }\n")).toThrow(
        /launch has unknown key `amdroid` \(did you mean `android`\?\)/
      );
      expect(() =>
        parseFlow("steps:\n  - launch: { chromium: { path: ./app, arg: [--e2e] } }\n")
      ).toThrow(/launch.chromium has unknown key `arg` \(did you mean `args`\?\)/);
    });

    it("rejects a step-level sibling key (options belong inside the directive value)", () => {
      expect(() =>
        parseFlow("steps:\n  - await: { visible: Account }\n    timeout: 5000\n")
      ).toThrow(
        /a `await` step has unknown key `timeout` — step options go inside the `await:` value/
      );
    });

    it("rejects a step carrying two directive keys", () => {
      expect(() => parseFlow("steps:\n  - echo: hi\n    tap: Save\n")).toThrow(
        /a step takes exactly one directive key, found `echo`, `tap`/
      );
    });

    it("suggests the directive key for a misspelled step kind", () => {
      expect(() => parseFlow("steps:\n  - snapshoot: home\n")).toThrow(
        /unrecognized step kind \(did you mean `snapshot`\?\)/
      );
    });

    it("rejects an unknown top-level flow file key", () => {
      expect(() =>
        parseFlow("executionPrerequisit: Settings open\nsteps:\n  - echo: hi\n")
      ).toThrow(/unknown key `executionPrerequisit` \(did you mean `executionPrerequisite`\?\)/);
    });
  });

  it("roundtrips: serialize then parse", () => {
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
  it("parses a chromium launch with a bare-string app path", () => {
    const flow = parseFlow("steps:\n  - launch: { chromium: ./app }\n");
    expect(flow.steps).toEqual([{ kind: "launch", app: { chromium: "./app" } }]);
  });

  it("parses a chromium launch with a { path, args } map", () => {
    const flow = parseFlow("steps:\n  - launch: { chromium: { path: ./app, args: [--e2e] } }\n");
    expect(flow.steps).toEqual([
      { kind: "launch", app: { chromium: { path: "./app", args: ["--e2e"] } } },
    ]);
  });

  it("parses a mixed per-platform launch (ios id + chromium path)", () => {
    const flow = parseFlow("steps:\n  - launch: { ios: com.acme.app, chromium: ./app }\n");
    expect(flow.steps).toEqual([
      { kind: "launch", app: { ios: "com.acme.app", chromium: "./app" } },
    ]);
  });

  it("round-trips a chromium { path, args } launch through YAML", () => {
    const flow: FlowFile = {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: { chromium: { path: "/abs/app", args: ["--foo", "--bar"] } } },
      ],
    };
    expect(parseFlow(serializeFlow(flow)).steps).toEqual(flow.steps);
  });

  it("rejects a chromium map with no path", () => {
    expect(() => parseFlow("steps:\n  - launch: { chromium: { args: [--e2e] } }\n")).toThrow(
      /launch needs/
    );
  });

  it("rejects a chromium map with non-string args", () => {
    expect(() =>
      parseFlow("steps:\n  - launch: { chromium: { path: ./app, args: [1, 2] } }\n")
    ).toThrow(/launch needs/);
  });
});

describe("chromiumLaunchSpec", () => {
  it("reads a bare-string launch as the app path", () => {
    expect(chromiumLaunchSpec("./app")).toEqual({ path: "./app" });
  });

  it("reads a chromium string value as the path", () => {
    expect(chromiumLaunchSpec({ chromium: "./app" })).toEqual({ path: "./app" });
  });

  it("reads a chromium { path, args } value", () => {
    expect(chromiumLaunchSpec({ chromium: { path: "./app", args: ["--e2e"] } })).toEqual({
      path: "./app",
      args: ["--e2e"],
    });
  });

  it("returns null when no chromium target is declared", () => {
    expect(chromiumLaunchSpec({ ios: "com.acme.app" })).toBeNull();
    expect(chromiumLaunchSpec(undefined)).toBeNull();
  });

  it("appIdForPlatform returns the chromium path (the runner's declared-target guard)", () => {
    expect(appIdForPlatform({ chromium: { path: "./app", args: ["--e2e"] } }, "chromium")).toBe(
      "./app"
    );
    expect(appIdForPlatform({ chromium: "./app" }, "chromium")).toBe("./app");
    expect(appIdForPlatform({ ios: "com.acme.app" }, "chromium")).toBeNull();
  });
});

// ── native shorthand ─────────────────────────────────────────────────

describe("native launch shorthand", () => {
  it("parses a native-only launch and round-trips it", () => {
    const flow = parseFlow("steps:\n  - launch: { native: com.acme.app }\n");
    expect(flow.steps).toEqual([{ kind: "launch", app: { native: "com.acme.app" } }]);
    expect(parseFlow(serializeFlow(flow)).steps).toEqual(flow.steps);
  });

  it("parses native alongside a per-platform override and a chromium path", () => {
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

  it("rejects an empty native id", () => {
    expect(() => parseFlow('steps:\n  - launch: { native: "" }\n')).toThrow(/launch needs/);
  });

  it("appIdForPlatform falls back to native for installed platforms, override wins", () => {
    const app = { native: "com.acme.app", android: "com.acme.app.debug" };
    // native fills in for platforms without a specific key…
    expect(appIdForPlatform(app, "ios")).toBe("com.acme.app");
    expect(appIdForPlatform(app, "vega")).toBe("com.acme.app");
    // …and a specific key overrides it.
    expect(appIdForPlatform(app, "android")).toBe("com.acme.app.debug");
  });

  it("native never applies to chromium (chromium takes a path, not an id)", () => {
    expect(appIdForPlatform({ native: "com.acme.app" }, "chromium")).toBeNull();
    expect(chromiumLaunchSpec({ native: "com.acme.app" })).toBeNull();
  });
});

// ── Active flow state ────────────────────────────────────────────────

describe("active flow state", () => {
  beforeEach(() => {
    clearActiveFlow();
  });

  it("throws when no active flow", () => {
    expect(() => getActiveFlow()).toThrow("No active flow");
  });

  it("returns the active flow after setActiveFlow", () => {
    setActiveFlow("my-flow");
    expect(getActiveFlow()).toBe("my-flow");
  });

  it("clears the active flow", () => {
    setActiveFlow("my-flow");
    clearActiveFlow();
    expect(() => getActiveFlow()).toThrow("No active flow");
  });

  it("overwrites previous active flow", () => {
    setActiveFlow("first");
    setActiveFlow("second");
    expect(getActiveFlow()).toBe("second");
  });

  it("getActiveFlowOrNull returns null when no active flow", () => {
    expect(getActiveFlowOrNull()).toBeNull();
  });

  it("getActiveFlowOrNull returns the active flow name", () => {
    setActiveFlow("my-flow");
    expect(getActiveFlowOrNull()).toBe("my-flow");
  });

  it("getActiveFlowOrNull returns null after clearing", () => {
    setActiveFlow("my-flow");
    clearActiveFlow();
    expect(getActiveFlowOrNull()).toBeNull();
  });
});

// ── getFlowPath name validation ──────────────────────────────────────

describe("getFlowPath name validation", () => {
  beforeEach(() => {
    clearActiveProjectRoot();
    setActiveProjectRoot("/tmp/argent-flow-name-test");
  });

  it("accepts plain alphanumeric names", () => {
    expect(getFlowPath("my-flow_1")).toBe(
      path.join("/tmp/argent-flow-name-test", ".argent", "flows", "my-flow_1.yaml")
    );
  });

  it("rejects path-traversal segments", () => {
    expect(() => getFlowPath("../../etc/passwd")).toThrow(/Invalid flow name/);
    expect(() => getFlowPath("../foo")).toThrow(/Invalid flow name/);
  });

  it("rejects path separators", () => {
    expect(() => getFlowPath("foo/bar")).toThrow(/Invalid flow name/);
    expect(() => getFlowPath("/abs/path")).toThrow(/Invalid flow name/);
  });

  it("rejects names with spaces or shell metacharacters", () => {
    expect(() => getFlowPath("foo bar")).toThrow(/Invalid flow name/);
    expect(() => getFlowPath("foo;bar")).toThrow(/Invalid flow name/);
    expect(() => getFlowPath("foo$(id)")).toThrow(/Invalid flow name/);
  });

  it("rejects empty names", () => {
    expect(() => getFlowPath("")).toThrow(/Invalid flow name/);
  });
});

// PR #194 follow-up C: project_root must be absolute AND free of ".."
// segments (path.join collapses ".." and would relocate the flows dir).
describe("setActiveProjectRoot validation", () => {
  it("rejects a relative project_root", () => {
    expect(() => setActiveProjectRoot("relative/path")).toThrow(/absolute path/);
  });

  it('rejects an absolute project_root containing ".." segments', () => {
    expect(() => setActiveProjectRoot("/a/../../../etc")).toThrow(/must not contain "\.\."/);
    expect(() => setActiveProjectRoot("/home/user/../../root")).toThrow(/must not contain "\.\."/);
  });

  it("accepts a clean absolute project_root", () => {
    expect(() => setActiveProjectRoot("/tmp/argent-pr194-c-test")).not.toThrow();
  });
});
