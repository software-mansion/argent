/**
 * The published JSON Schema and the zod schemas state one frozen contract
 * twice, kept in step by hand. This is what makes "by hand" survivable: adding
 * a field to one and forgetting the other fails here rather than in a third
 * party's CI six weeks later.
 *
 * It compares structure, which fields exist, which are required and the closed
 * vocabularies; not every length and range bound. Matching those would mean
 * reimplementing a JSON Schema compiler against zod's internals, for a small
 * payoff and a large false-failure rate on the next zod upgrade.
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import type { z } from "zod";
import {
  EXTERNAL_CAPABILITIES,
  PROVIDER_ID_SHAPE,
  PROVIDER_SCHEMA_VERSION,
  providerDeviceSchema,
  providerRecordSchema,
} from "../src/index.js";

type JsonSchemaNode = {
  $ref?: string;
  anyOf?: JsonSchemaNode[];
  const?: unknown;
  enum?: string[];
  pattern?: string;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
};

const document = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../schemas/device-provider-v1.json"), "utf8")
) as { $defs: Record<string, JsonSchemaNode> };

/** Field names a JSON Schema object node declares, sorted. */
function jsonFields(node: JsonSchemaNode): string[] {
  return Object.keys(node.properties ?? {}).sort();
}

/** Field names a JSON Schema object node marks required, sorted. */
function jsonRequired(node: JsonSchemaNode): string[] {
  return [...(node.required ?? [])].sort();
}

type AnyShape = Record<string, z.ZodType>;

function shapeOf(schema: unknown): AnyShape {
  const shape = (schema as { shape?: AnyShape }).shape;
  if (!shape) throw new Error("expected a zod object schema");
  return shape;
}

/** Peel `.optional()` / `.nullable()` off to reach the object inside. */
function unwrap(schema: z.ZodType): z.ZodType {
  let current = schema;
  while (typeof (current as { unwrap?: () => z.ZodType }).unwrap === "function") {
    current = (current as unknown as { unwrap: () => z.ZodType }).unwrap();
  }
  return current;
}

/** Field names a zod object declares, sorted. */
function zodFields(schema: unknown): string[] {
  return Object.keys(shapeOf(schema)).sort();
}

/** Required field names, sorted. Optional means it accepts `undefined`. */
function zodRequired(schema: unknown): string[] {
  return Object.entries(shapeOf(schema))
    .filter(([, field]) => !field.safeParse(undefined).success)
    .map(([name]) => name)
    .sort();
}

describe("provider record", () => {
  const node = document.$defs.providerRecord!;

  it("declares the same fields as the zod schema", () => {
    expect(jsonFields(node)).toEqual(zodFields(providerRecordSchema));
  });

  it("requires the same fields as the zod schema", () => {
    expect(jsonRequired(node)).toEqual(zodRequired(providerRecordSchema));
  });

  it("pins the same schema version", () => {
    expect(node.properties!.schemaVersion!.const).toBe(PROVIDER_SCHEMA_VERSION);
  });

  it("constrains the provider id with the same pattern", () => {
    expect(document.$defs.providerId!.pattern).toBe(PROVIDER_ID_SHAPE.source);
  });

  it("agrees on the workspace sub-object", () => {
    const workspace = unwrap(shapeOf(providerRecordSchema).workspace!);
    expect(jsonFields(node.properties!.workspace!)).toEqual(zodFields(workspace));
    expect(jsonRequired(node.properties!.workspace!)).toEqual(zodRequired(workspace));
  });
});

describe("provider device", () => {
  const node = document.$defs.providerDevice!;

  it("declares the same fields as the zod schema", () => {
    expect(jsonFields(node)).toEqual(zodFields(providerDeviceSchema));
  });

  it("requires the same fields as the zod schema", () => {
    expect(jsonRequired(node)).toEqual(zodRequired(providerDeviceSchema));
  });

  it.each(["simulatorServer", "jsDebugger", "nativeDevtools"])(
    "agrees on the %s sub-object",
    (field) => {
      const zodField = unwrap(shapeOf(providerDeviceSchema)[field]!);
      expect(jsonFields(node.properties![field]!)).toEqual(zodFields(zodField));
      expect(jsonRequired(node.properties![field]!)).toEqual(zodRequired(zodField));
    }
  );

  /** Compared as sets: enum order is not part of either schema's meaning. */
  it.each([
    ["platform", ["android", "ios"]],
    ["kind", ["device", "emulator", "simulator"]],
  ])("closes the %s vocabulary the same way", (field, expected) => {
    const zodField = unwrap(shapeOf(providerDeviceSchema)[field as string]!);
    expect([...node.properties![field as string]!.enum!].sort()).toEqual(expected);
    for (const value of expected as string[]) {
      expect(zodField.safeParse(value).success).toBe(true);
    }
    expect(zodField.safeParse("windows-phone").success).toBe(false);
  });

  /**
   * An unknown token must validate, so a provider can declare a capability from
   * a newer Argent. The enum branch documents rather than constrains, but it
   * must still name exactly what argent honours.
   */
  it("lists exactly the capability tokens argent honours", () => {
    const branches = document.$defs.capability!.anyOf!;
    const enumerated = branches.find((branch) => branch.enum)!.enum!;

    expect([...enumerated].sort()).toEqual([...EXTERNAL_CAPABILITIES].sort());
    expect(branches.some((branch) => !branch.enum)).toBe(true);
  });
});
