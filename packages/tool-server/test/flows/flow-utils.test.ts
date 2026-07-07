import { describe, it, expect, beforeEach } from "vitest";
import * as path from "node:path";
import {
  serializeFlow,
  parseFlow,
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

  it("parses condition-as-key await/assert sugar (visible/exists/hidden)", () => {
    const flow = parseFlow(
      [
        "steps:",
        "  - await: { visible: Account }",
        "  - assert: { exists: { identifier: row } }",
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
      'steps:\n  - assert: { text: { in: { identifier: counter }, contains: "Taps: 0" } }\n'
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
      'steps:\n  - assert: { text: { in: { identifier: counter }, equals: "Taps: 0" } }\n'
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
    ).toThrow(/exactly one of `contains` or `equals`/);
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
      /exactly one of `contains` or `equals`/
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
    expect(yaml).toContain("identifier: counter");
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
      expect(() => parseFlow(`steps:\n  - snapshot: { name: home, maxMismatch: ${bad} }\n`)).toThrow(
        "snapshot maxMismatch must be a number between 0 and 100"
      );
    }
  });

  it("rejects a tap body mixing a selector with coordinates", () => {
    expect(() => parseFlow("steps:\n  - tap: { identifier: box, x: 0.5, y: 0.5 }\n")).toThrow(
      "tap takes a selector or x/y coordinates, not both"
    );
  });

  it("rejects a coordinate tap with a missing or non-numeric x/y", () => {
    expect(() => parseFlow("steps:\n  - tap: { x: 0.5 }\n")).toThrow(
      "a coordinate tap needs numeric x and y"
    );
    expect(() => parseFlow('steps:\n  - tap: { x: "0.5", y: 0.5 }\n')).toThrow(
      "a coordinate tap needs numeric x and y"
    );
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
