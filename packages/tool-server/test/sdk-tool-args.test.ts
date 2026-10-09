import { describe, expect, it } from "vitest";
import ts from "typescript";
import { renderSdkToolArgs, toType } from "../src/sdk-tool-args";
import { EXPECTED_TOOL_COUNT } from "./helpers/catalog";

describe("toType", () => {
  it("maps scalars, literals and arrays", () => {
    expect(toType({ type: "string" })).toBe("string");
    expect(toType({ type: "integer" })).toBe("number");
    expect(toType({ type: ["string", "null"] })).toBe("string | null");
    expect(toType({ const: "a" })).toBe('"a"');
    expect(toType({ enum: ["a", 1] })).toBe('"a" | 1');
    expect(toType({ type: "array", items: { type: "boolean" } })).toBe("Array<boolean>");
    expect(toType({ description: "anything" })).toBe("unknown");
  });

  it("parenthesizes allOf members so a union keeps its precedence", () => {
    const schema = {
      allOf: [{ anyOf: [{ type: "string" }, { type: "number" }] }, { enum: ["a", 1] }],
    };
    expect(toType(schema)).toBe('(string | number) & ("a" | 1)');
  });

  it("renders objects with optional members, docs and an index signature", () => {
    const schema = {
      type: "object",
      properties: {
        "udid": { type: "string", description: "Device id. Ends */ here" },
        "flag-name": { type: "boolean" },
      },
      required: ["udid"],
      additionalProperties: { type: "number" },
    };
    expect(toType(schema)).toBe(
      [
        "{",
        "  /** Device id. Ends *\\/ here */",
        "  udid: string;",
        '  "flag-name"?: boolean;',
        "  [key: string]: number;",
        "}",
      ].join("\n")
    );
    expect(toType({ type: "object", properties: {} })).toBe("Record<string, never>");
  });

  it("throws on a schema it cannot map instead of widening to unknown", () => {
    expect(() => toType({ type: "array" })).toThrow(/No TypeScript mapping/);
    expect(() => toType({ $ref: "#/x" })).toThrow(/No TypeScript mapping/);
  });
});

describe("renderSdkToolArgs", () => {
  const output = renderSdkToolArgs();

  it("emits every tool", () => {
    expect(output.match(/^ {2}("[^"]+"|\w+): /gm)).toHaveLength(EXPECTED_TOOL_COUNT);
  });

  it("emits valid TypeScript", () => {
    const { diagnostics } = ts.transpileModule(output, { reportDiagnostics: true });
    expect(diagnostics).toEqual([]);
  });
});
