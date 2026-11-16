import { describe, it, expect, expectTypeOf } from "vitest";
import { z } from "zod";
import type { ZodIssueCode } from "@argent/telemetry";
import { deriveInvalidParams, deriveInvalidParamIssues } from "../../src/utils/invalid-params";

function issuesFor(schema: z.ZodType, input: unknown): z.ZodError {
  const res = schema.safeParse(input);
  if (res.success) throw new Error("expected the input to fail validation");
  return res.error;
}

describe("deriveInvalidParams", () => {
  const declared = new Set(["port", "device_id", "steps", "count"]);

  it("reports the top-level declared name for a simple type failure", () => {
    const err = issuesFor(z.object({ count: z.number() }), { count: "nope" });
    expect(deriveInvalidParams(err, declared)).toEqual(["count"]);
  });

  it("collapses a nested path to its top-level declared name, once", () => {
    const schema = z.object({
      steps: z.array(z.object({ tool: z.string(), args: z.object({ x: z.number() }) })),
    });
    const err = issuesFor(schema, {
      steps: [
        { tool: 1, args: { x: "bad" } },
        { tool: 2, args: {} },
      ],
    });
    // Multiple issues under steps[0].tool / steps[0].args.x / steps[1].tool —
    // all collapse to the single declared name "steps", deduped.
    expect(deriveInvalidParams(err, declared)).toEqual(["steps"]);
  });

  it("reports the literal token for unrecognized_keys — never the user-typed key names", () => {
    const schema = z.object({ port: z.number() }).strict();
    const err = issuesFor(schema, { port: 1, ssn: "123-45-6789", passwd: "hunter2" });
    const out = deriveInvalidParams(err, declared);
    expect(out).toEqual(["unrecognized_keys"]);
    expect(out.join(",")).not.toMatch(/ssn|passwd/);
  });

  it("dedups repeated names across issues", () => {
    const schema = z.object({ port: z.number(), device_id: z.string() });
    const err = issuesFor(schema, { port: "a", device_id: 5 });
    const out = deriveInvalidParams(err, declared);
    expect(out.sort()).toEqual(["device_id", "port"]);
    expect(new Set(out).size).toBe(out.length);
  });

  it("filters names that are not schema-declared (defense in depth against key leakage)", () => {
    // Forge a ZodError whose issue path names an undeclared key — must be
    // dropped so only Argent's own schema vocabulary can reach telemetry.
    const forged = new z.ZodError([
      {
        code: "invalid_type",
        expected: "string",
        path: ["users_home_dir"],
        message: "x",
      } as unknown as z.core.$ZodIssue,
      {
        code: "invalid_type",
        expected: "number",
        path: ["port"],
        message: "x",
      } as unknown as z.core.$ZodIssue,
    ]);
    expect(deriveInvalidParams(forged, declared)).toEqual(["port"]);
  });

  it("drops issues with an empty path", () => {
    const forged = new z.ZodError([
      {
        code: "custom",
        path: [],
        message: "whole-object refinement",
      } as unknown as z.core.$ZodIssue,
    ]);
    expect(deriveInvalidParams(forged, declared)).toEqual([]);
  });

  it("caps at 16 names (the sanitize arrayOf validator voids longer arrays wholesale)", () => {
    const names = Array.from({ length: 20 }, (_, i) => `p${i}`);
    const bigDeclared = new Set(names);
    const forged = new z.ZodError(
      names.map(
        (name) =>
          ({
            code: "invalid_type",
            expected: "string",
            path: [name],
            message: "x",
          }) as unknown as z.core.$ZodIssue
      )
    );
    const out = deriveInvalidParams(forged, bigDeclared);
    expect(out).toHaveLength(16);
    expect(out).toEqual(names.slice(0, 16));
  });
});

