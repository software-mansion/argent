import { describe, it, expect } from "vitest";
import { z } from "zod";
import { deriveInvalidParams } from "../../src/utils/invalid-params";

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
