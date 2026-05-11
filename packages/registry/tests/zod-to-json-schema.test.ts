import { describe, it, expect } from "vitest";
import { z } from "zod";
import { zodObjectToJsonSchema } from "../src/zod-to-json-schema";

describe("zodObjectToJsonSchema — description extraction", () => {
  it("emits description from .describe() on primitives", () => {
    const schema = zodObjectToJsonSchema(
      z.object({
        name: z.string().describe("The user's name"),
      })
    );
    expect(schema).toEqual({
      type: "object",
      properties: {
        name: { type: "string", description: "The user's name" },
      },
      required: ["name"],
    });
  });

  it("emits description from .describe() when chained after .default()", () => {
    const schema = zodObjectToJsonSchema(
      z.object({
        port: z.number().default(8081).describe("Metro server port"),
      })
    );
    expect(schema.properties).toEqual({
      port: { type: "number", default: 8081, description: "Metro server port" },
    });
  });

  it("emits description from .describe() after .optional()", () => {
    const schema = zodObjectToJsonSchema(
      z.object({
        nickname: z.string().optional().describe("Optional nickname"),
      })
    );
    expect(schema.properties).toEqual({
      nickname: { type: "string", description: "Optional nickname" },
    });
  });
});

describe("zodObjectToJsonSchema — ZodDefault support", () => {
  it("emits default value and unwraps base type", () => {
    const schema = zodObjectToJsonSchema(
      z.object({
        count: z.number().default(10),
      })
    );
    expect(schema.properties).toEqual({
      count: { type: "number", default: 10 },
    });
  });

  it("handles z.coerce.number().default(X) — the common Metro-port pattern", () => {
    const schema = zodObjectToJsonSchema(
      z.object({
        port: z.coerce.number().default(8081),
      })
    );
    expect(schema.properties).toEqual({
      port: { type: "number", default: 8081 },
    });
  });

  it("handles boolean defaults", () => {
    const schema = zodObjectToJsonSchema(
      z.object({
        verbose: z.boolean().default(false),
      })
    );
    expect(schema.properties).toEqual({
      verbose: { type: "boolean", default: false },
    });
  });

  it("handles string defaults (including z.coerce.string)", () => {
    const schema = zodObjectToJsonSchema(
      z.object({
        rn_version: z.coerce.string().default("unknown"),
      })
    );
    expect(schema.properties).toEqual({
      rn_version: { type: "string", default: "unknown" },
    });
  });

  it("handles enum defaults", () => {
    const schema = zodObjectToJsonSchema(
      z.object({
        platform: z.enum(["ios", "android"]).default("ios"),
      })
    );
    expect(schema.properties).toEqual({
      platform: { type: "string", enum: ["ios", "android"], default: "ios" },
    });
  });

  it("does NOT mark defaulted fields as required", () => {
    const schema = zodObjectToJsonSchema(
      z.object({
        port: z.number().default(8081),
        host: z.string(),
      })
    );
    expect(schema.required).toEqual(["host"]);
  });

  it("handles ZodDefault wrapping ZodOptional", () => {
    const schema = zodObjectToJsonSchema(
      z.object({
        clear: z.boolean().optional().default(false),
      })
    );
    expect(schema.properties).toEqual({
      clear: { type: "boolean", default: false },
    });
    // Not required (both default and optional make it so).
    expect(schema.required).toBeUndefined();
  });
});

describe("zodObjectToJsonSchema — ZodLiteral and ZodUnion", () => {
  it("emits const for string literal", () => {
    const schema = zodObjectToJsonSchema(
      z.object({
        mode: z.literal("latest"),
      })
    );
    expect(schema.properties).toEqual({
      mode: { const: "latest" },
    });
  });

  it("emits anyOf for z.union", () => {
    const schema = zodObjectToJsonSchema(
      z.object({
        after: z.union([z.number().int().nonnegative(), z.literal("latest")]),
      })
    );
    expect(schema.properties).toEqual({
      after: {
        anyOf: [{ type: "number" }, { const: "latest" }],
      },
    });
  });

  it("emits default for a union wrapped in ZodDefault", () => {
    const schema = zodObjectToJsonSchema(
      z.object({
        after: z.union([z.number(), z.literal("latest")]).default("latest"),
      })
    );
    expect(schema.properties).toEqual({
      after: {
        anyOf: [{ type: "number" }, { const: "latest" }],
        default: "latest",
      },
    });
  });
});

describe("zodObjectToJsonSchema — ZodNullable", () => {
  it("passes through base-type schema for nullable fields", () => {
    const schema = zodObjectToJsonSchema(
      z.object({
        maybeName: z.string().nullable(),
      })
    );
    expect(schema.properties).toEqual({
      maybeName: { type: "string" },
    });
  });
});

describe("zodObjectToJsonSchema — combined realistic shape", () => {
  it("emits a full, useful schema for a typical tool", () => {
    const toolSchema = z.object({
      port: z.coerce.number().default(8081).describe("Metro server port"),
      device_id: z.string().describe("Device logicalDeviceId"),
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      maxItems: z.coerce.number().default(35).describe("Max items"),
      includeSkipped: z.boolean().default(false).describe("Include skipped"),
    });
    const schema = zodObjectToJsonSchema(toolSchema);

    expect(schema.properties).toEqual({
      port: { type: "number", default: 8081, description: "Metro server port" },
      device_id: { type: "string", description: "Device logicalDeviceId" },
      x: { type: "number", description: "X coordinate" },
      y: { type: "number", description: "Y coordinate" },
      maxItems: { type: "number", default: 35, description: "Max items" },
      includeSkipped: { type: "boolean", default: false, description: "Include skipped" },
    });
    // Only non-defaulted fields are required.
    expect(schema.required).toEqual(["device_id", "x", "y"]);
  });
});

describe("zodObjectToJsonSchema — backward-compatible basics", () => {
  it("still emits required[] for plain required fields", () => {
    const schema = zodObjectToJsonSchema(
      z.object({
        a: z.string(),
        b: z.number(),
      })
    );
    expect(schema.required).toEqual(["a", "b"]);
  });

  it("still handles ZodArray of primitives", () => {
    const schema = zodObjectToJsonSchema(
      z.object({
        tags: z.array(z.string()),
      })
    );
    expect(schema.properties).toEqual({
      tags: { type: "array", items: { type: "string" } },
    });
  });

  it("still handles nested ZodObject", () => {
    const schema = zodObjectToJsonSchema(
      z.object({
        point: z.object({ x: z.number(), y: z.number() }),
      })
    );
    expect(schema.properties).toEqual({
      point: {
        type: "object",
        properties: { x: { type: "number" }, y: { type: "number" } },
        required: ["x", "y"],
      },
    });
  });
});
