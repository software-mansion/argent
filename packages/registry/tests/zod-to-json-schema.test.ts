import { describe, it, expect } from "vitest";
import { z } from "zod";
import { zodObjectToJsonSchema } from "../src/zod-to-json-schema";

describe("zodObjectToJsonSchema", () => {
  it("emits number type and marks field required for z.number()", () => {
    const schema = zodObjectToJsonSchema(z.object({ value: z.number() }));
    expect((schema.properties as any).value).toEqual({ type: "number" });
    expect(schema.required).toEqual(["value"]);
  });

  it("emits boolean type and marks field required for z.boolean()", () => {
    const schema = zodObjectToJsonSchema(z.object({ value: z.boolean() }));
    expect((schema.properties as any).value).toEqual({ type: "boolean" });
    expect(schema.required).toEqual(["value"]);
  });

  it("emits string type and omits optional field from required", () => {
    const schema = zodObjectToJsonSchema(z.object({ value: z.string().optional() }));
    expect((schema.properties as any).value).toEqual({ type: "string" });
    expect(schema.required).toBeUndefined();
  });

  it("emits number type with default and omits defaulted field from required", () => {
    const schema = zodObjectToJsonSchema(z.object({ port: z.number().default(8081) }));
    expect((schema.properties as any).port).toEqual({ type: "number", default: 8081 });
    expect(schema.required).toBeUndefined();
  });

  it("emits boolean type with default and omits defaulted field from required", () => {
    const schema = zodObjectToJsonSchema(z.object({ force: z.boolean().default(false) }));
    expect((schema.properties as any).force).toEqual({ type: "boolean", default: false });
    expect(schema.required).toBeUndefined();
  });

  it("emits number type for z.coerce.number().int().positive().default(100)", () => {
    const schema = zodObjectToJsonSchema(
      z.object({ sample_interval_us: z.coerce.number().int().positive().default(100) }),
    );
    expect((schema.properties as any).sample_interval_us).toEqual({ type: "number", default: 100 });
    expect(schema.required).toBeUndefined();
  });

  it("produces expected JSON Schema for a mixed object with required/optional/default fields", () => {
    const schema = zodObjectToJsonSchema(
      z.object({
        name: z.string(),
        port: z.number().default(8081),
        force: z.boolean().default(false),
        label: z.string().optional(),
      }),
    );
    expect(schema).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        port: { type: "number", default: 8081 },
        force: { type: "boolean", default: false },
        label: { type: "string" },
      },
      required: ["name"],
    });
  });
});
