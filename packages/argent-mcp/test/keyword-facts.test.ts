import { describe, it, expect } from "vitest";
import { showsSchemaKeywords, withKeywordFacts } from "../src/keyword-facts.js";

const describeProp = (prop: Record<string, unknown>): unknown => {
  const result = withKeywordFacts({ properties: { p: prop } }) as {
    properties: { p: { description?: unknown } };
  };
  return result.properties.p.description;
};

describe("withKeywordFacts — copies keyword-only facts into descriptions", () => {
  it("states a default", () => {
    expect(describeProp({ type: "integer", default: 20, description: "Rows to return." })).toBe(
      "Rows to return. Default: 20."
    );
    expect(describeProp({ type: "string", default: "latest", description: "Page." })).toBe(
      'Page. Default: "latest".'
    );
  });

  it("states inclusive bounds as a range, or the one bound that is set", () => {
    expect(describeProp({ type: "number", minimum: 0, maximum: 1, description: "X." })).toBe(
      "X. Range: 0 to 1."
    );
    expect(describeProp({ type: "integer", minimum: 1, description: "Count." })).toBe(
      "Count. Minimum: 1."
    );
    expect(describeProp({ type: "integer", maximum: 600, description: "Seconds." })).toBe(
      "Seconds. Maximum: 600."
    );
  });

  it("states exclusive bounds", () => {
    expect(describeProp({ type: "integer", exclusiveMinimum: 0, description: "N." })).toBe(
      "N. Must be greater than 0."
    );
    expect(describeProp({ type: "number", exclusiveMaximum: 1, description: "Ratio." })).toBe(
      "Ratio. Must be less than 1."
    );
  });

  it("states length and item limits above the trivial 1", () => {
    expect(describeProp({ type: "string", minLength: 3, maxLength: 64, description: "Id." })).toBe(
      "Id. Min length: 3. Max length: 64."
    );
    expect(describeProp({ type: "array", minItems: 2, maxItems: 8, description: "Steps." })).toBe(
      "Steps. Min items: 2. Max items: 8."
    );
  });

  it("reads bounds and const values from union branches", () => {
    expect(
      describeProp({
        description: "Page index.",
        anyOf: [
          { type: "integer", minimum: 0 },
          { type: "string", const: "last" },
        ],
      })
    ).toBe('Page index. Minimum: 0. Also accepts "last".');
    expect(
      describeProp({
        description: "A button, or a path of them.",
        anyOf: [{ type: "string" }, { type: "array", minItems: 1, maxItems: 64 }],
      })
    ).toBe("A button, or a path of them. Max items: 64.");
  });

  it("ends the description with a period before the facts", () => {
    expect(describeProp({ type: "number", maximum: 5, description: "Speed (fast)" })).toBe(
      "Speed (fast). Maximum: 5."
    );
  });

  it("writes the facts as the description when there is none", () => {
    expect(describeProp({ type: "number", minimum: 0, maximum: 1 })).toBe("Range: 0 to 1.");
  });

  it("keeps every keyword in the schema", () => {
    const prop = { type: "integer", default: 3, minimum: 1, maximum: 9, description: "N." };
    const result = withKeywordFacts({ properties: { p: prop } }) as {
      properties: { p: Record<string, unknown> };
    };
    expect(result.properties.p).toEqual({ ...prop, description: "N. Default: 3. Range: 1 to 9." });
  });

  it("recurses into nested object properties and array items", () => {
    const result = withKeywordFacts({
      properties: {
        events: {
          type: "array",
          items: {
            type: "object",
            properties: { x: { type: "number", minimum: 0, maximum: 1, description: "X." } },
          },
        },
        options: {
          type: "object",
          properties: { depth: { type: "integer", default: 2, description: "Depth." } },
        },
      },
    });
    expect(result).toEqual({
      properties: {
        events: {
          type: "array",
          items: {
            type: "object",
            properties: {
              x: { type: "number", minimum: 0, maximum: 1, description: "X. Range: 0 to 1." },
            },
          },
        },
        options: {
          type: "object",
          properties: { depth: { type: "integer", default: 2, description: "Depth. Default: 2." } },
        },
      },
    });
  });

  it("is idempotent", () => {
    const schema = {
      properties: { p: { type: "integer", default: 20, exclusiveMinimum: 0, description: "N." } },
    };
    const once = withKeywordFacts(schema);
    expect(withKeywordFacts(once)).toEqual(once);
  });

  it("does not mutate its input", () => {
    const schema = { properties: { p: { type: "integer", default: 1, description: "N." } } };
    const copy = structuredClone(schema);
    withKeywordFacts(schema);
    expect(schema).toEqual(copy);
  });
});