describe("deriveInvalidParamIssues", () => {
  const codesFor = (schema: z.ZodType, input: unknown) =>
    deriveInvalidParamIssues(issuesFor(schema, input), input);

  // await-ui-element's timeoutMs schema.
  const timeoutMs = z.object({ timeoutMs: z.number().int().positive().max(120_000) });

  it("separates a value over the bound from a value of the wrong type", () => {
    expect(codesFor(timeoutMs, { timeoutMs: 300_000 })).toEqual(["too_big"]);
    expect(codesFor(timeoutMs, { timeoutMs: "5000" })).toEqual(["invalid_type"]);
    expect(codesFor(timeoutMs, { timeoutMs: 0 })).toEqual(["too_small"]);
  });

  it("dedupes repeats but keeps distinct codes, in one order whatever the input", () => {
    const schema = z.object({ a: z.number().max(5), b: z.number().max(5), c: z.string() });
    expect(codesFor(schema, { a: 9, b: 9, c: 1 })).toEqual(["invalid_type", "too_big"]);
    expect(codesFor(schema, { a: "x", b: 9, c: "ok" })).toEqual(["invalid_type", "too_big"]);
  });

  it("reports a field the call left out as missing, not as zod's code for it", () => {
    const schema = z.object({ udid: z.string(), condition: z.enum(["exists", "visible"]) });
    expect(codesFor(schema, {})).toEqual(["missing"]);
    expect(codesFor(schema, { udid: 1 })).toEqual(["invalid_type", "missing"]);
    expect(codesFor(schema, { udid: "x", condition: "bogus" })).toEqual(["invalid_value"]);
    // A union left out reads missing, not as its branches' codes.
    const union = z.object({ button: z.union([z.enum(["up"]), z.array(z.enum(["up"]))]) });
    expect(codesFor(union, {})).toEqual(["missing"]);
  });

  it("keeps an author's custom issue on an omitted field as custom", () => {
    const schema = z
      .object({ condition: z.enum(["text", "exists"]), expectedText: z.string().optional() })
      .superRefine((v, ctx) => {
        if (v.condition === "text" && v.expectedText === undefined)
          ctx.addIssue({ code: "custom", path: ["expectedText"], message: "required for text" });
      });
    expect(codesFor(schema, { condition: "text" })).toEqual(["custom"]);
  });

  it("reports unrecognized_keys without carrying the user-typed key names", () => {
    const schema = z.object({ port: z.number() }).strict();
    const out = codesFor(schema, { port: 1, ssn: "123-45-6789" });
    expect(out).toEqual(["unrecognized_keys"]);
    expect(JSON.stringify(out)).not.toMatch(/ssn|123-45/);
  });

  it("skips the union branches that rejected the value's type with invalid_type", () => {
    // tv-remote's button schema.
    const buttons = ["up", "down"] as const;
    const schema = z.object({
      button: z.union([z.enum(buttons), z.array(z.enum(buttons)).min(1).max(64)]),
    });
    for (const button of ["bogus", "", ["up", "bogus"]]) {
      expect(codesFor(schema, { button })).toEqual(["invalid_union", "invalid_value"]);
    }
    // An object branch with a wrongly typed field did not reject the value's type.
    const mixed = z.object({ v: z.union([z.object({ a: z.number() }), z.enum(["x"])]) });
    expect(codesFor(mixed, { v: { a: "s" } })).toEqual([
      "invalid_type",
      "invalid_union",
      "invalid_value",
    ]);
  });

  it("keeps a union branch that rejected a non-integer number", () => {
    // view-network-logs' pageIndex schema.
    const schema = z.object({
      pageIndex: z.union([z.coerce.number().int().nonnegative(), z.literal("latest")]),
    });
    expect(codesFor(schema, { pageIndex: 1.5 })).toEqual([
      "invalid_type",
      "invalid_union",
      "invalid_value",
    ]);
    expect(codesFor(schema, { pageIndex: "abc" })).toEqual(["invalid_union", "invalid_value"]);
  });

  it("reports invalid_type when every union branch rejected the value's type", () => {
    const schema = z.object({ tag: z.union([z.string(), z.array(z.string())]) });
    expect(codesFor(schema, { tag: 7 })).toEqual(["invalid_type", "invalid_union"]);
  });

  it("reports only invalid_union when the union lists no branch errors", () => {
    const schema = z.object({
      g: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("a") }),
        z.object({ kind: z.literal("b") }),
      ]),
    });
    expect(codesFor(schema, { g: { kind: "c" } })).toEqual(["invalid_union"]);
  });

  it("reports the codes of a union nested in a union branch", () => {
    const schema = z.union([
      z.object({ k: z.literal("x"), a: z.union([z.number(), z.boolean()]) }),
      z.object({ k: z.literal("y") }),
    ]);
    expect(codesFor(schema, { k: "z", a: "s" })).toEqual([
      "invalid_type",
      "invalid_union",
      "invalid_value",
    ]);
  });

  it("knows exactly the issue codes the installed zod can raise", () => {
    expectTypeOf<ZodIssueCode>().toEqualTypeOf<z.core.$ZodIssueCode>();
  });

  it("drops a code outside zod's vocabulary rather than voiding the whole array", () => {
    const err = issuesFor(z.object({ a: z.number() }), { a: "x" });
    const forged = {
      issues: [{ code: "brand_new_zod_code", path: ["a"] }, ...err.issues],
    } as unknown as z.ZodError;
    expect(deriveInvalidParamIssues(forged, { a: "x" })).toEqual(["invalid_type"]);
  });
});