describe("withKeywordFacts — leaves out what is already said or carries nothing", () => {
  it.each([
    ["(default 300)", { default: 300 }],
    ["Defaults to true.", { default: true }],
    ["Default true. Set false to skip.", { default: true }],
    ["TCP port (8081 by default)", { default: 8081 }],
    ["Cap in seconds (default 180, max 600).", { maximum: 600 }],
    ["Duration in ms (at most 10000).", { maximum: 10000 }],
    ["At least 50 ms between polls.", { minimum: 50 }],
    ["A positive count.", { exclusiveMinimum: 0 }],
    ['Page index or "latest" for the newest page.', { anyOf: [{ const: "latest" }] }],
    ["When true (default), only visible components.", { default: true }],
    ["Normalized x 0.0–1.0, not pixels.", { minimum: 0, maximum: 1 }],
    ["Scale factor (0.01-1.0).", { minimum: 0.01, maximum: 1 }],
    ["Hinge angle, 0 (closed) to 180 (open).", { minimum: 0, maximum: 180 }],
  ])("skips a fact the description states: %s", (description, keywords) => {
    expect(describeProp({ description, ...keywords })).toBe(description);
  });

  it("matches the value as a whole token", () => {
    expect(describeProp({ default: 20, description: "Rows (default 200)." })).toBe(
      "Rows (default 200). Default: 20."
    );
  });

  it("does not read a range out of an unrelated decimal", () => {
    expect(describeProp({ minimum: 0, maximum: 1, description: "Scale 0.25-0.5 works." })).toBe(
      "Scale 0.25-0.5 works. Range: 0 to 1."
    );
  });

  it("ignores the ±MAX_SAFE_INTEGER bounds that zod's .int() emits", () => {
    const prop = {
      type: "integer",
      minimum: -9007199254740991,
      maximum: 9007199254740991,
      description: "Offset.",
    };
    expect(describeProp(prop)).toBe("Offset.");
  });

  it("leaves out patterns, enums and trivial minimums of 1", () => {
    expect(
      describeProp({
        type: "string",
        pattern: "^[a-z]+$",
        minLength: 1,
        enum: ["a", "b"],
        description: "Id.",
      })
    ).toBe("Id.");
    expect(describeProp({ type: "array", minItems: 1, description: "Steps." })).toBe("Steps.");
  });

  it("returns a schema without properties unchanged", () => {
    const schema = { type: "object" };
    expect(withKeywordFacts(schema)).toBe(schema);
  });
});

describe("showsSchemaKeywords — the clients that skip the facts", () => {
  // The names each client sent in a captured handshake, or names in its shipped source.
  it.each(["claude-code", "gemini-cli-mcp-client", "Zed", "kiro", "Q DEV CLI", "copilot-cli"])(
    "is true for %s",
    (name) => {
      expect(showsSchemaKeywords(name)).toBe(true);
    }
  );

  it.each([
    "codex-mcp-client",
    "opencode",
    "Visual Studio Code",
    "cursor-vscode",
    "cursor",
    "rmcp",
    "mcp",
    "some-new-client",
    "",
    undefined,
  ])("is false for %s", (name) => {
    expect(showsSchemaKeywords(name)).toBe(false);
  });
});
